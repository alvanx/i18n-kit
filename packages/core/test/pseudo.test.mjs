import test from 'node:test'
import assert from 'node:assert/strict'
import { pseudoMessage, generatePseudoLocale, PSEUDO_LOCALES } from '../src/pseudo.mjs'
import { analyze, compareStructure } from '../src/icu.mjs'
import { displayWidth } from '../src/text.mjs'
import { loadProject } from '../src/catalog.mjs'
import { makeProject } from './helpers.mjs'

/** The property that matters: a pseudo message must still be the same message, structurally. */
function assertStructurePreserved(source, locale) {
  const pseudo = pseudoMessage(source, locale)
  assert.deepEqual(
    compareStructure(analyze(source), analyze(pseudo)),
    [],
    `structure changed for ${locale}: ${pseudo}`,
  )
  return pseudo
}

test('both pseudo-locales are declared with a purpose', () => {
  assert.deepEqual(Object.keys(PSEUDO_LOCALES), ['en-XA', 'ar-XB'])
  for (const spec of Object.values(PSEUDO_LOCALES)) {
    assert.ok(spec.description.length > 0)
  }
})

test('the expansion locale accents and pads', () => {
  const pseudo = pseudoMessage('Send tab', 'en-XA')
  assert.match(pseudo, /^⟦/)
  assert.match(pseudo, /⟧$/)
  assert.ok(displayWidth(pseudo) > displayWidth('Send tab') * 1.3)
  assert.ok(!/[aeiou]/.test(pseudo.replace(/[⟦⟧·\s]/g, '')), 'vowels should be accented')
})

test('brackets make a hardcoded string obvious on screen', () => {
  // Anything rendered without the brackets did not come from the catalog.
  assert.ok(pseudoMessage('Save', 'en-XA').startsWith('⟦'))
})

test('placeholders survive both pseudo-locales untouched', () => {
  for (const locale of Object.keys(PSEUDO_LOCALES)) {
    const pseudo = assertStructurePreserved('Send {count} tabs to {device}', locale)
    assert.match(pseudo, /\{count\}/)
    assert.match(pseudo, /\{device\}/)
  }
})

test('plurals keep every branch and category', () => {
  for (const locale of Object.keys(PSEUDO_LOCALES)) {
    const pseudo = assertStructurePreserved('{n, plural, one {# tab} other {# tabs}}', locale)
    assert.match(pseudo, /one \{/)
    assert.match(pseudo, /other \{/)
    assert.match(pseudo, /#/)
  }
})

test('offsets, exact matches, selectordinal, and select all round-trip', () => {
  const cases = [
    '{n, plural, offset:1 =0 {none} one {# other} other {# others}}',
    '{n, selectordinal, one {#st} other {#th}}',
    '{g, select, male {he} female {she} other {they}}',
  ]
  for (const source of cases) {
    for (const locale of Object.keys(PSEUDO_LOCALES)) {
      assertStructurePreserved(source, locale)
    }
  }
})

test('rich-text tags survive with their nesting intact', () => {
  for (const locale of Object.keys(PSEUDO_LOCALES)) {
    const pseudo = assertStructurePreserved('Read the <link>terms</link> now', locale)
    assert.match(pseudo, /<link>/)
    assert.match(pseudo, /<\/link>/)
  }
})

test('nested plurals survive', () => {
  for (const locale of Object.keys(PSEUDO_LOCALES)) {
    assertStructurePreserved('{a, plural, other {{b, plural, other {deep text}}}}', locale)
  }
})

test('date and number arguments keep their style', () => {
  for (const locale of Object.keys(PSEUDO_LOCALES)) {
    const pseudo = assertStructurePreserved('at {when, date, short} and {n, number}', locale)
    assert.match(pseudo, /\{when, date, short\}/)
  }
})

test('the bidi locale marks direction without mangling Latin text', () => {
  const pseudo = pseudoMessage('Send tab', 'ar-XB')
  assert.ok(pseudo.includes('⁧'), 'should open a right-to-left isolate')
  assert.ok(pseudo.includes('⁩'), 'should close the isolate')
  assert.match(pseudo, /Send tab/, 'the words stay readable so a reviewer can still use the app')
})

test('the bidi locale does not pad, because length is not what it tests', () => {
  const source = 'Send tab'
  const pseudo = pseudoMessage(source, 'ar-XB')
  assert.ok(!pseudo.includes('·'))
})

test('an unknown pseudo-locale is rejected by name', () => {
  assert.throws(() => pseudoMessage('x', 'de-XX'), /Unknown pseudo-locale/)
})

// --- whole-catalog generation ----------------------------------------------

test('generates a full locale and skips deprecated keys', () => {
  const made = makeProject({
    source: {
      app: {
        'a.live': { message: 'Send tab', comment: 'x' },
        'a.old': { message: 'Old', comment: 'x', deprecated: { since: '2026-01-01' } },
      },
    },
  })
  const { project } = loadProject(made.config)
  const result = generatePseudoLocale(project, 'en-XA')

  assert.deepEqual(Object.keys(result.messages), ['a.live'])
  assert.equal(result.skipped.length, 0)
})

test('an unparseable message is skipped rather than failing the whole run', () => {
  const made = makeProject({
    source: {
      app: {
        'a.good': { message: 'Fine', comment: 'x' },
        'a.bad': { message: '{n, plural, one {# tab}}', comment: 'x' },
      },
    },
  })
  const { project } = loadProject(made.config)
  const result = generatePseudoLocale(project, 'en-XA')

  assert.deepEqual(Object.keys(result.messages), ['a.good'])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].key, 'a.bad')
})
