import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadProject, CatalogError } from '../src/catalog.mjs'
import { sourceHash, contextHash, contentHash } from '../src/hash.mjs'
import { analyze, contractOf } from '../src/icu.mjs'
import { makeProject, readTranslation, handEdit } from './helpers.mjs'

const SRC = 'Send {count, plural, one {# tab} other {# tabs}} to {device}?'
const DE = '{count, plural, one {# Tab} other {# Tabs}} an {device} senden?'

const sourceEntry = (over = {}) => ({
  message: SRC,
  comment: 'Confirmation dialog title, shown before a send starts.',
  context: 'dialog-title',
  placeholders: {
    count: { type: 'number', example: 3, desc: 'Tabs queued.' },
    device: { type: 'string', example: 'Phone', desc: 'Target device.', doNotTranslate: true },
  },
  ...over,
})

/** A translation entry with hashes that match the given source entry. */
const machineTranslation = (src, message) => ({
  message,
  origin: 'machine',
  review: 'none',
  sourceHash: sourceHash(src.message, contractOf(analyze(src.message))),
  contextHash: contextHash(src),
  contentHash: contentHash(message),
  provenance: { provider: 'test', model: 'test', promptVersion: 1, at: '2026-08-17' },
})

function standard(overrides = {}) {
  const src = sourceEntry(overrides.source)
  return makeProject({
    source: { app: { 'transfer.confirm_title': src } },
    translations: { de: { app: { 'transfer.confirm_title': machineTranslation(src, overrides.de ?? DE) } } },
  })
}

// --- loading ----------------------------------------------------------------

test('loads source and translations', () => {
  const { config } = standard()
  const { project, findings } = loadProject(config)

  assert.deepEqual(project.namespaces(), ['app'])
  assert.equal([...project.entries()].length, 1)
  assert.equal(project.translationEntry('de', 'app', 'transfer.confirm_title').message, DE)
  assert.deepEqual(findings, [])
})

test('a malformed key is reported, not thrown', () => {
  const { config } = makeProject({ source: { app: { NotAKey: sourceEntry() } } })
  const { findings } = loadProject(config)
  assert.deepEqual(findings.map((f) => f.code), ['KEY_SHAPE'])
  assert.match(findings[0].detail, /two or more dot-separated segments/)
})

test('a single-segment key is rejected', () => {
  const { config } = makeProject({ source: { app: { title: sourceEntry() } } })
  assert.deepEqual(loadProject(config).findings.map((f) => f.code), ['KEY_SHAPE'])
})

test('a namespace that disagrees with its filename is reported', () => {
  const { root, config } = makeProject({ source: { app: {} } })
  const file = `${root}/i18n/source/app.json`
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.namespace = 'other'
  doc.messages = { 'a.b': sourceEntry() }
  writeFileSync(file, JSON.stringify(doc), 'utf8')

  const { findings } = loadProject(config)
  assert.ok(findings.some((f) => f.code === 'SCHEMA_INVALID' && /filename says/.test(f.detail)))
})

test('a missing source directory is a hard error, since nothing can proceed', () => {
  const { config } = makeProject({})
  assert.throws(() => loadProject(config), CatalogError)
})

// --- the safety mechanism ---------------------------------------------------

test('a hand-edited machine translation is promoted to human on load', () => {
  const { root, config } = standard()
  handEdit(root, 'de', 'app', 'transfer.confirm_title', '{count, plural, one {# Tab} other {# Tabs}} an {device} schicken?')

  const { project, findings } = loadProject(config)
  const entry = project.translationEntry('de', 'app', 'transfer.confirm_title')

  assert.equal(entry.origin, 'human')
  assert.deepEqual(project.promotions, [{ locale: 'de', namespace: 'app', key: 'transfer.confirm_title' }])
  assert.ok(findings.some((f) => f.code === 'HUMAN_EDITED'))
})

test('a purely typographic hand edit is still detected', () => {
  const { root, config } = standard({ de: "Ben's Tab senden" })
  handEdit(root, 'de', 'app', 'transfer.confirm_title', 'Ben’s Tab senden')

  const { project } = loadProject(config)
  assert.equal(project.translationEntry('de', 'app', 'transfer.confirm_title').origin, 'human')
})

test('promotion is derived, so it survives without ever being written back', () => {
  const { root, config } = standard()
  handEdit(root, 'de', 'app', 'transfer.confirm_title', 'Anderer Text mit {count} und {device}')

  // Load twice without saving. The file on disk still says origin: machine.
  assert.equal(readTranslation(root, 'de', 'app').messages['transfer.confirm_title'].origin, 'machine')
  assert.equal(loadProject(config).project.translationEntry('de', 'app', 'transfer.confirm_title').origin, 'human')
  assert.equal(loadProject(config).project.translationEntry('de', 'app', 'transfer.confirm_title').origin, 'human')
})

test('an untouched machine translation is not promoted', () => {
  const { project, findings } = loadProject(standard().config)
  assert.equal(project.translationEntry('de', 'app', 'transfer.confirm_title').origin, 'machine')
  assert.equal(project.promotions.length, 0)
  assert.equal(findings.length, 0)
})

test('setTranslation refuses to overwrite a human entry', () => {
  const { root, config } = standard()
  handEdit(root, 'de', 'app', 'transfer.confirm_title', 'Von Hand {count} {device}')
  const { project } = loadProject(config)

  assert.throws(
    () => project.setTranslation('de', 'app', 'transfer.confirm_title', { message: 'Maschine' }),
    /Refusing to overwrite the human translation/,
  )
})

test('the refusal names the audited escape hatch', () => {
  const { root, config } = standard()
  handEdit(root, 'de', 'app', 'transfer.confirm_title', 'Von Hand {count} {device}')
  const { project } = loadProject(config)
  try {
    project.setTranslation('de', 'app', 'transfer.confirm_title', { message: 'x' })
    assert.fail('expected a throw')
  } catch (err) {
    assert.match(err.message, /i18n retranslate --key transfer\.confirm_title --locale de/)
  }
})

test('approved review state survives a machine rewrite of a machine entry', () => {
  const { config } = standard()
  const { project } = loadProject(config)
  project.translationEntry('de', 'app', 'transfer.confirm_title').review = 'approved'
  project.setTranslation('de', 'app', 'transfer.confirm_title', { message: DE })
  assert.equal(project.translationEntry('de', 'app', 'transfer.confirm_title').review, 'approved')
})

// --- status -----------------------------------------------------------------

test('a matching translation reads as current', () => {
  const { project } = loadProject(standard().config)
  assert.equal(project.statusOf('de', 'app', 'transfer.confirm_title').state, 'current')
})

test('an absent translation reads as missing', () => {
  const { config } = makeProject({ source: { app: { 'a.b': sourceEntry() } } })
  assert.equal(loadProject(config).project.statusOf('de', 'app', 'a.b').state, 'missing')
})

test('a wording change with an intact contract reads as stale-text', () => {
  const src = sourceEntry()
  const { config } = makeProject({
    source: { app: { 'a.b': { ...src, message: 'Deliver {count, plural, one {# tab} other {# tabs}} to {device}?' } } },
    translations: { de: { app: { 'a.b': machineTranslation(src, DE) } } },
  })
  assert.equal(loadProject(config).project.statusOf('de', 'app', 'a.b').state, 'stale-text')
})

test('a contract change reads as stale-structural', () => {
  const src = sourceEntry()
  const { config } = makeProject({
    source: {
      app: {
        'a.b': { ...src, message: 'Send {count, plural, one {# tab} other {# tabs}} to {device} at {when}?' },
      },
    },
    translations: { de: { app: { 'a.b': machineTranslation(src, DE) } } },
  })
  const status = loadProject(config).project.statusOf('de', 'app', 'a.b')
  assert.equal(status.state, 'stale-structural')
  assert.equal(status.structurallyBroken, true)
})

test('a comment-only change reads as stale-context and nothing more', () => {
  const src = sourceEntry()
  const { config } = makeProject({
    source: { app: { 'a.b': { ...src, comment: 'Reworded comment, same string.' } } },
    translations: { de: { app: { 'a.b': machineTranslation(src, DE) } } },
  })
  assert.equal(loadProject(config).project.statusOf('de', 'app', 'a.b').state, 'stale-context')
})

test('a recorded failure reads as failed', () => {
  const src = sourceEntry()
  const failed = { ...machineTranslation(src, DE), attempt: { status: 'failed', reason: 'PLURAL_CATEGORY_MISSING', at: '2026-08-17' } }
  delete failed.message
  const { config } = makeProject({
    source: { app: { 'a.b': src } },
    translations: { de: { app: { 'a.b': failed } } },
  })
  assert.equal(loadProject(config).project.statusOf('de', 'app', 'a.b').state, 'failed')
})

test('a translation for a key the source dropped reads as orphan', () => {
  const src = sourceEntry()
  const { config } = makeProject({
    source: { app: { 'a.b': src } },
    translations: { de: { app: { 'gone.away': machineTranslation(src, DE) } } },
  })
  assert.equal(loadProject(config).project.statusOf('de', 'app', 'gone.away').state, 'orphan')
})

// --- writing ----------------------------------------------------------------

test('a failed attempt records no message, so absence stays honest', () => {
  const { root, config } = makeProject({ source: { app: { 'a.b': sourceEntry() } } })
  const { project } = loadProject(config)

  project.setFailure('de', 'app', 'a.b', { reason: 'PLURAL_CATEGORY_MISSING: many', at: '2026-08-17' })
  project.save()

  const written = readTranslation(root, 'de', 'app').messages['a.b']
  assert.equal(Object.hasOwn(written, 'message'), false)
  assert.equal(written.attempt.status, 'failed')
})

test('save is idempotent: writing an unchanged project touches nothing', () => {
  const { config } = standard()
  const { project } = loadProject(config)
  assert.deepEqual(project.save(), [])
})

test('save is deterministic regardless of insertion order', () => {
  const src = sourceEntry()
  const build = (keys) => {
    const { root, config } = makeProject({ source: { app: { 'a.one': src, 'a.two': src, 'a.three': src } } })
    const { project } = loadProject(config)
    for (const k of keys) project.setTranslation('de', 'app', k, { message: 'x {count} {device}' })
    project.save()
    return readTranslation(root, 'de', 'app')
  }
  assert.equal(
    JSON.stringify(build(['a.one', 'a.two', 'a.three'])),
    JSON.stringify(build(['a.three', 'a.one', 'a.two'])),
  )
})

test('a written translation carries hashes that make it verifiable on reload', () => {
  const { config } = makeProject({ source: { app: { 'a.b': sourceEntry() } } })
  const { project } = loadProject(config)
  project.setTranslation('de', 'app', 'a.b', { message: DE })
  project.save()

  const reloaded = loadProject(config)
  assert.equal(reloaded.project.statusOf('de', 'app', 'a.b').state, 'current')
  assert.equal(reloaded.project.translationEntry('de', 'app', 'a.b').origin, 'machine')
  assert.equal(reloaded.project.promotions.length, 0)
})
