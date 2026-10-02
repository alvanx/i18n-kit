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
import { addKey, renameKey, deprecateKey, removeKey, touchKey, normalizeProject } from '../src/keys.mjs'
import { RULES, severityOf } from '../src/rules.mjs'
import { formatReport, formatStatus } from '../src/report.mjs'
import { serializeJson, GENERATED_KEY, GENERATED_NOTICE } from '../src/writer.mjs'

const USAGE = `i18n-kit — one authored catalog, every platform's string files

  i18n init                             scaffold i18n/ in this project
  i18n check [options]                  validate everything (no network)
  i18n export [--dry-run]               write every target's files
  i18n status [--json]                  per-locale completeness
  i18n pseudo [--locale <tag>]          generate the en-XA and ar-XB stress locales

  i18n add <key> --message <icu> --comment <why> [--namespace app] [--reuse-key]
  i18n rename <from> <to> [--namespace app]
  i18n deprecate <key> [--remove-after YYYY-MM-DD] [--reason <why>]
  i18n remove <key> [--force]
  i18n touch <key> --locale <tag> [--reason <why>]
  i18n normalize

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
      'Next:',
      '  1. Add your target languages to i18n/config.json under locales.required.',
      '  2. Replace the example message in i18n/source/app.json.',
      '  3. Run `i18n check`.',
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

// --- entry point ------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  check: cmdCheck,
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

  handler(values, rest)
}

try {
  main(process.argv.slice(2))
} catch (err) {
  if (err?.name === 'ConfigError' || err?.name === 'CatalogError' || err?.name === 'KeyError' || err?.name === 'IcuError') {
    fail(err.message)
  }
  throw err
}
