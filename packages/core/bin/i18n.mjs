#!/usr/bin/env node
/**
 * The i18n-kit CLI.
 *
 * Every command here is local. No network, no API key, no provider. Translation
 * lives in a separate package precisely so this one can run on a pull request
 * from a fork, where repository secrets are unavailable and a combined tool
 * would simply fail.
 *
 * Usage:
 *   i18n init                          scaffold i18n/ in this project
 *   i18n check [--release] [--json]    validate everything
 *   i18n export [--dry-run]            write every target's files
 *   i18n status                        per-locale completeness
 *   i18n pseudo [--locale en-XA]       generate stress locales
 *   i18n add <key> --message .. --comment ..
 *   i18n rename <from> <to>
 *   i18n deprecate <key> [--remove-after YYYY-MM-DD]
 *   i18n remove <key> [--force]
 *   i18n touch <key> --locale de       bless a stale translation as still correct
 *   i18n normalize                     re-canonicalize after a manual merge
 */

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadConfig, CONFIG_FILENAME } from '../src/config.mjs'
import { loadProject } from '../src/catalog.mjs'
import { check } from '../src/check.mjs'
import { runExport } from '../src/export.mjs'
import { generatePseudoLocale, PSEUDO_LOCALES } from '../src/pseudo.mjs'
import { addKey, renameKey, deprecateKey, removeKey, touchKey, normalizeProject, retranslateKey, appendAudit } from '../src/keys.mjs'
import { runImport } from '../src/sync.mjs'
import { RULES, severityOf } from '../src/rules.mjs'
import { formatReport, formatStatus } from '../src/report.mjs'
import { serializeJson, GENERATED_KEY, GENERATED_NOTICE } from '../src/writer.mjs'

const USAGE = `i18n-kit — one authored catalog, every platform's string files

  i18n init                             scaffold i18n/ in this project
  i18n import [--dry-run]               read the platform string files into the catalog
  i18n check [options]                  validate everything (no network)
  i18n translate [options]              fill the gaps (needs a provider and a key)
  i18n review [options]                 fix an existing locale's findings
  i18n export [--dry-run]               write every target's files
  i18n sync [options]                   import, check, translate, export
  i18n status [--json]                  per-locale completeness
  i18n pseudo [--locale <tag>]          generate the en-XA and ar-XB stress locales

  i18n add <key> --message <icu> --comment <why> [--namespace app] [--reuse-key]
  i18n rename <from> <to> [--namespace app]
  i18n deprecate <key> [--remove-after YYYY-MM-DD] [--reason <why>]
  i18n remove <key> [--force]
  i18n touch <key> --locale <tag> [--reason <why>]
  i18n retranslate --key <key> --locale <tag> --reason <why>
  i18n normalize

translate / review / sync options
  --locales <a,b>    only these locales (default: every configured target)
  --key <key>        only this key, repeatable
  --dry-run          estimate the cost and change nothing
  --max-spend <usd>  stop before passing this ceiling
  --batch-size <n>   strings per request (default 20)
  --max-attempts <n> tries per string before it is recorded as failed (default 3)
  --model <id>       override the configured model
  --yes              do not pause for confirmation

check options
  --release          apply the stricter severities that only block a release
  --since <ref>      treat keys added since <ref> as new, for the comment ratchet
  --json             machine-readable output
  --report github    GitHub Actions annotations
  --list-rules       print every rule and its severity
  --explain <CODE>   what one rule means and why it exists

global
  --cwd <dir>        project root (default: current directory)
`

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/** Today as YYYY-MM-DD. Dates in catalogs are days, never timestamps: a timestamp churns diffs. */
const today = () => new Date().toISOString().slice(0, 10)

function open(options) {
  const root = options.cwd ?? process.cwd()
  const config = loadConfig(root)
  const { project, findings } = loadProject(config)
  return { root, config, project, loadFindings: findings }
}

/**
 * Keys that did not exist at a git ref, for the comment ratchet.
 *
 * Returns null when git cannot answer. That disables the ratchet, which is the
 * safe direction: without it every missing comment is a counted warning, while
 * guessing "everything is new" would turn an existing backlog into a wall of
 * errors on the first run.
 */
function newKeysSince(project, ref) {
  const config = project.config
  let repoRoot
  try {
    repoRoot = execFileSync('git', ['-C', config.root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }

  const current = new Set()
  const previous = new Set()

  for (const [namespace, file] of project.source) {
    for (const key of file.messages.keys()) current.add(`${namespace}.${key}`)

    const relativePath = relative(repoRoot, file.file)
    try {
      const old = execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${relativePath}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const key of Object.keys(JSON.parse(old).messages ?? {})) previous.add(`${namespace}.${key}`)
    } catch {
      // The file did not exist at that ref, so every key in it is new.
    }
  }

  return new Set([...current].filter((k) => !previous.has(k)))
}

// --- commands ---------------------------------------------------------------

function cmdInit(options) {
  const root = options.cwd ?? process.cwd()
  const configPath = join(root, CONFIG_FILENAME)
  if (existsSync(configPath)) fail(`${configPath} already exists.`)

  mkdirSync(join(root, 'i18n', 'source'), { recursive: true })

  writeFileSync(
    configPath,
    serializeJson({
      $schema: 'https://raw.githubusercontent.com/alvanx/i18n-kit/main/packages/core/schemas/config.schema.json',
      schemaVersion: 1,
      sourceLocale: 'en',
      locales: { required: [], optional: [] },
      targets: { web: { adapter: 'web' } },
    }),
    'utf8',
  )

  writeFileSync(
    join(root, 'i18n', 'source', 'app.json'),
    serializeJson({
      $schema: 'https://raw.githubusercontent.com/alvanx/i18n-kit/main/packages/core/schemas/source.schema.json',
      schemaVersion: 1,
      namespace: 'app',
      sourceLocale: 'en',
      messages: {
        'app.greeting': {
          message: 'Hello, {name}',
          comment: 'Shown on the home screen after sign-in. Friendly, not formal.',
          context: 'heading',
          placeholders: {
            name: { type: 'string', example: 'Sam', desc: "The user's own display name.", doNotTranslate: true },
          },
        },
      },
    }),
    'utf8',
  )

  writeFileSync(join(root, 'i18n', 'glossary.json'), serializeJson({ terms: [] }), 'utf8')
  writeFileSync(
    join(root, 'i18n', 'style.md'),
    [
      '# Tone and style',
      '',
      'This file is sent to the translation provider verbatim. Write it for a competent',
      'translator who has never seen the product.',
      '',
      '- Who is speaking, and to whom.',
      '- How formal to be. Name the form where a language has one (German Sie, Japanese teineigo).',
      '- Anything that must never be translated beyond what the glossary already lists.',
      '',
    ].join('\n'),
    'utf8',
  )

  process.stdout.write(
    [
      `Created ${relative(root, configPath) || CONFIG_FILENAME}, a starter catalog, a glossary, and style.md.`,
      '',
      'Add your target languages to i18n/config.json under locales.required, then:',
      '',
      'If this project ALREADY has string files, point the config at them and keep',
      'authoring there. Nothing about how you work has to change:',
      '',
      '  "source": {',
      '    "mode": "sync",',
      '    "from": [{ "importer": "android", "path": "app/src/main/res/values/strings.xml", "namespace": "app" }]',
      '  }',
      '',
      '  Importers: android, chrome, apple, apple-strings, icu-json.',
      '  Then run `i18n import` and `i18n check`.',
      '',
      'If this project is starting fresh, replace the example message in',
      'i18n/source/app.json and run `i18n check`. The catalog is the source of truth,',
      'and `i18n export` will write the platform files for you.',
      '',
      'The one field worth caring about is `comment`. It is what a translator reads,',
      'and it is the difference between "Open" the button and "Open" the status.',
      '',
    ].join('\n'),
  )
}

function cmdCheck(options) {
  if (options['list-rules']) {
    const rows = Object.entries(RULES).map(([code, rule]) => `${rule.severity.padEnd(5)}  ${code.padEnd(28)}  ${rule.desc}`)
    process.stdout.write(`${rows.join('\n')}\n`)
    return
  }

  if (options.explain) {
    const code = options.explain
    const rule = RULES[code]
    if (!rule) fail(`Unknown rule "${code}". Run \`i18n check --list-rules\`.`)
    const extra = rule.releaseSeverity ? ` (${rule.releaseSeverity} with --release)` : ''
    process.stdout.write(`${code}\n  severity: ${rule.severity}${extra}\n  ${rule.desc}\n`)
    return
  }

  const { project, loadFindings } = open(options)
  const newKeys = options.since ? newKeysSince(project, options.since) : null
  const report = check(project, { loadFindings, release: Boolean(options.release), newKeys })

  const format = options.json ? 'json' : (options.report ?? 'human')
  process.stdout.write(`${formatReport(report, format)}\n`)
  process.exit(report.ok ? 0 : 1)
}

function cmdExport(options) {
  const { project } = open(options)
  const dryRun = Boolean(options['dry-run'])
  const result = runExport(project, { dryRun })

  for (const finding of result.findings) {
    process.stderr.write(`${finding.code}: ${finding.detail}\n`)
  }
  if (result.findings.length) {
    fail(`\nExport stopped. ${result.findings.length} problem(s) above; run \`i18n check\` for the full picture.`)
  }

  const verb = dryRun ? 'would write' : 'wrote'
  process.stdout.write(
    `${verb} ${result.written.length} file(s), ${result.unchanged.length} unchanged\n` +
      result.written.map((f) => `  ${f}\n`).join(''),
  )
}

function cmdStatus(options) {
  const { config, project } = open(options)
  const rows = []

  for (const locale of config.targetLocales()) {
    const row = { locale, translated: 0, missing: 0, stale: 0, failed: 0, human: 0 }
    for (const { namespace, key } of project.entries()) {
      const status = project.statusOf(locale, namespace, key)
      if (status.state === 'missing') row.missing += 1
      else if (status.state === 'failed') row.failed += 1
      else {
        row.translated += 1
        if (status.state.startsWith('stale')) row.stale += 1
        if (status.translation?.origin === 'human') row.human += 1
      }
    }
    rows.push(row)
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatStatus(rows)}\n`)
}

function cmdPseudo(options) {
  const { config, project } = open(options)
  const locales = options.locale ? [options.locale] : Object.keys(PSEUDO_LOCALES)
  const outDir = join(config.paths.out, 'pseudo')

  for (const locale of locales) {
    const { messages, skipped } = generatePseudoLocale(project, locale)
    const path = join(outDir, `${locale}.json`)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      path,
      serializeJson({ [GENERATED_KEY]: GENERATED_NOTICE, locale, messages }),
      'utf8',
    )
    process.stdout.write(`${path} — ${Object.keys(messages).length} messages${skipped.length ? `, ${skipped.length} skipped` : ''}\n`)
    for (const s of skipped) process.stderr.write(`  skipped ${s.key}: ${s.reason}\n`)
  }

  process.stdout.write(
    '\nThese only find hardcoded strings on screens you actually open. Run the app and click through it.\n',
  )
}

function namespaceOf(options, project, key) {
  if (options.namespace) return options.namespace
  const namespaces = project.namespaces()
  if (namespaces.length === 1) return namespaces[0]
  const owning = namespaces.filter((ns) => project.sourceEntry(ns, key))
  if (owning.length === 1) return owning[0]
  fail(`Several namespaces exist (${namespaces.join(', ')}). Say which with --namespace.`)
}

function cmdAdd(options, [key]) {
  if (!key) fail('Usage: i18n add <key> --message <icu> --comment <why>')
  const { project } = open(options)
  const namespace = namespaceOf(options, project, key)

  const result = addKey(project, {
    namespace,
    key,
    message: options.message,
    comment: options.comment,
    reuseKey: Boolean(options['reuse-key']),
  })
  project.save()

  process.stdout.write(`Added ${namespace}.${key}\n`)
  if (result.droppedTranslations.length) {
    process.stdout.write(
      `Dropped stale translations from a previous key of the same name: ${result.droppedTranslations.join(', ')}\n`,
    )
  }
}

function cmdRename(options, [from, to]) {
  if (!from || !to) fail('Usage: i18n rename <from> <to>')
  const { project } = open(options)
  const namespace = namespaceOf(options, project, from)

  const result = renameKey(project, { namespace, from, to })
  project.save()
  process.stdout.write(
    `Renamed ${namespace}.${from} to ${to}` +
      (result.movedLocales.length ? `, carrying translations in ${result.movedLocales.join(', ')}\n` : '\n'),
  )
}

function cmdDeprecate(options, [key]) {
  if (!key) fail('Usage: i18n deprecate <key> [--remove-after YYYY-MM-DD]')
  const { project } = open(options)
  const namespace = namespaceOf(options, project, key)

  deprecateKey(project, {
    namespace,
    key,
    since: today(),
    removeAfter: options['remove-after'] ?? null,
    reason: options.reason ?? null,
  })
  project.save()
  process.stdout.write(
    `Deprecated ${namespace}.${key}. It is excluded from export immediately; its translations are kept.\n`,
  )
}

function cmdRemove(options, [key]) {
  if (!key) fail('Usage: i18n remove <key> [--force]')
  const { project } = open(options)
  const namespace = namespaceOf(options, project, key)

  const result = removeKey(project, { namespace, key, force: Boolean(options.force), today: today() })
  project.save()
  process.stdout.write(
    `Removed ${namespace}.${key}` +
      (result.clearedLocales.length ? ` and its translations in ${result.clearedLocales.join(', ')}\n` : '\n'),
  )
}

function cmdTouch(options, [key]) {
  if (!key || !options.locale) fail('Usage: i18n touch <key> --locale <tag>')
  const { project } = open(options)
  const namespace = namespaceOf(options, project, key)

  touchKey(project, { namespace, key, locale: options.locale, reason: options.reason ?? null })
  project.save()
  process.stdout.write(
    `Blessed ${namespace}.${key} in ${options.locale} as still correct for the current source.\n`,
  )
}

function cmdNormalize(options) {
  const { project } = open(options)
  const { promoted, written } = normalizeProject(project)

  for (const p of promoted) {
    process.stdout.write(`${p.locale} ${p.namespace}.${p.key}: text differs from what the tool wrote, now human-owned\n`)
  }
  process.stdout.write(`Rewrote ${written.length} file(s).\n`)
}

function cmdImport(options) {
  const root = options.cwd ?? process.cwd()
  const config = loadConfig(root)
  const dryRun = Boolean(options['dry-run'])
  const result = runImport(config, { dryRun })

  for (const finding of result.findings) {
    process.stderr.write(`${finding.code}${finding.key ? ` ${finding.key}` : ''}: ${finding.detail}\n`)
  }

  const verb = dryRun ? 'would import' : 'imported'
  process.stdout.write(
    `\n${verb}: ${result.added.length} new, ${result.updated.length} changed, ` +
      `${result.unchanged} unchanged, ${result.deprecated.length} gone\n`,
  )
  for (const change of result.updated.slice(0, 20)) {
    process.stdout.write(`  ${change.key}\n    was: ${change.from}\n    now: ${change.to}\n`)
  }
  if (result.updated.length > 20) process.stdout.write(`  ... and ${result.updated.length - 20} more\n`)

  if (!dryRun && result.written.length) {
    process.stdout.write(`\nWrote ${result.written.length} catalog file(s). Run \`i18n check\` next.\n`)
  }
}

/**
 * Load the translate package on demand.
 *
 * Core deliberately does not depend on it, so that `check` and `export` work
 * with no provider SDK installed and no key available. The cost is this
 * indirection and a clear message when it is genuinely missing.
 */
async function loadTranslate() {
  try {
    return await import('@i18n-kit/translate')
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      fail('Translation lives in a separate package. Install it:\n\n  npm install @i18n-kit/translate\n')
    }
    throw err
  }
}

function translateOptions(options) {
  const number = (name, fallback) => {
    const raw = options[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) fail(`--${name} must be a positive number, got "${raw}"`)
    return value
  }

  return {
    locales: options.locales ? options.locales.split(',').map((l) => l.trim()).filter(Boolean) : undefined,
    keys: options.key ? [].concat(options.key) : null,
    batchSize: number('batch-size', 20),
    maxAttempts: number('max-attempts', 3),
    maxSpend: options['max-spend'] === undefined ? null : number('max-spend', null),
    dryRun: Boolean(options['dry-run']),
  }
}

function buildProvider(options, config, translate) {
  const configured = config.provider ?? {}
  const kind = options.provider ?? configured.kind ?? 'anthropic'

  if (kind !== 'anthropic') {
    fail(
      `Unknown provider "${kind}". This build ships "anthropic".\n` +
        `The engine takes any object with translateBatch and estimate, so another one is a module, not a fork.`,
    )
  }

  return translate.createAnthropicProvider({
    model: options.model ?? configured.model ?? translate.DEFAULT_MODEL,
    effort: configured.effort ?? 'high',
  })
}

function reportTranslation(report, translate) {
  const out = []

  for (const row of report.reused) {
    out.push(`reused   ${row.locale} ${row.key} (same source text as ${row.from})`)
  }
  for (const row of report.translated) {
    const flags = row.advisory.map((a) => a.code).join(', ')
    out.push(`ok       ${row.locale} ${row.key}${row.attempt > 1 ? ` (attempt ${row.attempt})` : ''}${flags ? ` [${flags}]` : ''}`)
  }
  for (const row of report.skipped) {
    out.push(`skipped  ${row.locale} ${row.key}: ${row.reason}`)
  }
  for (const row of report.failed) {
    out.push(`FAILED   ${row.locale} ${row.key}: ${row.reason}`)
  }

  if (report.notes.length) {
    out.push('', 'Notes from the translator, worth a read before you ship:')
    for (const row of report.notes) out.push(`  ${row.locale} ${row.key}: ${row.note}`)
  }

  if (report.dryRun) {
    const estimate = report.estimate
    out.push(
      '',
      estimate && estimate.items > 0
        ? `Would translate ${estimate.items} string(s): ` +
          `${estimate.inputTokens.toLocaleString('en-US')} input tokens, ` +
          `roughly ${estimate.outputTokens.toLocaleString('en-US')} output, ` +
          `about ${translate.formatCost(estimate.cost)} on ${report.model}.`
        : 'Nothing to translate.',
      estimate?.approximate
        ? 'Counted from character length, because no credentials were available to ask the API. Expect it to be within about 15%.'
        : null,
      'Retries are not priced in: only the strings that fail validation are sent again.',
    )
  } else {
    out.push('', translate.formatUsage(report.usage, report.model))
  }

  if (report.failed.length) {
    out.push(
      '',
      `${report.failed.length} string(s) could not be validated and were recorded with no text.`,
      'They fall back to the source language and `i18n check` reports them. That is deliberate:',
      'an empty slot is a visible gap, and a wrong translation is an invisible one.',
    )
  }

  return out.filter((line) => line !== null).join('\n')
}

async function cmdTranslate(options, positionals, { onlyWithFindings = false } = {}) {
  const translate = await loadTranslate()
  const { config, project, loadFindings } = open(options)
  const provider = buildProvider(options, config, translate)
  const opts = translateOptions(options)

  let findingsByKey = new Map()
  if (onlyWithFindings) {
    // Review works from the checker's own output, so the two can never
    // disagree about what is wrong with a locale.
    const report = check(project, { loadFindings })
    for (const finding of report.findings) {
      if (!finding.key || !finding.locale || finding.severity === 'info') continue
      if (opts.locales && !opts.locales.includes(finding.locale)) continue
      // A string that has never been translated is not a fault in the existing
      // translation; it is the absence of one. `translate` fills those. Review
      // is for what is there and wrong, which is a different decision about
      // how to spend money.
      if (ABSENCE_CODES.has(finding.code)) continue
      // Keyed by locale as well as key. Without the locale, a broken Russian
      // string would queue the same key in German, which is correct there and
      // would be paid for anyway.
      const id = `${finding.locale}/${finding.namespace ?? 'app'}/${finding.key}`
      findingsByKey.set(id, [...(findingsByKey.get(id) ?? []), finding])
    }
    if (findingsByKey.size === 0) {
      process.stdout.write(
        'Nothing to review: `i18n check` finds no problems in the translations that exist.\n' +
          'Untranslated strings are `i18n translate`, not review.\n',
      )
      return
    }
  }

  const seen = new Set()
  const report = await translate.translateProject({
    project,
    provider,
    options: { ...opts, onlyWithFindings, findingsByKey },
    onEvent: (event) => {
      if (event.type === 'locale-start') {
        process.stderr.write(`${event.locale}: ${event.items} string(s) in ${event.batches} request(s)\n`)
      }
      if (event.type === 'rejected' && !seen.has(`${event.locale}/${event.key}`)) {
        seen.add(`${event.locale}/${event.key}`)
        process.stderr.write(`  retrying ${event.locale} ${event.key}: ${event.codes.join(', ')}\n`)
      }
      if (event.type === 'batch-error') process.stderr.write(`  ${event.code}: ${event.detail}\n`)
    },
  })

  if (!opts.dryRun) {
    const written = project.save()
    process.stdout.write(`${reportTranslation(report, translate)}\n\nWrote ${written.length} catalog file(s).\n`)
    process.stdout.write('Run `i18n check` and then `i18n export`.\n')
  } else {
    process.stdout.write(`${reportTranslation(report, translate)}\n`)
  }
}

/**
 * Findings that mean "there is nothing here", as opposed to "what is here is
 * wrong". Review ignores them; translate exists for them.
 */
const ABSENCE_CODES = new Set(['MISSING_KEY', 'MISSING_KEY_OPTIONAL', 'FAILED_ATTEMPT'])

const cmdReview = (options, positionals) => cmdTranslate(options, positionals, { onlyWithFindings: true })

async function cmdSync(options) {
  cmdImport(options)

  const { project, loadFindings } = open(options)
  const before = check(project, { loadFindings })

  // Gate on the SOURCE only. A missing or broken translation is the reason
  // sync is being run, so blocking on one would make the command refuse to do
  // its job. A source finding carries no locale.
  const sourceErrors = before.findings.filter((f) => f.severity === 'error' && !f.locale)
  if (sourceErrors.length) {
    for (const finding of sourceErrors) {
      process.stderr.write(`${finding.code} ${finding.key ?? ''}: ${finding.detail}\n`)
    }
    fail(
      `\n${sourceErrors.length} problem(s) in the source catalog. Fix those first: ` +
        `a bad source message produces a bad translation in every language at once.\n` +
        `Run \`i18n check\` for the full picture.`,
    )
  }

  await cmdTranslate(options, [])
  if (options['dry-run']) return

  // Re-check before export so the run ends by saying what it could not do.
  const after = loadProject(project.config)
  const report = check(after.project, { loadFindings: after.findings })
  cmdExport(options)
  if (!report.ok) {
    process.stdout.write(
      `\n${report.counts.error} error(s) remain. Run \`i18n check\` to see them: ` +
        `anything that could not be validated was left untranslated rather than guessed at.\n`,
    )
  }
}

function cmdRetranslate(options) {
  if (!options.key || !options.locale) {
    fail('Usage: i18n retranslate --key <key> --locale <tag> --reason "why"')
  }
  const { config, project } = open(options)
  const key = [].concat(options.key)[0]
  const namespace = namespaceOf(options, project, key)

  const result = retranslateKey(project, {
    namespace,
    key,
    locale: options.locale,
    reason: options.reason,
    at: today(),
  })

  appendAudit(config, { at: today(), action: 'retranslate', ...result })
  project.save()

  process.stdout.write(
    `Recorded a retranslation request for ${namespace}.${key} in ${options.locale}.\n` +
      (result.previous ? `The previous text is kept in the entry's history:\n  ${result.previous}\n` : '') +
      `\nNothing has changed yet. Run \`i18n translate --locales ${options.locale} --key ${key}\` to replace it.\n`,
  )
}

// --- entry point ------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  import: cmdImport,
  check: cmdCheck,
  translate: cmdTranslate,
  review: cmdReview,
  sync: cmdSync,
  retranslate: cmdRetranslate,
  export: cmdExport,
  status: cmdStatus,
  pseudo: cmdPseudo,
  add: cmdAdd,
  rename: cmdRename,
  deprecate: cmdDeprecate,
  remove: cmdRemove,
  touch: cmdTouch,
  normalize: cmdNormalize,
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      release: { type: 'boolean' },
      since: { type: 'string' },
      json: { type: 'boolean' },
      report: { type: 'string' },
      'list-rules': { type: 'boolean' },
      explain: { type: 'string' },
      'dry-run': { type: 'boolean' },
      locale: { type: 'string' },
      namespace: { type: 'string' },
      message: { type: 'string' },
      comment: { type: 'string' },
      reason: { type: 'string' },
      'reuse-key': { type: 'boolean' },
      'remove-after': { type: 'string' },
      force: { type: 'boolean' },
      locales: { type: 'string' },
      key: { type: 'string', multiple: true },
      'max-spend': { type: 'string' },
      'batch-size': { type: 'string' },
      'max-attempts': { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const [command, ...rest] = positionals
  if (!command || values.help) {
    process.stdout.write(USAGE)
    process.exit(command ? 0 : 1)
  }

  const handler = COMMANDS[command]
  if (!handler) fail(`Unknown command "${command}".\n\n${USAGE}`)

  return handler(values, rest)
}

try {
  await main(process.argv.slice(2))
} catch (err) {
  if (
    err?.name === 'ConfigError' ||
    err?.name === 'CatalogError' ||
    err?.name === 'KeyError' ||
    err?.name === 'IcuError' ||
    err?.name === 'SpendLimitReached' ||
    err?.name === 'RenderError'
  ) {
    fail(err.message)
  }
  // An authentication failure is the one provider error worth translating into
  // advice, because it is the first thing anyone hits.
  if (
    err?.status === 401 ||
    err?.name === 'AuthenticationError' ||
    String(err?.message ?? '').includes('Could not resolve authentication method')
  ) {
    fail(
      'No usable credentials for the translation provider.\n\n' +
        '  Set ANTHROPIC_API_KEY in your environment, or run `ant auth login`.\n\n' +
        '  Only `translate` and `review` need them. `import`, `check`, `export`, `status`\n' +
        '  and `pseudo` are entirely local, which is why they work on a fork pull request.',
    )
  }
  throw err
}
