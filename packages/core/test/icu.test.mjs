import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, contractOf, structuralFindings, compareStructure, IcuError } from '../src/icu.mjs'
import { checkCoverage } from '../src/plurals.mjs'
import { severityOf } from '../src/rules.mjs'

const codes = (findings) => findings.map((f) => f.code)

test('argOrder follows first appearance, depth first', () => {
  const a = analyze('Send {count, plural, one {# tab to {device}} other {# tabs to {device}}} at {when}')
  assert.deepEqual(a.argOrder, ['count', 'device', 'when'])
})

test('records how each argument is used, not how it was declared', () => {
  const a = analyze('{n, plural, other {#}} {s} {d, date, short} {t, time} {c, select, other {x}}')
  assert.deepEqual([...a.args.get('n').kinds], ['plural'])
  assert.deepEqual([...a.args.get('s').kinds], ['string'])
  assert.deepEqual([...a.args.get('d').kinds], ['date'])
  assert.deepEqual([...a.args.get('t').kinds], ['time'])
  assert.deepEqual([...a.args.get('c').kinds], ['select'])
})

test('detects repeated placeholders', () => {
  assert.deepEqual(analyze('{a} and {a} and {b}').constructs.repeated, ['a'])
})

test('distinguishes selectordinal from plural', () => {
  const a = analyze('{n, selectordinal, one {#st} other {#th}}')
  assert.equal(a.constructs.hasSelectOrdinal, true)
  assert.equal(a.constructs.hasPlural, false)
  assert.equal(a.plurals[0].pluralType, 'ordinal')
})

test('captures offset and exact matches', () => {
  const a = analyze('{n, plural, offset:1 =0 {none} one {# other} other {# others}}')
  assert.equal(a.constructs.hasOffset, true)
  assert.equal(a.constructs.hasExactMatch, true)
  assert.deepEqual(a.plurals[0].exact, ['=0'])
  assert.deepEqual(a.plurals[0].categories, ['one', 'other'])
})

test('measures nesting depth', () => {
  assert.equal(analyze('flat {a}').constructs.maxDepth, 1)
  assert.equal(analyze('{n, plural, other {{m, plural, other {deep}}}}').constructs.maxDepth, 3)
})

test('collects rich-text tags and their contents', () => {
  const a = analyze('Read the <link>terms</link> and <b>{name}</b>')
  assert.deepEqual(a.tags, ['b', 'link'])
  assert.ok(a.args.has('name'))
  // A tag is a rendering hook, not a substituted value, so it must not appear
  // as an argument. Otherwise one lost <link> reports as two separate faults.
  assert.equal(a.args.has('link'), false)
})

// --- the silent bug this toolkit exists to catch ---------------------------

test('catches a placeholder swallowed by an ICU apostrophe', () => {
  const text = "l'{name} chien"
  const a = analyze(text)
  assert.equal(a.args.size, 0, 'the parser really does lose it')
  const found = structuralFindings(text, a)
  assert.deepEqual(codes(found), ['ICU_APOSTROPHE_EATS_ARG'])
  assert.match(found[0].detail, /typographic apostrophe/)
})

test('the typographic apostrophe does not swallow the placeholder', () => {
  const text = 'l’{name} chien'
  const a = analyze(text)
  assert.deepEqual(a.argOrder, ['name'])
  assert.deepEqual(structuralFindings(text, a), [])
})

test('a doubled apostrophe escapes correctly and keeps the placeholder', () => {
  const text = "it''s {n}"
  const a = analyze(text)
  assert.deepEqual(a.argOrder, ['n'])
  assert.deepEqual(structuralFindings(text, a), [])
})

test('a plural with no other branch is rejected by the parser, reported as its own rule', () => {
  // The parser refuses this before analysis can see it, so parseMessage maps
  // the parser's error kind to the specific rule rather than a generic
  // "did not parse".
  try {
    analyze('{n, plural, one {# tab}}')
    assert.fail('expected a throw')
  } catch (err) {
    assert.ok(err instanceof IcuError)
    assert.equal(err.code, 'PLURAL_OTHER_MISSING')
    assert.match(err.message, /requires an "other" branch/)
  }
})

test('a parse error carries a position and a plain-language hint', () => {
  try {
    analyze('Send {device to me')
    assert.fail('expected a throw')
  } catch (err) {
    assert.equal(err.code, 'ICU_PARSE')
    assert.match(err.message, /offset \d+/)
  }
})

test('flags nesting past the supported depth', () => {
  const text = '{a, plural, other {{b, plural, other {{c, plural, other {{d, select, other {x}}}}}}}}'
  assert.ok(codes(structuralFindings(text, analyze(text))).includes('NESTING_TOO_DEEP'))
})

// --- contract ---------------------------------------------------------------

test('contract is stable across whitespace and branch order', () => {
  const a = contractOf(analyze('{n, plural, one {# tab} other {# tabs}}'))
  const b = contractOf(analyze('{n, plural,  other {# tabs}  one {# tab} }'))
  assert.equal(a, b)
})

test('contract changes when the argument contract changes', () => {
  const before = contractOf(analyze('Send to {device}'))
  const after = contractOf(analyze('Send to {device} at {when}'))
  assert.notEqual(before, after)
})

test('contract is unchanged by a pure wording edit', () => {
  const before = contractOf(analyze('Send to {device}'))
  const after = contractOf(analyze('Deliver to {device}'))
  assert.equal(before, after)
})

// --- source vs translation --------------------------------------------------

const src = analyze('Send {count, plural, one {# tab} other {# tabs}} to {device}?')

test('accepts a correct translation', () => {
  const de = analyze('{count, plural, one {# Tab} other {# Tabs}} an {device} senden?')
  assert.deepEqual(compareStructure(src, de), [])
})

test('catches a dropped placeholder', () => {
  const bad = analyze('{count, plural, one {# Tab} other {# Tabs}} senden?')
  assert.deepEqual(codes(compareStructure(src, bad)), ['PLACEHOLDER_MISMATCH'])
})

test('catches an invented placeholder', () => {
  const bad = analyze('{count, plural, one {# Tab} other {# Tabs}} an {device} um {zeit} senden?')
  const found = compareStructure(src, bad)
  assert.deepEqual(codes(found), ['PLACEHOLDER_MISMATCH'])
  assert.match(found[0].detail, /introduced \{zeit\}/)
})

test('catches a plural flattened to a bare placeholder', () => {
  const bad = analyze('{count} Tabs an {device} senden?')
  assert.deepEqual(codes(compareStructure(src, bad)), ['PLURAL_STRUCTURE_MISMATCH'])
})

test('catches a plural type change', () => {
  const ordinalSrc = analyze('{n, selectordinal, one {#st} other {#th}}')
  const cardinal = analyze('{n, plural, one {#.} other {#.}}')
  assert.deepEqual(codes(compareStructure(ordinalSrc, cardinal)), ['PLURAL_STRUCTURE_MISMATCH'])
})

test('catches a dropped offset', () => {
  const withOffset = analyze('{n, plural, offset:1 one {# other} other {# others}}')
  const without = analyze('{n, plural, one {# andere} other {# andere}}')
  assert.deepEqual(codes(compareStructure(withOffset, without)), ['PLURAL_STRUCTURE_MISMATCH'])
})

test('catches changed select branches', () => {
  const a = analyze('{g, select, male {he} female {she} other {they}}')
  const b = analyze('{g, select, male {er} other {sie}}')
  assert.deepEqual(codes(compareStructure(a, b)), ['PLURAL_STRUCTURE_MISMATCH'])
})

test('catches a lost rich-text tag', () => {
  const a = analyze('Read the <link>terms</link>')
  const b = analyze('Lies die Bedingungen')
  assert.deepEqual(codes(compareStructure(a, b)), ['TAG_MISMATCH'])
})

test('a reordered translation is fine as long as the set matches', () => {
  const a = analyze('Send {what} to {device}')
  const ja = analyze('{device}に{what}を送信')
  assert.deepEqual(compareStructure(a, ja), [])
  // argOrder still comes from the source, which is what keeps positional
  // adapters from scrambling arguments in reordering languages.
  assert.deepEqual(a.argOrder, ['what', 'device'])
  assert.deepEqual(ja.argOrder, ['device', 'what'])
})

test('a one-word plural branch is structure, not a swallowed placeholder', () => {
  const text = 'Open Tabsend to send {count, plural, one {it} other {them}} to another device.'
  assert.deepEqual(structuralFindings(text, analyze(text)), [])
})

test('a one-word select branch is structure too', () => {
  const text = '{platform, select, macos {Mac} android {Android} other {This device}}'
  assert.deepEqual(structuralFindings(text, analyze(text)), [])
})

test('a placeholder an apostrophe really did eat is still caught', () => {
  const text = "l'{name} a envoyé"
  const findings = structuralFindings(text, analyze(text))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'ICU_APOSTROPHE_EATS_ARG')
  assert.match(findings[0].detail, /\{name\}/)
  assert.match(findings[0].detail, /U\+2019/)
})

test('with tags off, angle brackets are ordinary characters', () => {
  // Tabsend's own convention: <browser>…</browser> is a tag its DOM layer
  // resolves, and <LAN-IP> is literal text. Read as ICU rich text, the
  // hyphenated name opens a tag that never closes.
  const text = 'use <browser>http://<LAN-IP>:8786</browser> for that'
  assert.throws(() => analyze(text), IcuError)
  const analysis = analyze(text, { ignoreTag: true })
  assert.deepEqual(analysis.tags, [])
  assert.deepEqual(structuralFindings(text, analysis), [])
})

test('with tags on, rich text is still parsed as rich text', () => {
  assert.deepEqual(analyze('see <link>the docs</link>').tags, ['link'])
  assert.deepEqual(analyze('see <link>the docs</link>', { ignoreTag: true }).tags, [])
})

test('an "other"-only plural in the source is a note, not an error', () => {
  const analysis = analyze('{count, plural, other {#d ago}}')
  const findings = checkCoverage('en', analysis, { isSource: true })
  assert.deepEqual(findings.map((f) => f.code), ['PLURAL_UNINFLECTED'])
  assert.equal(severityOf('PLURAL_UNINFLECTED'), 'info')
})

test('an uninflected source stays uninflected in a four-form language', () => {
  const source = analyze('{count, plural, other {#d ago}}')
  const ru = analyze('{count, plural, other {# д назад}}')
  assert.deepEqual(
    checkCoverage('ru', ru, { sourceAnalysis: source }).map((f) => f.code),
    ['PLURAL_UNINFLECTED'],
  )
})

test('collapsing an inflected source to "other" is still an error', () => {
  const source = analyze('{count, plural, one {# tab} other {# tabs}}')
  const ru = analyze('{count, plural, other {# вкладок}}')
  const codes = checkCoverage('ru', ru, { sourceAnalysis: source }).map((f) => f.code)
  assert.ok(codes.includes('PLURAL_CATEGORY_MISSING'))
  assert.equal(severityOf('PLURAL_CATEGORY_MISSING'), 'error')
})

test('a Russian translation missing few and many is still an error', () => {
  const source = analyze('{count, plural, one {# tab} other {# tabs}}')
  const ru = analyze('{count, plural, one {# вкладка} other {# вкладок}}')
  const findings = checkCoverage('ru', ru, { sourceAnalysis: source })
  assert.deepEqual(findings.map((f) => f.code), ['PLURAL_CATEGORY_MISSING'])
  assert.match(findings[0].detail, /missing few, many/)
})
