/**
 * Handoff and ingest: the same pipeline with an agent where the provider was.
 *
 * The thing these tests exist to pin down is that the agent path is not the
 * lenient path. `ingest` runs the same validator the paid engine runs, so a
 * Russian plural written with English's two branches is rejected whoever wrote
 * it. If that ever stopped being true, the free route would quietly become the
 * route that ships broken translations.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadProject } from '@i18n-kit/core'
import { writeHandoff, ingestAnswers, PROMPT_VERSION } from '../src/handoff.mjs'
import { makeProject, readTranslation, handEdit } from '../../core/test/helpers.mjs'

const TABS = '{count, plural, one {# tab selected} other {# tabs selected}}'

function setup(spec) {
  const { root, config } = makeProject(spec)
  const { project } = loadProject(config)
  return { root, config, project, dir: join(root, 'i18n', 'handoff') }
}

/** Fill in the answer files the way an agent reading the brief would. */
function answer(dir, locale, answers) {
  const localeDir = join(dir, locale)
  for (const name of readdirSync(localeDir)) {
    if (!name.endsWith('.answers.json')) continue
    const path = join(localeDir, name)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    for (const key of Object.keys(doc.answers)) {
      if (key in answers) doc.answers[key] = answers[key]
    }
    writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8')
  }
}

test('handoff writes a brief and an answer template per batch', () => {
  const { config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  const result = writeHandoff({ project, config, dir })

  assert.equal(result.locales.length, 1)
  assert.equal(result.locales[0].items, 1)
  assert.ok(existsSync(join(dir, 'de', 'README.md')))

  const files = readdirSync(join(dir, 'de'))
  const brief = files.find((f) => f.endsWith('.md') && f !== 'README.md')
  const template = files.find((f) => f.endsWith('.answers.json'))
  assert.ok(brief, 'a brief for the agent to read')
  assert.ok(template, 'a file for the agent to write into')

  // The brief has to carry the comment, or the agent is guessing at what the
  // string is for, which is the whole reason comments are mandatory.
  assert.match(readFileSync(join(dir, 'de', brief), 'utf8'), /Greeting/)

  const doc = JSON.parse(readFileSync(join(dir, 'de', template), 'utf8'))
  assert.equal(doc.answers['a.hello'].message, null)
  assert.equal(doc.promptVersion, PROMPT_VERSION)
})

test('the brief states the plural categories the target language needs', () => {
  const { config, project, dir } = setup({
    config: { locales: { required: ['ru'], optional: [] } },
    source: { app: { 'a.tabs': { message: TABS, comment: 'Selection count' } } },
  })

  writeHandoff({ project, config, dir })
  const localeDir = join(dir, 'ru')
  const brief = readdirSync(localeDir).find((f) => f.startsWith('batch-') && f.endsWith('.md'))
  const text = readFileSync(join(localeDir, brief), 'utf8')

  // Without this line an agent mirrors English's two branches, which is the
  // single most common machine-translation defect in an inflecting language.
  assert.match(text, /ru needs one, few, many, other/)
})

test('ingest writes what passes and records it as agent-written', () => {
  const { root, config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'de', { 'a.hello': { message: 'Hallo', note: null } })

  const out = ingestAnswers({ project, config, locale: 'de', dir, model: 'claude-opus-5' })
  project.save()

  assert.equal(out.accepted.length, 1)
  assert.equal(out.rejected.length, 0)

  const entry = readTranslation(root, 'de', 'app').messages['a.hello']
  assert.equal(entry.message, 'Hallo')
  assert.equal(entry.origin, 'machine')
  assert.equal(entry.provenance.kind, 'agent')
  assert.equal(entry.provenance.model, 'claude-opus-5')
  assert.ok(entry.contentHash, 'the content hash is what makes a later hand edit detectable')
})

test('an agent gets no easier ride than a provider: a dropped placeholder is rejected', () => {
  const { root, config, project, dir } = setup({
    source: { app: { 'a.send': { message: 'Send to {device}', comment: 'Button' } } },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'de', { 'a.send': { message: 'An das Gerät senden', note: null } })

  const out = ingestAnswers({ project, config, locale: 'de', dir })
  project.save()

  assert.equal(out.accepted.length, 0)
  assert.equal(out.rejected.length, 1)
  assert.ok(out.rejected[0].codes.includes('PLACEHOLDER_MISMATCH'))
  // The correction has to name the placeholder, or the agent cannot fix it.
  assert.match(out.rejected[0].correction, /\{device\}/)
  assert.equal(existsSync(join(root, 'i18n', 'translations', 'de', 'app.json')), false)
})

test('a Russian plural with English\'s two branches is rejected', () => {
  const { config, project, dir } = setup({
    config: { locales: { required: ['ru'], optional: [] } },
    source: { app: { 'a.tabs': { message: TABS, comment: 'Selection count' } } },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'ru', {
    'a.tabs': { message: '{count, plural, one {Выбрана # вкладка} other {Выбрано # вкладки}}', note: null },
  })

  const out = ingestAnswers({ project, config, locale: 'ru', dir })

  assert.equal(out.rejected.length, 1)
  assert.ok(out.rejected[0].codes.includes('PLURAL_CATEGORY_MISSING'))
  assert.match(out.rejected[0].correction, /few/)
  assert.match(out.rejected[0].correction, /many/)
})

test('a correction is accepted on re-ingest, and what already passed is not called stale', () => {
  const { config, project, dir } = setup({
    source: {
      app: {
        'a.hello': { message: 'Hello', comment: 'Greeting' },
        'a.send': { message: 'Send to {device}', comment: 'Button' },
      },
    },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'de', {
    'a.hello': { message: 'Hallo', note: null },
    'a.send': { message: 'An das Gerät senden', note: null },
  })

  const first = ingestAnswers({ project, config, locale: 'de', dir })
  assert.equal(first.accepted.length, 1)
  assert.equal(first.rejected.length, 1)

  answer(dir, 'de', { 'a.send': { message: 'An {device} senden', note: null } })
  const second = ingestAnswers({ project, config, locale: 'de', dir })

  assert.equal(second.accepted.length, 1)
  assert.equal(second.rejected.length, 0)
  // The one that passed the first time must not come back as a scary warning
  // that the source changed. Re-ingesting after a fix is the normal case.
  assert.equal(second.stale.length, 0)
  assert.deepEqual(
    second.done.map((d) => d.key),
    ['a.hello'],
  )
})

test('a blank answer stays missing rather than being filled with anything', () => {
  const { root, config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'de', { 'a.hello': { message: null, note: null } })

  const out = ingestAnswers({ project, config, locale: 'de', dir })

  assert.equal(out.blank.length, 1)
  assert.equal(out.accepted.length, 0)
  assert.equal(existsSync(join(root, 'i18n', 'translations', 'de', 'app.json')), false)
})

test('a malformed note is dropped and the translation is still kept', () => {
  const { root, config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'de', { 'a.hello': { message: 'Hallo', note: 'just some prose' } })

  const out = ingestAnswers({ project, config, locale: 'de', dir })
  project.save()

  assert.equal(out.accepted.length, 1, 'commentary must never block the deliverable')
  assert.equal(out.dropped.length, 1)
  assert.equal(readTranslation(root, 'de', 'app').messages['a.hello'].note, null)
})

test('a well-formed note is kept', () => {
  const { root, config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  writeHandoff({ project, config, dir })
  answer(dir, 'de', {
    'a.hello': { message: 'Hallo', note: { kind: 'ambiguous', text: 'Could be a greeting or a verb.' } },
  })

  const out = ingestAnswers({ project, config, locale: 'de', dir })
  project.save()

  assert.equal(out.dropped.length, 0)
  assert.equal(out.notes.length, 1)
  assert.equal(readTranslation(root, 'de', 'app').messages['a.hello'].note.kind, 'ambiguous')
})

test('handoff applies translation memory itself, so an agent is not asked twice', () => {
  const first = setup({
    source: {
      app: {
        'a.open': { message: 'Open all', comment: 'Button in the notification' },
        'b.open': { message: 'Open all', comment: 'Button in the inbox' },
      },
    },
  })

  // Settle the first string through the agent path, then make it human-owned
  // the way a reviewer touching the file would.
  writeHandoff({ project: first.project, config: first.config, dir: first.dir, options: { keys: ['a.open'] } })
  answer(first.dir, 'de', { 'a.open': { message: 'Alle öffnen', note: null } })
  ingestAnswers({ project: first.project, config: first.config, locale: 'de', dir: first.dir })
  first.project.save()
  handEdit(first.root, 'de', 'app', 'a.open', 'Alle öffnen!')

  const reloaded = loadProject(first.config)
  const result = writeHandoff({ project: reloaded.project, config: first.config, dir: first.dir })

  // The settled wording is reused at no cost, and the brief is empty: there is
  // nothing left to ask an agent about.
  assert.equal(result.reused.length, 1)
  assert.equal(result.reused[0].key, 'b.open')
  assert.equal(result.reused[0].message, 'Alle öffnen!', 'the settled wording, not a second opinion')
  assert.equal(result.locales[0].items, 0)
})

test('a second handoff clears the previous briefs', () => {
  const { config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  writeHandoff({ project, config, dir })
  const stale = join(dir, 'de', 'batch-99-gone.answers.json')
  writeFileSync(stale, JSON.stringify({ answers: { 'a.gone': { message: 'x' } } }), 'utf8')
  // A file that is not ours is left alone: the directory is somewhere a person
  // may reasonably keep notes.
  const mine = join(dir, 'de', 'notes.txt')
  writeFileSync(mine, 'my own notes', 'utf8')

  writeHandoff({ project, config, dir })

  assert.equal(existsSync(stale), false, 'a stale brief would be ingested as if it were current')
  assert.equal(existsSync(mine), true)
})

test('ingest says so when the brief exists but nothing was filled in', () => {
  const { config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  writeHandoff({ project, config, dir })
  const out = ingestAnswers({ project, config, locale: 'de', dir })

  assert.equal(out.accepted.length, 0)
  assert.equal(out.blank.length, 1)
})

test('ingest refuses a locale that was never handed off', () => {
  const { config, project, dir } = setup({
    source: { app: { 'a.hello': { message: 'Hello', comment: 'Greeting' } } },
  })

  const out = ingestAnswers({ project, config, locale: 'fr', dir })

  assert.match(out.error, /No handoff for fr/)
})
