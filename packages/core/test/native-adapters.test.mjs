/**
 * Tests for the three native adapters.
 *
 * These formats are all lossier than the catalog, so the tests divide in two:
 * what each one must get RIGHT when it can express something (above all the
 * per-locale plural categories and the argument positions), and what it must
 * REFUSE when it cannot. The refusals matter as much as the output. An adapter
 * that quietly drops a `select` branch produces a file that compiles, ships,
 * and is wrong in one language.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadProject } from '../src/catalog.mjs'
import { planExport } from '../src/export.mjs'
import { capabilityFindings, ADAPTERS } from '../src/adapters/index.mjs'
import { analyze } from '../src/icu.mjs'
import { parseXml, childrenNamed } from '../src/importers/xml.mjs'
import { makeProject } from './helpers.mjs'

const TABS = '{count, plural, one {# tab} other {# tabs}}'

function emit(adapter, { messages, locales = ['de'], translations = {}, target = {}, mode = 'adopt', from = [] }) {
  const spec = {
    config: {
      locales: { required: locales, optional: [] },
      source: { mode, from },
      targets: { t: { adapter, out: 'out', ...target } },
    },
    source: { app: messages },
    translations,
  }
  const { project } = loadProject(makeProject(spec).config)
  const { plans, findings } = planExport(project)
  return { files: plans[0]?.files ?? [], findings, project }
}

const fileAt = (files, fragment) => files.find((f) => f.path.includes(fragment))

// --- Android ----------------------------------------------------------------

test('Android writes one branch per category the LOCALE needs, not per source branch', () => {
  const { files } = emit('android', {
    messages: { 'a.tabs': { message: TABS, comment: 'Count' } },
    locales: ['ru'],
    translations: {
      ru: {
        app: {
          'a.tabs': {
            message: '{count, plural, one {# вкладка} few {# вкладки} many {# вкладок} other {# вкладок}}',
            origin: 'human',
          },
        },
      },
    },
  })

  const ru = parseXml(fileAt(files, 'values-ru').contents)
  const items = childrenNamed(childrenNamed(ru.children.find((c) => c.name === 'resources'), 'plurals')[0], 'item')
  assert.deepEqual(
    items.map((i) => i.attrs.quantity),
    ['one', 'few', 'many', 'other'],
  )
})

test('Android repeats the surrounding sentence in every branch, because a quantity string is the whole string', () => {
  const { files } = emit('android', {
    messages: { 'a.send': { message: 'Send {count, plural, one {# tab} other {# tabs}} now', comment: 'x' } },
    translations: { de: { app: { 'a.send': { message: 'Jetzt {count, plural, one {# Tab} other {# Tabs}} senden', origin: 'human' } } } },
  })
  const text = fileAt(files, 'values-de').contents
  assert.match(text, /<item quantity="one">Jetzt %1\$d Tab senden<\/item>/)
  assert.match(text, /<item quantity="other">Jetzt %1\$d Tabs senden<\/item>/)
})

test('argument positions come from the source, so a reordering translation still formats right', () => {
  const { files } = emit('android', {
    // English: device then count. German puts them the other way round.
    messages: { 'a.to': { message: 'To {device}: {what}', comment: 'x' } },
    translations: { de: { app: { 'a.to': { message: '{what} an {device}', origin: 'human' } } } },
  })
  // {device} is argument 1 in the SOURCE, so it stays %1$s even though the
  // German sentence mentions it second.
  assert.match(fileAt(files, 'values-de').contents, /<string name="a_to">%2\$s an %1\$s<\/string>/)
})

test('Android keeps the resource name the import found, not a name derived from the key', () => {
  const { files } = emit('android', {
    messages: { 'app.weird_name': { message: 'x', comment: 'c', platformNames: { android: 'aWeirdName' } } },
    translations: { de: { app: { 'app.weird_name': { message: 'y', origin: 'human' } } } },
  })
  assert.match(fileAt(files, 'values-de').contents, /name="aWeirdName"/)
})

test('a comment is written into the default locale only', () => {
  const { files } = emit('android', {
    messages: { 'a.b': { message: 'x', comment: 'Why this exists' } },
    translations: { de: { app: { 'a.b': { message: 'y', origin: 'human' } } } },
  })
  assert.match(fileAt(files, 'values/').contents, /Why this exists/)
  assert.doesNotMatch(fileAt(files, 'values-de').contents, /Why this exists/)
})

test('a missing translation is omitted, so Android falls back instead of showing English twice', () => {
  const { files } = emit('android', { messages: { 'a.b': { message: 'Only English', comment: 'c' } } })
  assert.doesNotMatch(fileAt(files, 'values-de').contents, /Only English/)
})

test('in sync mode the source file is not written at all', () => {
  const { files } = emit('android', {
    messages: { 'a.b': { message: 'x', comment: 'c' } },
    mode: 'sync',
    // Sync mode means the strings come from somewhere; the path is not read
    // by export, only by import.
    from: [{ importer: 'android', path: 'res/values/strings.xml', namespace: 'app' }],
  })
  assert.equal(fileAt(files, 'values/'), undefined, 'the hand-maintained strings.xml is left alone')
  assert.ok(fileAt(files, 'values-de'))
})

test('a locale qualifier uses Android spelling, and bcp47 mode when asked', () => {
  assert.equal(ADAPTERS.android.localeTag('pt-BR', {}), 'pt-rBR')
  assert.equal(ADAPTERS.android.localeTag('de', {}), 'de')
  assert.equal(ADAPTERS.android.localeTag('zh-Hans', { options: { localeFormat: 'bcp47' } }), 'b+zh+Hans')
})

test('Android refuses what it cannot express, by name', () => {
  const codes = (message) =>
    capabilityFindings(analyze(message), ADAPTERS.android, { targetName: 't' }).map((f) => f.detail)

  assert.match(codes('{g, select, male {he} other {they}}')[0], /cannot express select/)
  assert.match(codes('{n, selectordinal, one {#st} other {#th}}')[0], /selectordinal/)
  assert.match(codes('{n, plural, offset:1 one {#} other {#}}')[0], /plural offset/)
  assert.match(codes('{n, plural, =0 {none} other {#}}')[0], /exact match/)
  assert.match(codes('<b>bold</b>')[0], /rich-text tags/)
  assert.match(codes('{when, date, short}')[0], /number or date skeleton/)
  assert.deepEqual(codes(TABS), [], 'a plain plural is fine')
})

// --- Chrome -----------------------------------------------------------------

test('Chrome gets named placeholders bound to source positions, with examples', () => {
  const { files } = emit('chrome', {
    messages: { 'a.send': { message: 'Send to {device}', comment: 'Button', placeholders: { device: { example: 'Phone' } } } },
    translations: { de: { app: { 'a.send': { message: 'An {device} senden', origin: 'human' } } } },
  })
  const doc = JSON.parse(fileAt(files, '_locales/de').contents)
  assert.equal(doc.a_send.message, 'An $DEVICE$ senden')
  assert.deepEqual(doc.a_send.placeholders, { DEVICE: { content: '$1', example: 'Phone' } })
})

test('Chrome cannot do plurals, and says so rather than shipping the other branch', () => {
  const findings = capabilityFindings(analyze(TABS), ADAPTERS.chrome, { targetName: 't' })
  assert.match(findings[0].detail, /cannot express a plural/)
})

test('Chrome will not guess a script subtag into a region', () => {
  assert.equal(ADAPTERS.chrome.localeTag('zh-Hans'), null)
  assert.equal(ADAPTERS.chrome.localeTag('pt-BR'), 'pt_BR')
  assert.equal(ADAPTERS.chrome.localeTag('de'), 'de')
})

// --- Apple ------------------------------------------------------------------

test('Apple writes every locale into one catalog, with plurals as substitutions', () => {
  const { files } = emit('apple', {
    messages: { 'a.tabs': { message: `Send ${TABS}`, comment: 'Button' } },
    locales: ['de', 'ru'],
    translations: {
      de: { app: { 'a.tabs': { message: 'Senden: {count, plural, one {# Tab} other {# Tabs}}', origin: 'human' } } },
      ru: {
        app: {
          'a.tabs': {
            message: 'Отправить {count, plural, one {# вкладку} few {# вкладки} many {# вкладок} other {# вкладок}}',
            origin: 'human',
          },
        },
      },
    },
  })

  assert.equal(files.length, 1, 'one file for every language')
  const doc = JSON.parse(files[0].contents)
  const record = doc.strings['a.tabs']

  assert.equal(record.localizations.de.stringUnit.value, 'Senden: %#@count@')
  assert.deepEqual(Object.keys(record.localizations.de.substitutions.count.variations.plural).sort(), ['one', 'other'])
  assert.deepEqual(
    Object.keys(record.localizations.ru.substitutions.count.variations.plural).sort(),
    ['few', 'many', 'one', 'other'],
    'Russian needs four, whatever order the canonical writer puts them in',
  )
  assert.equal(record.localizations.ru.substitutions.count.variations.plural.few.stringUnit.value, '%arg вкладки')
  assert.equal(record.comment, 'Button')
})

test('Apple uses %lld for a number and %@ for everything else', () => {
  const { files } = emit('apple', {
    messages: { 'a.of': { message: '{done, number} of {total, number} on {device}', comment: 'c' } },
    translations: { de: { app: { 'a.of': { message: '{done, number} von {total, number} auf {device}', origin: 'human' } } } },
  })
  const doc = JSON.parse(files[0].contents)
  assert.equal(doc.strings['a.of'].localizations.de.stringUnit.value, '%1$lld von %2$lld auf %3$@')
})

test('a locale with no translation gets no entry, so Apple falls back to the source language', () => {
  const { files } = emit('apple', { messages: { 'a.b': { message: 'Only English', comment: 'c' } } })
  const doc = JSON.parse(files[0].contents)
  assert.equal(
    doc.strings['a.b'].localizations.de,
    undefined,
    'an empty value would ship an empty string; a needs_review placeholder would look like work in progress',
  )
  assert.equal(doc.strings['a.b'].localizations.en.stringUnit.value, 'Only English')
})

// --- determinism ------------------------------------------------------------

test('every adapter renders byte-identically twice', () => {
  for (const adapter of ['android', 'chrome', 'apple', 'web']) {
    const spec = {
      messages: { 'a.b': { message: 'Hello {name}', comment: 'c' } },
      translations: { de: { app: { 'a.b': { message: 'Hallo {name}', origin: 'human' } } } },
    }
    const first = emit(adapter, spec)
    const second = emit(adapter, spec)
    assert.deepEqual(
      first.files.map((f) => f.contents),
      second.files.map((f) => f.contents),
      `${adapter} is not deterministic, which breaks the committed-artifact drift check`,
    )
  }
})
