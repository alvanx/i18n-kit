import test from 'node:test'
import assert from 'node:assert/strict'
import { loadProject } from '../src/catalog.mjs'
import { addKey, renameKey, deprecateKey, removeKey, touchKey, normalizeProject, KeyError } from '../src/keys.mjs'
import { sourceHash, contextHash, contentHash } from '../src/hash.mjs'
import { analyze, contractOf } from '../src/icu.mjs'
import { makeProject, readTranslation, handEdit } from './helpers.mjs'

const src = (over = {}) => ({ message: 'Save', comment: 'Toolbar button.', ...over })

const translated = (s, message, over = {}) => ({
  message,
  origin: 'machine',
  review: 'none',
  sourceHash: sourceHash(s.message, contractOf(analyze(s.message))),
  contextHash: contextHash(s),
  contentHash: contentHash(message),
  ...over,
})

function open(spec) {
  const made = makeProject(spec)
  return { ...made, ...loadProject(made.config) }
}

// --- add --------------------------------------------------------------------

test('adds a key', () => {
  const p = open({ source: { app: { 'a.b': src() } } })
  addKey(p.project, { namespace: 'app', key: 'nav.close', message: 'Close', comment: 'Dismisses the sheet.' })
  assert.equal(p.project.sourceEntry('app', 'nav.close').message, 'Close')
})

test('refuses a key with no comment', () => {
  const p = open({ source: { app: { 'a.b': src() } } })
  assert.throws(
    () => addKey(p.project, { namespace: 'app', key: 'nav.close', message: 'Close' }),
    /needs a comment/,
  )
})

test('refuses a malformed key and says what the grammar is for', () => {
  const p = open({ source: { app: { 'a.b': src() } } })
  try {
    addKey(p.project, { namespace: 'app', key: 'Close', message: 'Close', comment: 'x' })
    assert.fail('expected a throw')
  } catch (err) {
    assert.ok(err instanceof KeyError)
    assert.match(err.message, /Android and Chrome resource names/)
  }
})

test('refuses a duplicate key', () => {
  const p = open({ source: { app: { 'a.b': src() } } })
  assert.throws(() => addKey(p.project, { namespace: 'app', key: 'a.b', message: 'x', comment: 'y' }), /already exists/)
})

test('refuses invalid ICU before writing anything', () => {
  const p = open({ source: { app: { 'a.b': src() } } })
  assert.throws(() =>
    addKey(p.project, { namespace: 'app', key: 'a.c', message: '{n, plural, one {# x}}', comment: 'y' }),
  )
  assert.equal(p.project.sourceEntry('app', 'a.c'), undefined, 'nothing should have been written')
})

// --- the reuse trap ---------------------------------------------------------

test('refuses to reuse a key that still has translations from a previous life', () => {
  const s = src()
  const p = open({
    source: { app: { 'a.live': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern') } } },
  })

  try {
    addKey(p.project, { namespace: 'app', key: 'nav.save', message: 'Send', comment: 'A different button now.' })
    assert.fail('expected a throw')
  } catch (err) {
    assert.match(err.message, /previous life/)
    assert.match(err.message, /--reuse-key/)
  }
})

test('--reuse-key drops the inherited translations and says which', () => {
  const s = src()
  const p = open({
    source: { app: { 'a.live': s } },
    translations: {
      de: { app: { 'nav.save': translated(s, 'Speichern') } },
    },
  })

  const result = addKey(p.project, {
    namespace: 'app',
    key: 'nav.save',
    message: 'Send',
    comment: 'A different button now.',
    reuseKey: true,
  })

  assert.deepEqual(result.droppedTranslations, ['de'])
  assert.equal(p.project.translationEntry('de', 'app', 'nav.save'), undefined)
})

// --- rename -----------------------------------------------------------------

test('rename carries translations with origin and hashes intact', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern', { origin: 'human', review: 'approved' }) } } },
  })

  const before = { ...p.project.translationEntry('de', 'app', 'nav.save') }
  const result = renameKey(p.project, { namespace: 'app', from: 'nav.save', to: 'toolbar.save' })

  assert.deepEqual(result.movedLocales, ['de'])
  const after = p.project.translationEntry('de', 'app', 'toolbar.save')
  assert.deepEqual(after, before)
  assert.equal(p.project.translationEntry('de', 'app', 'nav.save'), undefined)
})

test('a renamed key is still current, because a rename changes no text', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern') } } },
  })
  renameKey(p.project, { namespace: 'app', from: 'nav.save', to: 'toolbar.save' })
  p.project.save()

  const reloaded = loadProject(p.config).project
  assert.equal(reloaded.statusOf('de', 'app', 'toolbar.save').state, 'current')
})

test('rename refuses a destination that already has translations', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'old.save': translated(s, 'Speichern') } } },
  })
  assert.throws(
    () => renameKey(p.project, { namespace: 'app', from: 'nav.save', to: 'old.save' }),
    /already has translations/,
  )
})

// --- deprecate and remove ---------------------------------------------------

test('deprecating keeps translations but drops the key from export', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern') } } },
  })

  deprecateKey(p.project, { namespace: 'app', key: 'nav.save', since: '2026-08-17', reason: 'Replaced by toolbar.save' })
  assert.equal(p.project.sourceEntry('app', 'nav.save').deprecated.since, '2026-08-17')
  assert.equal(p.project.translationEntry('de', 'app', 'nav.save').message, 'Speichern')
})

test('removing a key that was never deprecated is refused', () => {
  const p = open({ source: { app: { 'nav.save': src() } } })
  try {
    removeKey(p.project, { namespace: 'app', key: 'nav.save', today: '2026-08-17' })
    assert.fail('expected a throw')
  } catch (err) {
    assert.match(err.message, /shipped clients still reference it/)
  }
})

test('removing before the removeAfter date is refused', () => {
  const p = open({ source: { app: { 'nav.save': src() } } })
  deprecateKey(p.project, { namespace: 'app', key: 'nav.save', since: '2026-08-01', removeAfter: '2026-12-01' })
  assert.throws(
    () => removeKey(p.project, { namespace: 'app', key: 'nav.save', today: '2026-08-17' }),
    /not removable until 2026-12-01/,
  )
})

test('removing after the window clears every translation', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern') } } },
  })
  deprecateKey(p.project, { namespace: 'app', key: 'nav.save', since: '2026-01-01', removeAfter: '2026-02-01' })

  const result = removeKey(p.project, { namespace: 'app', key: 'nav.save', today: '2026-08-17' })
  assert.deepEqual(result.clearedLocales, ['de'])
  assert.equal(p.project.sourceEntry('app', 'nav.save'), undefined)
})

test('--force skips the deprecation window', () => {
  const p = open({ source: { app: { 'nav.save': src() } } })
  removeKey(p.project, { namespace: 'app', key: 'nav.save', force: true, today: '2026-08-17' })
  assert.equal(p.project.sourceEntry('app', 'nav.save'), undefined)
})

// --- touch ------------------------------------------------------------------

test('touch blesses a stale translation without retranslating it', () => {
  const oldSource = src()
  const p = open({
    // The source gained a full stop. Nothing about the German needs to change.
    source: { app: { 'nav.save': src({ message: 'Save.' }) } },
    translations: { de: { app: { 'nav.save': translated(oldSource, 'Speichern') } } },
  })

  assert.equal(p.project.statusOf('de', 'app', 'nav.save').state, 'stale-text')

  touchKey(p.project, { namespace: 'app', key: 'nav.save', locale: 'de', reason: 'punctuation only' })
  assert.equal(p.project.statusOf('de', 'app', 'nav.save').state, 'current')
  assert.equal(p.project.translationEntry('de', 'app', 'nav.save').message, 'Speichern')
})

test('touch refuses when there is no text to bless', () => {
  const s = src()
  const failed = translated(s, 'x', { attempt: { status: 'failed', reason: 'x', at: '2026-08-17' } })
  delete failed.message
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': failed } } },
  })
  assert.throws(() => touchKey(p.project, { namespace: 'app', key: 'nav.save', locale: 'de' }), /nothing to bless/)
})

// --- normalize --------------------------------------------------------------

test('normalize records a hand-merged translation as human-owned', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern') } } },
  })
  handEdit(p.root, 'de', 'app', 'nav.save', 'Sichern')

  const reloaded = loadProject(p.config).project
  const result = normalizeProject(reloaded)

  assert.deepEqual(result.promoted, [{ locale: 'de', namespace: 'app', key: 'nav.save' }])
  const written = readTranslation(p.root, 'de', 'app').messages['nav.save']
  assert.equal(written.origin, 'human')
  assert.equal(written.message, 'Sichern')
})

test('normalize on a clean project promotes nothing', () => {
  const s = src()
  const p = open({
    source: { app: { 'nav.save': s } },
    translations: { de: { app: { 'nav.save': translated(s, 'Speichern') } } },
  })
  assert.deepEqual(normalizeProject(p.project).promoted, [])
})
