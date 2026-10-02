/**
 * Config loading, defaulting, and validation.
 *
 * The JSON Schema files in ../schemas exist so editors can autocomplete and
 * flag mistakes while a human edits these files. Validation at runtime is
 * hand-written rather than schema-driven on purpose: a schema validator says
 * `must match pattern ^[a-z]...`, and a person staring at a broken config needs
 * to be told which key is wrong and what to do about it. It also keeps the
 * package free of a validator dependency.
 *
 * Every path in the returned object is absolute.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { isKnownRule, RULES } from './rules.mjs'

export const CONFIG_FILENAME = 'i18n/config.json'

/** Ratio of source display width a translation may reach before TEXT_EXPANSION warns. */
const DEFAULT_EXPANSION_BUDGET = {
  10: 3.0,
  20: 2.0,
  30: 1.8,
  50: 1.6,
  70: 1.4,
  rest: 1.3,
}

const DEFAULT_PATHS = {
  source: 'i18n/source',
  translations: 'i18n/translations',
  glossary: 'i18n/glossary.json',
  style: 'i18n/style.md',
  audit: 'i18n/audit.log',
  out: 'build/i18n',
}

const KNOWN_ADAPTERS = new Set(['web', 'chrome', 'android', 'apple'])

class ConfigError extends Error {
  constructor(message, { hint } = {}) {
    super(hint ? `${message}\n  ${hint}` : message)
    this.name = 'ConfigError'
    this.hint = hint
  }
}

export { ConfigError }

/**
 * Load and validate config from a project root.
 *
 * @param {string} root  project root directory
 * @param {{ configPath?: string }} [opts]
 */
export function loadConfig(root, { configPath } = {}) {
  const file = configPath
    ? isAbsolute(configPath)
      ? configPath
      : resolve(root, configPath)
    : resolve(root, CONFIG_FILENAME)

  if (!existsSync(file)) {
    throw new ConfigError(`No config found at ${file}`, {
      hint: 'Run `i18n init` to create one.',
    })
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`)
  }

  return resolveConfig(raw, { root, file })
}

/**
 * Apply defaults and validate. Exported separately from `loadConfig` so tests
 * can exercise validation without touching the filesystem.
 */
export function resolveConfig(raw, { root = process.cwd(), file = '<inline>' } = {}) {
  if (raw.schemaVersion !== 1) {
    throw new ConfigError(
      `${file}: schemaVersion must be 1, got ${JSON.stringify(raw.schemaVersion)}`,
    )
  }

  const sourceLocale = requireString(raw, 'sourceLocale', file)

  // Both lists may be empty. A project that has authored its source strings but
  // not yet committed to a target language is a real and common state, and
  // `check` still has plenty to say about the source alone.
  const required = raw.locales?.required ?? []
  const optional = raw.locales?.optional ?? []

  if (!Array.isArray(required)) throw new ConfigError(`${file}: locales.required must be an array`)
  if (!Array.isArray(optional)) throw new ConfigError(`${file}: locales.optional must be an array`)

  const dupes = required.filter((l) => optional.includes(l))
  if (dupes.length) {
    throw new ConfigError(
      `${file}: ${dupes.join(', ')} listed as both required and optional`,
      { hint: 'A locale is one or the other. Required fails check when a string is missing; optional warns and falls back.' },
    )
  }

  if (required.includes(sourceLocale) || optional.includes(sourceLocale)) {
    throw new ConfigError(
      `${file}: the source locale "${sourceLocale}" must not appear in locales.required or locales.optional`,
      { hint: 'Source strings live in the source catalog. Only target locales are listed here.' },
    )
  }

  const targetLocales = [...required, ...optional]
  const knownLocales = new Set([sourceLocale, ...targetLocales])

  const fallback = resolveFallback(raw.fallback ?? {}, { knownLocales, sourceLocale, targetLocales, file })
  const paths = resolvePaths(raw.paths ?? {}, root)
  const targets = resolveTargets(raw.targets ?? {}, { knownLocales, file })
  const severity = validateSeverity(raw.severity ?? {}, file)

  const policy = {
    defaultClass: raw.policy?.defaultClass ?? 'ui',
    zeroCase: raw.policy?.zeroCase ?? 'separate-key',
    placeholderExamples: raw.policy?.placeholderExamples ?? 'optional',
    expansionBudget: { ...DEFAULT_EXPANSION_BUDGET, ...(raw.policy?.expansionBudget ?? {}) },
    localeExpansionOverride: raw.policy?.localeExpansionOverride ?? {},
  }

  return {
    schemaVersion: 1,
    root: resolve(root),
    configFile: file,
    sourceLocale,
    locales: { required, optional, all: targetLocales },
    fallback,
    paths,
    targets,
    generated: { committed: raw.generated?.committed ?? false },
    policy,
    severity,
    // Read only by @i18n-kit/translate. Core never touches it, which is what
    // keeps `check` free of any network concern.
    provider: raw.provider ?? null,

    // --- derived helpers ---------------------------------------------------

    /** Every locale that must or may be translated. */
    targetLocales() {
      return targetLocales
    },
    isRequired(locale) {
      return required.includes(locale)
    },
    /** Ordered chain ending at the source locale. */
    fallbackChain(locale) {
      return fallback[locale] ?? [locale, sourceLocale]
    },
    enabledTargets() {
      return Object.entries(targets).filter(([, t]) => t.enabled)
    },
    /** Targets a given message belongs to, honouring its `targets` field. */
    targetsForMessage(message) {
      const names = message?.targets
      return this.enabledTargets().filter(([name]) => !names || names.includes(name))
    },
    /** Expansion ratio allowed for a source string of the given display width. */
    expansionBudgetFor(sourceWidth, locale) {
      const bucket =
        [10, 20, 30, 50, 70].find((b) => sourceWidth <= b) ?? 'rest'
      const base = policy.expansionBudget[bucket] ?? DEFAULT_EXPANSION_BUDGET.rest
      return base * (policy.localeExpansionOverride[locale] ?? 1)
    },
  }
}

function resolveFallback(raw, { knownLocales, sourceLocale, targetLocales, file }) {
  const out = {}

  for (const [locale, chain] of Object.entries(raw)) {
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new ConfigError(`${file}: fallback["${locale}"] must be a non-empty array`)
    }
    if (!knownLocales.has(locale)) {
      throw new ConfigError(`${file}: fallback declares "${locale}", which is not a configured locale`)
    }
    for (const step of chain) {
      if (!knownLocales.has(step)) {
        throw new ConfigError(
          `${file}: fallback["${locale}"] refers to "${step}", which is not a configured locale`,
          { hint: 'Every step in a chain must be the source locale or one of locales.required / locales.optional.' },
        )
      }
    }
    if (chain[0] !== locale) {
      throw new ConfigError(`${file}: fallback["${locale}"] must start with "${locale}"`)
    }
    if (chain.at(-1) !== sourceLocale) {
      throw new ConfigError(
        `${file}: fallback["${locale}"] must end at the source locale "${sourceLocale}"`,
        { hint: 'Otherwise a missing string has nowhere to land and renders as its key.' },
      )
    }
    out[locale] = chain
  }

  // Anything undeclared falls straight back to source. Stated explicitly rather
  // than inferred: whether pt-BR falls back to pt is a project decision.
  for (const locale of targetLocales) {
    if (!out[locale]) out[locale] = [locale, sourceLocale]
  }

  return out
}

function resolvePaths(raw, root) {
  const merged = { ...DEFAULT_PATHS, ...raw }
  const out = {}
  for (const [key, value] of Object.entries(merged)) {
    out[key] = isAbsolute(value) ? value : resolve(root, value)
  }
  return out
}

function resolveTargets(raw, { knownLocales, file }) {
  const out = {}

  for (const [name, target] of Object.entries(raw)) {
    if (!target || typeof target !== 'object') {
      throw new ConfigError(`${file}: targets.${name} must be an object`)
    }
    if (!KNOWN_ADAPTERS.has(target.adapter)) {
      throw new ConfigError(
        `${file}: targets.${name}.adapter is "${target.adapter}"`,
        { hint: `Known adapters: ${[...KNOWN_ADAPTERS].join(', ')}.` },
      )
    }

    const localeMap = target.localeMap ?? {}
    for (const locale of Object.keys(localeMap)) {
      if (!knownLocales.has(locale)) {
        throw new ConfigError(
          `${file}: targets.${name}.localeMap maps "${locale}", which is not a configured locale`,
        )
      }
    }

    // Android's legacy mode predates script subtags entirely, so pairing it
    // with one is a config error rather than a silent truncation at export.
    if (target.adapter === 'android' && target.options?.localeFormat === 'legacy') {
      const withScript = [...knownLocales].filter((l) => l.split('-').length > 1 && /^[A-Z][a-z]{3}$/.test(l.split('-')[1]))
      if (withScript.length) {
        throw new ConfigError(
          `${file}: targets.${name} uses localeFormat "legacy", which cannot express the script subtag in ${withScript.join(', ')}`,
          { hint: 'Use localeFormat "bcp47" (requires minSdk 24), or drop the script subtag from those locales.' },
        )
      }
    }

    out[name] = {
      name,
      adapter: target.adapter,
      enabled: target.enabled ?? true,
      out: target.out ?? null,
      localeMap,
      options: target.options ?? {},
    }
  }

  return out
}

function validateSeverity(raw, file) {
  const out = {}
  for (const [code, value] of Object.entries(raw)) {
    if (!isKnownRule(code)) {
      throw new ConfigError(`${file}: severity."${code}" is not a known rule code`, {
        hint: 'Run `i18n check --list-rules` to see every rule.',
      })
    }
    if (!['error', 'warn', 'info', 'off'].includes(value)) {
      throw new ConfigError(
        `${file}: severity."${code}" must be error, warn, info, or off (got ${JSON.stringify(value)})`,
      )
    }
    if (RULES[code].severity === 'error' && value !== 'error') {
      throw new ConfigError(
        `${file}: severity."${code}" cannot be lowered to "${value}"`,
        { hint: `${code} is an error because it ${RULES[code].desc.charAt(0).toLowerCase()}${RULES[code].desc.slice(1)}` },
      )
    }
    out[code] = value
  }
  return out
}

function requireString(obj, key, file) {
  const value = obj?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${file}: ${key} is required and must be a non-empty string`)
  }
  return value
}
