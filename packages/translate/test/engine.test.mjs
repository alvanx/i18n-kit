/**
 * Engine tests, all against the stub provider.
 *
 * Every behaviour worth asserting about here is the engine's, not the model's:
 * whether a bad answer is retried with the reason, whether a human translation
 * survives, whether an unvalidatable string is left empty rather than written.
 * None of that needs a network call, and tying it to one would mean these tests
 * never run in CI, which is where they matter.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadProject } from '@i18n-kit/core'
import { translateProject, SpendLimitReached } from '../src/engine.mjs'
import { createStubProvider } from '../src/providers/stub.mjs'
import { makeProject, readTranslation, handEdit } from '../../core/test/helpers.mjs'

const TABS = '{count, plural, one {# tab} other {# tabs}}'

function setup(spec) {
  const { root, config } = makeProject(spec)
  const { project, findings } = loadProject(config)
  return { root, config, project, loadFindings: findings }
}

async function run(project, answers, options = {}) {
  const provider = createStubProvider({ answers })
  const report = await translateProject({ project, provider, options })
  return { report, provider }
}


test('a valid translation lands, with its provenance', async () => {
  const { root, project } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  const { report } = await run(project, { 'a.hello': 'Hallo' })
  project.save()

  assert.equal(report.translated.length, 1)
  const entry = readTranslation(root, 'de', 'app').messages['a.hello']
  assert.equal(entry.message, 'Hallo')
  assert.equal(entry.origin, 'machine')
  assert.equal(entry.provenance.kind, 'provider')
  assert.ok(entry.contentHash, 'the content hash is what makes a later hand edit detectable')
})

test('a dropped placeholder is rejected and retried with the reason', async () => {
  const { project } = setup({
    source: { app: { 'a.send': { message: 'Send to {device}', comment: 'Button' } } },
  })

  // First answer loses the placeholder; second one keeps it.
  const { report, provider } = await run(project, { 'a.send': ['An das Gerät senden', 'An {device} senden'] })

  assert.equal(provider.attempts.get('a.send'), 2, 'it must have asked twice')
  assert.equal(report.translated.length, 1)
  assert.equal(report.translated[0].attempt, 2)
  assert.equal(report.failed.length, 0)
})

test('a translation that never validates is recorded with no text at all', async () => {
  const { root, project } = setup({
    source: { app: { 'a.send': { message: 'Send to {device}', comment: 'Button' } } },
  })

  const { report } = await run(project, { 'a.send': 'An das Gerät senden' })
  project.save()

  assert.equal(report.translated.length, 0)
  assert.equal(report.failed.length, 1)

  const entry = readTranslation(root, 'de', 'app').messages['a.send']
  assert.equal(entry.message, undefined, 'an empty slot falls back to English and is visible; a wrong string is not')
  assert.equal(entry.attempt.status, 'failed')
  assert.match(entry.attempt.reason, /PLACEHOLDER_MISMATCH/)
})

test('Russian gets all four plural categories, and two is not enough', async () => {
  const { project } = setup({
    config: { locales: { required: ['ru'], optional: [] } },
    source: { app: { 'a.tabs': { message: TABS, comment: 'Count of tabs' } } },
  })

  const { report, provider } = await run(project, {
    'a.tabs': [
      // Mirrors English, which is the mistake the checker exists to catch.
      '{count, plural, one {# вкладка} other {# вкладок}}',
      '{count, plural, one {# вкладка} few {# вкладки} many {# вкладок} other {# вкладок}}',
    ],
  })

  assert.equal(provider.attempts.get('a.tabs'), 2)
  assert.equal(report.translated.length, 1)
})

test('the retry says which categories are missing, not just that something is wrong', async () => {
  const { project } = setup({
    config: { locales: { required: ['ru'], optional: [] } },
    source: { app: { 'a.tabs': { message: TABS, comment: 'Count' } } },
  })

  const corrections = []
  const provider = createStubProvider({ answers: { 'a.tabs': '{count, plural, one {# вкладка} other {# вкладок}}' } })
  const original = provider.translateBatch.bind(provider)
  provider.translateBatch = async (args) => {
    if (args.user.includes('Corrections required')) corrections.push(args.user)
    return original(args)
  }

  await translateProject({ project, provider, options: { maxAttempts: 2 } })

  assert.equal(corrections.length, 1)
  assert.match(corrections[0], /PLURAL_CATEGORY_MISSING/)
  assert.match(corrections[0], /missing few, many/)
})

test('a human translation is never queued, and the message says how to override', async () => {
  const { root, project } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
    translations: { de: { app: { 'a.hello': { message: 'Moin', origin: 'human', review: 'approved' } } } },
  })

  const { report } = await run(project, { 'a.hello': 'Hallo' })
  project.save()

  assert.equal(report.translated.length, 0)
  assert.equal(report.skipped.length, 1)
  assert.match(report.skipped[0].reason, /i18n retranslate/)
  assert.equal(readTranslation(root, 'de', 'app').messages['a.hello'].message, 'Moin')
})

test('a hand edit survives a later source change instead of being overwritten', async () => {
  // The scenario the content hash exists for: a machine translation that
  // someone improved by hand, and then the English wording changes. Without
  // the hash the next run would quietly replace the better wording.
  const first = setup({ source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } } })
  await run(first.project, { 'a.hello': 'Hallo' })
  first.project.save()

  handEdit(first.root, 'de', 'app', 'a.hello', 'Hallo zusammen')

  // Now the source changes, which is what would normally queue a retranslation.
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(
    join(first.root, 'i18n', 'source', 'app.json'),
    JSON.stringify({
      schemaVersion: 1,
      namespace: 'app',
      sourceLocale: 'en',
      messages: { 'a.hello': { message: 'Hello there', comment: 'Greeting' } },
    }),
    'utf8',
  )

  const reloaded = loadProject(first.config)
  const { report } = await run(reloaded.project, { 'a.hello': 'Hallo zusammen, neu' })
  reloaded.project.save()

  assert.equal(report.translated.length, 0)
  assert.equal(report.skipped.length, 1)
  assert.match(report.skipped[0].reason, /a person wrote this translation/)
  assert.equal(
    readTranslation(first.root, 'de', 'app').messages['a.hello'].message,
    'Hallo zusammen',
    'the hand-written wording is still there',
  )
})

test('an identical source string reuses the settled translation instead of paying for it twice', async () => {
  const first = setup({
    source: {
      app: {
        'a.open': { message: 'Open all', comment: 'Button in the notification' },
        'b.open': { message: 'Open all', comment: 'Button in the inbox' },
      },
    },
  })

  // Settle the first one, then make it human-owned the way a reviewer would.
  await run(first.project, { 'a.open': 'Alle öffnen' }, { keys: ['a.open'] })
  first.project.save()
  handEdit(first.root, 'de', 'app', 'a.open', 'Alle öffnen!')

  const reloaded = loadProject(first.config)
  const { report, provider } = await run(reloaded.project, { 'b.open': 'Alle aufmachen' })

  assert.equal(report.reused.length, 1)
  assert.equal(report.reused[0].key, 'b.open')
  assert.equal(report.reused[0].from, 'a.open')
  assert.equal(report.reused[0].message, 'Alle öffnen!', 'the settled wording, not a second opinion')
  assert.equal(provider.attempts.size, 0, 'nothing was sent')
})

test('a do-not-translate term is a rejection, not a warning', async () => {
  const { project } = setup({
    source: { app: { 'a.title': { message: 'Tabsend is ready', comment: 'Heading' } } },
  })
  const glossaryPath = `${project.config.paths.glossary}`
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(glossaryPath), { recursive: true })
  writeFileSync(glossaryPath, JSON.stringify({ terms: [{ term: 'Tabsend', doNotTranslate: true }] }), 'utf8')

  const { report, provider } = await run(project, {
    'a.title': ['Tabversand ist bereit', 'Tabsend ist bereit'],
  })

  assert.equal(provider.attempts.get('a.title'), 2)
  assert.equal(report.translated.length, 1)
  assert.equal(report.translated[0].attempt, 2)
})

test('a spend ceiling stops the run rather than reporting the overspend afterwards', async () => {
  const { project } = setup({
    source: {
      app: Object.fromEntries(
        Array.from({ length: 40 }, (_, n) => [`a.k${n}`, { message: `String ${n}`, comment: 'x' }]),
      ),
    },
  })

  const provider = createStubProvider({
    answers: Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`a.k${n}`, `Zeichen ${n}`])),
  })
  // Every stub request reports usage, so a ceiling of effectively zero trips
  // after the first one.
  await assert.rejects(
    () => translateProject({ project, provider, options: { batchSize: 5, maxSpend: 0.000001 } }),
    SpendLimitReached,
  )
})

test('a provider that answers with a key nobody asked about is retried, not trusted', async () => {
  const { project } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  const provider = createStubProvider({ answers: { 'something.else': 'Hallo' } })
  const report = await translateProject({ project, provider, options: { maxAttempts: 2 } })

  assert.equal(report.translated.length, 0)
  assert.equal(report.failed.length, 1)
  assert.match(report.failed[0].reason, /did not return an entry/)
})

test('a note from the translator is kept and surfaced', async () => {
  const { root, project } = setup({
    source: { app: { 'a.open': { message: 'Open', comment: 'Could be a verb or a state' } } },
  })

  const provider = createStubProvider({ answers: { 'a.open': 'Öffnen' } })
  provider.translateBatch = async ({ items }) => ({
    results: new Map(items.map((i) => [i.key, { message: 'Öffnen', note: 'Read as a verb. If it labels a state, it should be "Geöffnet".' }])),
    usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
  })

  const report = await translateProject({ project, provider })
  project.save()

  assert.equal(report.notes.length, 1)
  assert.match(report.notes[0].note, /Geöffnet/)
  assert.match(readTranslation(root, 'de', 'app').messages['a.open'].note, /verb/)
})

test('a dry run writes nothing and prices what it would do', async () => {
  const { root, project } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  const report = await translateProject({
    project,
    provider: createStubProvider({ answers: { 'a.hello': 'Hallo' } }),
    options: { dryRun: true },
  })

  assert.equal(report.estimate.items, 1)
  assert.equal(report.failed.length, 0, 'a dry run has not asked anything, so nothing can have failed')
  assert.throws(() => readTranslation(root, 'de', 'app'))
})

// --- review mode ------------------------------------------------------------

test('review only touches the locale the finding is about', async () => {
  // The bug this guards: a findings map keyed by key alone makes a broken
  // Russian string queue the same key in German, where it was fine, and the
  // German re-translation is paid for and may come back different.
  const { project } = setup({
    config: { locales: { required: ['de', 'ru'], optional: [] } },
    source: { app: { 'a.send': { message: 'Send to {device}', comment: 'Button' } } },
  })

  const report = await translateProject({
    project,
    provider: createStubProvider({ answers: { 'a.send': 'An {device} senden' } }),
    options: {
      onlyWithFindings: true,
      findingsByKey: new Map([
        ['ru/app/a.send', [{ code: 'PLACEHOLDER_MISMATCH', detail: 'dropped {device}', locale: 'ru' }]],
      ]),
    },
  })

  assert.deepEqual(
    report.translated.map((r) => r.locale),
    ['ru'],
  )
})

test('review tells the model what was wrong with the string it is replacing', async () => {
  // Built by a real run, so the entry carries the hashes a machine-written
  // translation has. A hand-written entry with no content hash is treated as
  // human-owned on load, which is the safe direction and a different test.
  const { root, config, project } = setup({
    source: { app: { 'a.send': { message: 'Send to {device}', comment: 'Button' } } },
  })
  await run(project, { 'a.send': 'An das Gerät {device} senden, bitte sehr' })
  project.save()
  assert.match(readTranslation(root, 'de', 'app').messages['a.send'].message, /bitte sehr/)

  const reopened = loadProject(config)
  let prompt = ''
  const provider = createStubProvider({ answers: { 'a.send': 'An {device} senden' } })
  const original = provider.translateBatch.bind(provider)
  provider.translateBatch = async (args) => {
    prompt = args.user
    return original(args)
  }

  await translateProject({
    project: reopened.project,
    provider,
    options: {
      onlyWithFindings: true,
      findingsByKey: new Map([
        ['de/app/a.send', [{ code: 'TEXT_EXPANSION', detail: '220% of source width, budget is 140%', locale: 'de' }]],
      ]),
    },
  })

  assert.match(prompt, /There is already a translation/)
  assert.match(prompt, /bitte sehr/, 'the model is shown the text it is being asked to improve')
  assert.match(prompt, /TEXT_EXPANSION/)
  assert.match(prompt, /220%/)
  assert.match(prompt, /Keep the rest of the wording/)
})

test('a reasoned retranslate request is the one thing that gets past human ownership', async () => {
  const { root, config, project } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })
  await run(project, { 'a.hello': 'Hallo' })
  project.save()
  handEdit(root, 'de', 'app', 'a.hello', 'Moin')

  // Without the request, it is protected.
  const guarded = loadProject(config)
  const first = await run(guarded.project, { 'a.hello': 'Hallo zusammen' })
  assert.equal(first.report.translated.length, 0)

  // With it, and only with a reason, it is replaced, and the old text is kept.
  const { retranslateKey } = await import('@i18n-kit/core')
  const opened = loadProject(config)
  assert.throws(
    () => retranslateKey(opened.project, { namespace: 'app', key: 'a.hello', locale: 'de', reason: '', at: '2026-10-30' }),
    /needs --reason/,
  )
  retranslateKey(opened.project, {
    namespace: 'app',
    key: 'a.hello',
    locale: 'de',
    reason: 'Marketing asked for the formal greeting.',
    at: '2026-10-30',
  })
  opened.project.save()

  const reopened = loadProject(config)
  const second = await run(reopened.project, { 'a.hello': 'Hallo zusammen' })
  reopened.project.save()

  assert.equal(second.report.translated.length, 1)
  const entry = readTranslation(root, 'de', 'app').messages['a.hello']
  assert.equal(entry.message, 'Hallo zusammen')
  assert.equal(entry.history.at(-1).message, 'Moin', 'the replaced text is recoverable by copy and paste')
  assert.match(entry.history.at(-1).reason, /Marketing/)
})
