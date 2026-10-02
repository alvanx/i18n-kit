import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadProject } from '../src/catalog.mjs'
import { check } from '../src/check.mjs'
import { sourceHash, contextHash, contentHash } from '../src/hash.mjs'
import { analyze, contractOf } from '../src/icu.mjs'
import { serializeJson } from '../src/writer.mjs'
import { makeProject } from './helpers.mjs'

const SRC = 'Send {count, plural, one {# tab} other {# tabs}} to {device}?'

const src = (over = {}) => ({
  message: SRC,
  comment: 'Confirmation dialog title.',
  context: 'dialog-title',
  placeholders: {
    count: { type: 'number', example: 3, desc: 'Tabs queued.' },
    device: { type: 'string', example: 'Phone', desc: 'Target device.' },
  },
  ...over,
})

const translated = (sourceEntry, message, over = {}) => ({
  message,
  origin: 'machine',
  review: 'none',
  sourceHash: sourceHash(sourceEntry.message, contractOf(analyze(sourceEntry.message))),
  contextHash: contextHash(sourceEntry),
  contentHash: contentHash(message),
  ...over,
})

function run(spec, opts = {}) {
  const made = makeProject(spec)
  const { project, findings } = loadProject(made.config)
  return { ...check(project, { loadFindings: findings, ...opts }), root: made.root, project }
}

const codes = (report) => report.findings.map((f) => f.code)
const find = (report, code) => report.findings.find((f) => f.code === code)

const DE_OK = '{count, plural, one {# Tab} other {# Tabs}} an {device} senden?'

// --- the happy path ---------------------------------------------------------

test('a complete, current project passes', () => {
  const s = src()
  const report = run({
    source: { app: { 'transfer.confirm': s } },
    translations: { de: { app: { 'transfer.confirm': translated(s, DE_OK) } } },
  })
  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2))
  assert.equal(report.counts.error, 0)
})

// --- missing ----------------------------------------------------------------

test('a missing required locale is an error', () => {
  const report = run({ source: { app: { 'transfer.confirm': src() } } })
  assert.equal(find(report, 'MISSING_KEY').severity, 'error')
  assert.equal(report.ok, false)
})

test('a missing optional locale is only a warning', () => {
  const s = src()
  const report = run({
    config: { locales: { required: ['de'], optional: ['ja'] } },
    source: { app: { 'transfer.confirm': s } },
    translations: { de: { app: { 'transfer.confirm': translated(s, DE_OK) } } },
  })
  assert.equal(find(report, 'MISSING_KEY_OPTIONAL').severity, 'warn')
  assert.equal(report.ok, true)
})

test('a sensitive entry reports as awaiting a human, not as missing', () => {
  const report = run({ source: { app: { 'transfer.confirm': src({ sensitive: true }) } } })
  assert.ok(find(report, 'SENSITIVE_UNTRANSLATED'))
  assert.equal(find(report, 'MISSING_KEY'), undefined)
})

test('a failed attempt is an error and carries its reason', () => {
  const s = src()
  const failed = translated(s, DE_OK, { attempt: { status: 'failed', reason: 'PLURAL_CATEGORY_MISSING: many', at: '2026-08-17' } })
  delete failed.message
  const report = run({
    source: { app: { 'transfer.confirm': s } },
    translations: { de: { app: { 'transfer.confirm': failed } } },
  })
  assert.equal(find(report, 'FAILED_ATTEMPT').severity, 'error')
  assert.match(find(report, 'FAILED_ATTEMPT').detail, /PLURAL_CATEGORY_MISSING/)
})

// --- the who-wrote-it matrix ------------------------------------------------

const staleSource = { ...src(), message: 'Deliver {count, plural, one {# tab} other {# tabs}} to {device}?' }
const contractChanged = { ...src(), message: 'Send {count, plural, one {# tab} other {# tabs}} to {device} at {when}?' }

test('a stale machine translation is an error', () => {
  const report = run({
    source: { app: { 'a.b': staleSource } },
    translations: { de: { app: { 'a.b': translated(src(), DE_OK) } } },
  })
  assert.equal(find(report, 'STALE_MACHINE').severity, 'error')
})

test('a human translation behind on wording is a warning, and the build still passes', () => {
  const report = run({
    source: { app: { 'a.b': staleSource } },
    translations: { de: { app: { 'a.b': translated(src(), DE_OK, { origin: 'human' }) } } },
  })
  assert.equal(find(report, 'STALE_HUMAN_TEXT').severity, 'warn')
  assert.equal(report.ok, true)
})

test('the same human translation blocks a release', () => {
  const report = run(
    {
      source: { app: { 'a.b': staleSource } },
      translations: { de: { app: { 'a.b': translated(src(), DE_OK, { origin: 'human' }) } } },
    },
    { release: true },
  )
  assert.equal(find(report, 'STALE_HUMAN_TEXT').severity, 'error')
  assert.equal(report.ok, false)
})

test('a human translation whose contract broke is an error regardless of who wrote it', () => {
  const report = run({
    source: { app: { 'a.b': contractChanged } },
    translations: { de: { app: { 'a.b': translated(src(), DE_OK, { origin: 'human' }) } } },
  })
  assert.equal(find(report, 'STALE_HUMAN_STRUCTURAL').severity, 'error')
})

test('a comment-only change is information, never a build failure', () => {
  const report = run({
    source: { app: { 'a.b': src({ comment: 'Reworded comment.' }) } },
    translations: { de: { app: { 'a.b': translated(src(), DE_OK) } } },
  })
  assert.equal(find(report, 'STALE_CONTEXT').severity, 'info')
  assert.equal(report.ok, true)
})

// --- structure --------------------------------------------------------------

test('a dropped placeholder is an error', () => {
  const s = src()
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, '{count, plural, one {# Tab} other {# Tabs}} senden?') } } },
  })
  assert.equal(find(report, 'PLACEHOLDER_MISMATCH').severity, 'error')
})

test('a flattened plural is an error', () => {
  const s = src()
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, '{count} Tabs an {device} senden?') } } },
  })
  assert.ok(find(report, 'PLURAL_STRUCTURE_MISMATCH'))
})

test('an undeclared placeholder is an error', () => {
  const report = run({
    source: { app: { 'a.b': { message: 'Hi {name}', comment: 'Greeting.' } } },
  })
  assert.equal(find(report, 'PLACEHOLDER_UNDECLARED').severity, 'error')
})

test('a declared placeholder that is not used is an error', () => {
  const report = run({
    source: {
      app: {
        'a.b': { message: 'Hi there', comment: 'Greeting.', placeholders: { name: { type: 'string' } } },
      },
    },
  })
  assert.equal(find(report, 'PLACEHOLDER_UNUSED').severity, 'error')
})

test('a plural selector declared as a string is a type conflict', () => {
  const report = run({
    source: {
      app: {
        'a.b': {
          message: '{count, plural, one {# tab} other {# tabs}}',
          comment: 'Count.',
          placeholders: { count: { type: 'string' } },
        },
      },
    },
  })
  assert.equal(find(report, 'PLACEHOLDER_TYPE_CONFLICT').severity, 'error')
})

test('a swallowed placeholder is caught in a source message', () => {
  const report = run({
    source: {
      app: { 'a.b': { message: "l'{name} chien", comment: 'French.', placeholders: { name: { type: 'string' } } } },
    },
  })
  assert.equal(find(report, 'ICU_APOSTROPHE_EATS_ARG').severity, 'error')
})

// --- plurals across real languages ------------------------------------------

test('Russian needs four categories and says which are missing', () => {
  const s = src()
  const report = run({
    config: { locales: { required: ['ru'] } },
    source: { app: { 'a.b': s } },
    translations: { ru: { app: { 'a.b': translated(s, '{count, plural, one {# вкладка} other {# вкладок}} на {device}?') } } },
  })
  const finding = find(report, 'PLURAL_CATEGORY_MISSING')
  assert.equal(finding.severity, 'error')
  assert.match(finding.detail, /missing few, many/)
})

test('Japanese needs only other, so a single branch passes', () => {
  const s = src()
  const report = run({
    config: { locales: { required: ['ja'] } },
    source: { app: { 'a.b': s } },
    translations: { ja: { app: { 'a.b': translated(s, '{count, plural, other {#個のタブ}}を{device}に送信') } } },
  })
  assert.equal(find(report, 'PLURAL_CATEGORY_MISSING'), undefined)
})

test('a zero branch in an English source is an error, because English never selects it', () => {
  const report = run({
    source: {
      app: {
        'a.b': {
          message: '{count, plural, zero {No tabs} one {# tab} other {# tabs}}',
          comment: 'Count.',
          placeholders: { count: { type: 'number' } },
        },
      },
    },
  })
  const finding = find(report, 'PLURAL_ZERO_IN_SOURCE')
  assert.equal(finding.severity, 'error')
  assert.match(finding.detail, /separate key/)
})

test('a zero branch in Arabic is required, not flagged', () => {
  const s = {
    message: '{count, plural, one {# tab} other {# tabs}}',
    comment: 'Count.',
    placeholders: { count: { type: 'number' } },
  }
  const ar = '{count, plural, zero {لا تبويبات} one {تبويب} two {تبويبان} few {# تبويبات} many {# تبويبا} other {# تبويب}}'
  const report = run({
    config: { locales: { required: ['ar'] } },
    source: { app: { 'a.b': s } },
    translations: { ar: { app: { 'a.b': translated(s, ar) } } },
  })
  assert.equal(find(report, 'PLURAL_CATEGORY_MISSING'), undefined)
  assert.equal(find(report, 'PLURAL_CATEGORY_EXTRA'), undefined)
})

// --- authoring hygiene ------------------------------------------------------

test('a missing comment on a pre-existing key is a counted warning', () => {
  const report = run({ source: { app: { 'a.b': { message: 'Hi' } } } })
  const finding = find(report, 'COMMENT_MISSING')
  assert.equal(finding.severity, 'warn')
  assert.match(finding.detail, /1 pre-existing key has no comment/)
})

test('a missing comment on a new key is an error', () => {
  const report = run({ source: { app: { 'a.b': { message: 'Hi' } } } }, { newKeys: new Set(['app.a.b']) })
  const finding = find(report, 'COMMENT_MISSING')
  assert.equal(finding.severity, 'error')
  assert.match(finding.detail, /is new and has no comment/)
})

test('keys that collapse to the same platform resource name collide', () => {
  const report = run({
    source: {
      app: {
        'a.b_c': { message: 'One', comment: 'x' },
        'a_b.c': { message: 'Two', comment: 'y' },
      },
    },
  })
  const finding = find(report, 'NAME_COLLISION')
  assert.equal(finding.severity, 'error')
  assert.match(finding.detail, /a_b_c/)
})

test('an orphaned translation is reported', () => {
  const s = src()
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, DE_OK), 'gone.away': translated(s, DE_OK) } } },
  })
  assert.equal(find(report, 'ORPHAN_KEY').severity, 'warn')
})

// --- length and layout ------------------------------------------------------

test('a declared maxLength is an error when exceeded', () => {
  const s = src({ maxLength: { value: 10 } })
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, DE_OK) } } },
  })
  assert.equal(find(report, 'MAX_LENGTH_EXCEEDED').severity, 'error')
})

test('maxLength counts CJK as two columns', () => {
  const s = { message: 'Send', comment: 'Button.', maxLength: { value: 6, measure: 'display-width' } }
  const report = run({
    config: { locales: { required: ['ja'] } },
    source: { app: { 'a.b': s } },
    translations: { ja: { app: { 'a.b': translated(s, '送信する') } } }, // 4 chars, 8 columns
  })
  assert.match(find(report, 'MAX_LENGTH_EXCEEDED').detail, /8 exceeds/)
})

test('an over-long translation without a declared limit is a warning', () => {
  const s = { message: 'Send', comment: 'Button.' }
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, 'Diesen Tab jetzt an das Gerät senden') } } },
  })
  assert.equal(find(report, 'TEXT_EXPANSION').severity, 'warn')
})

test('marketing copy is exempt from the expansion budget', () => {
  const s = { message: 'Send', comment: 'Headline.', class: 'marketing' }
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, 'Verschicke deine Tabs blitzschnell an jedes Gerät') } } },
  })
  assert.equal(find(report, 'TEXT_EXPANSION'), undefined)
})

test('a translation identical to its source is a warning', () => {
  const s = { message: 'Dashboard overview', comment: 'Heading.' }
  const report = run({
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, 'Dashboard overview') } } },
  })
  assert.equal(find(report, 'UNTRANSLATED_IDENTICAL').severity, 'warn')
})

test('an unisolated user value in an RTL locale is flagged', () => {
  const s = {
    message: 'Sent to {device}',
    comment: 'Toast.',
    placeholders: { device: { type: 'string', doNotTranslate: true } },
  }
  const report = run({
    config: { locales: { required: ['ar'] } },
    source: { app: { 'a.b': s } },
    translations: { ar: { app: { 'a.b': translated(s, 'تم الإرسال إلى {device}') } } },
  })
  assert.equal(find(report, 'BIDI_ISOLATION').severity, 'warn')
})

// --- glossary ---------------------------------------------------------------

function withGlossary(spec, glossary) {
  const made = makeProject(spec)
  writeFileSync(join(made.root, 'i18n', 'glossary.json'), serializeJson(glossary), 'utf8')
  const { project, findings } = loadProject(made.config)
  return check(project, { loadFindings: findings })
}

test('a do-not-translate term that vanished is an error', () => {
  const s = { message: 'Open Tabsend', comment: 'Button.' }
  const report = withGlossary(
    {
      source: { app: { 'a.b': s } },
      translations: { de: { app: { 'a.b': translated(s, 'Tabversand öffnen') } } },
    },
    { terms: [{ term: 'Tabsend', doNotTranslate: true, caseSensitive: true }] },
  )
  assert.equal(find(report, 'GLOSSARY_DNT_VIOLATION').severity, 'error')
})

test('a preferred term is only a warning, because inflection is legitimate', () => {
  const s = { message: 'Check the relay', comment: 'Body.' }
  const report = withGlossary(
    {
      source: { app: { 'a.b': s } },
      translations: { de: { app: { 'a.b': translated(s, 'Weiterleitung prüfen') } } },
    },
    { terms: [{ term: 'relay', translations: { de: 'Relay' } }] },
  )
  assert.equal(find(report, 'GLOSSARY_PREFERRED_MISS').severity, 'warn')
})

test('the same preferred term drops to info for marketing copy', () => {
  const s = { message: 'Check the relay', comment: 'Headline.', class: 'marketing' }
  const report = withGlossary(
    {
      source: { app: { 'a.b': s } },
      translations: { de: { app: { 'a.b': translated(s, 'Weiterleitung prüfen') } } },
    },
    { terms: [{ term: 'relay', translations: { de: 'Relay' } }] },
  )
  assert.equal(find(report, 'GLOSSARY_PREFERRED_MISS').severity, 'info')
})

// --- privacy ----------------------------------------------------------------

test('a placeholder example that looks like real data is flagged', () => {
  const report = run({
    source: {
      app: {
        'a.b': {
          message: 'Mail to {addr}',
          comment: 'Body.',
          placeholders: { addr: { type: 'string', example: 'ben.misja@example.com' } },
        },
      },
    },
  })
  assert.match(find(report, 'EXAMPLE_LOOKS_PERSONAL').detail, /email address/)
})

// --- severity overrides -----------------------------------------------------

test('a project can raise a warning to an error', () => {
  const s = { message: 'Dashboard overview', comment: 'Heading.' }
  const report = run({
    config: { severity: { UNTRANSLATED_IDENTICAL: 'error' } },
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, 'Dashboard overview') } } },
  })
  assert.equal(find(report, 'UNTRANSLATED_IDENTICAL').severity, 'error')
  assert.equal(report.ok, false)
})

test('a project can silence a warning entirely', () => {
  const s = { message: 'Dashboard overview', comment: 'Heading.' }
  const report = run({
    config: { severity: { UNTRANSLATED_IDENTICAL: 'off' } },
    source: { app: { 'a.b': s } },
    translations: { de: { app: { 'a.b': translated(s, 'Dashboard overview') } } },
  })
  assert.equal(find(report, 'UNTRANSLATED_IDENTICAL'), undefined)
})

test('findings are ordered errors first', () => {
  const report = run({
    source: {
      app: {
        'a.b': { message: 'Hi {name}', comment: 'x' },
        'a.c': { message: 'Dashboard overview' },
      },
    },
  })
  const severities = report.findings.map((f) => f.severity)
  assert.deepEqual([...severities].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a] - ({ error: 0, warn: 1, info: 2 })[b]), severities)
})

test('every finding carries a code that describes itself', () => {
  const report = run({ source: { app: { 'a.b': src() } } })
  for (const f of report.findings) {
    assert.ok(report.describe(f.code).length > 0, `${f.code} has no description`)
  }
})

// --- codes sanity -----------------------------------------------------------

test('a clean project produces no findings at all', () => {
  const s = src()
  const report = run({
    source: { app: { 'transfer.confirm': s } },
    translations: { de: { app: { 'transfer.confirm': translated(s, DE_OK) } } },
  })
  assert.deepEqual(codes(report), [])
})
