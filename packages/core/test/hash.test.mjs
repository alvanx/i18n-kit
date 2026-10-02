import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceHash, contextHash, contentHash, wasHumanEdited, stalenessOf } from '../src/hash.mjs'
import { analyze, contractOf, compareStructure } from '../src/icu.mjs'
import { normalize, displayWidth, graphemeCount, measure } from '../src/text.mjs'

const hashOf = (text) => sourceHash(text, contractOf(analyze(text)))

// --- normalization ----------------------------------------------------------

test('normalize folds typography that never changes meaning', () => {
  assert.equal(normalize('it’s'), "it's")
  assert.equal(normalize('“quoted”'), '"quoted"')
  assert.equal(normalize('a – b'), 'a - b')
  assert.equal(normalize('wait…'), 'wait...')
})

test('normalize collapses whitespace and every exotic space', () => {
  assert.equal(normalize('a b'), 'a b')
  assert.equal(normalize('a b'), 'a b')
  assert.equal(normalize('  a   b  '), 'a b')
})

test('normalize unifies Unicode composition', () => {
  assert.equal(normalize('é'), normalize('é'))
})

// --- source hash ------------------------------------------------------------

test('a cosmetic edit does not change the source hash', () => {
  assert.equal(hashOf("Ben's tab"), hashOf('Ben’s tab'))
  assert.equal(hashOf('Send  tab'), hashOf('Send tab'))
  assert.equal(hashOf('Send tab '), hashOf('Send tab'))
})

test('a real wording edit changes the source hash', () => {
  assert.notEqual(hashOf('Send this tab'), hashOf('Deliver this tab'))
})

test('an argument change changes the source hash even if the words match', () => {
  const a = sourceHash('Send to {device}', contractOf(analyze('Send to {device}')))
  const b = sourceHash('Send to {device}', 'args(device:number);plural();select();tags()')
  assert.notEqual(a, b)
})

// --- context hash -----------------------------------------------------------

test('context hash tracks the comment and placeholder docs', () => {
  const base = { comment: 'Dialog title', placeholders: { device: { type: 'string', desc: 'Target' } } }
  assert.equal(contextHash(base), contextHash({ ...base, comment: 'Dialog  title' }))
  assert.notEqual(contextHash(base), contextHash({ ...base, comment: 'Toast body' }))
  assert.notEqual(
    contextHash(base),
    contextHash({ ...base, placeholders: { device: { type: 'string', desc: 'Sender' } } }),
  )
})

test('context hash is independent of placeholder declaration order', () => {
  const a = contextHash({ comment: 'x', placeholders: { b: { type: 'string' }, a: { type: 'number' } } })
  const b = contextHash({ comment: 'x', placeholders: { a: { type: 'number' }, b: { type: 'string' } } })
  assert.equal(a, b)
})

test('class is part of the context, because it changes how the string is translated', () => {
  assert.notEqual(contextHash({ comment: 'x', class: 'ui' }), contextHash({ comment: 'x', class: 'marketing' }))
})

// --- content hash: the safety mechanism -------------------------------------

test('content hash is exact and does NOT normalize', () => {
  assert.notEqual(contentHash("it's"), contentHash('it’s'))
  assert.notEqual(contentHash('Senden '), contentHash('Senden'))
})

test('an untouched machine translation is not seen as human-edited', () => {
  const message = 'Tab senden'
  assert.equal(wasHumanEdited({ message, origin: 'machine', contentHash: contentHash(message) }), false)
})

test('a hand edit is detected, including a purely typographic one', () => {
  const original = "Ben's Tab senden"
  const entry = { message: original, origin: 'machine', contentHash: contentHash(original) }
  entry.message = 'Ben’s Tab senden' // a human fixing the apostrophe, nothing else
  assert.equal(wasHumanEdited(entry), true)
})

test('an entry already marked human is left alone', () => {
  assert.equal(wasHumanEdited({ message: 'x', origin: 'human', contentHash: contentHash('y') }), false)
})

test('an entry with no content hash is treated as human, which is the safe direction', () => {
  assert.equal(wasHumanEdited({ message: 'x', origin: 'machine' }), true)
})

test('an entry with no message is not human-edited', () => {
  assert.equal(wasHumanEdited({ origin: 'machine', attempt: { status: 'failed' } }), false)
})

// --- staleness --------------------------------------------------------------

const src = 'Send {count, plural, one {# tab} other {# tabs}} to {device}?'
const srcAnalysis = analyze(src)
const expected = {
  sourceHash: sourceHash(src, contractOf(srcAnalysis)),
  contextHash: contextHash({ comment: 'Dialog title' }),
}

const entryFor = (over = {}) => ({ ...expected, origin: 'machine', ...over })

test('matching hashes read as current', () => {
  assert.equal(stalenessOf(entryFor(), { ...expected }), 'current')
})

test('a context-only change is stale-context', () => {
  const entry = entryFor({ contextHash: contextHash({ comment: 'Older wording' }) })
  assert.equal(stalenessOf(entry, { ...expected }), 'stale-context')
})

test('a wording change with an intact contract is stale-text', () => {
  const entry = entryFor({ sourceHash: 's1:0000000000000000' })
  assert.equal(stalenessOf(entry, { ...expected, structurallyBroken: false }), 'stale-text')
})

test('a contract change is stale-structural', () => {
  const entry = entryFor({ sourceHash: 's1:0000000000000000' })
  assert.equal(stalenessOf(entry, { ...expected, structurallyBroken: true }), 'stale-structural')
})

test('structural staleness is derived by comparing the real translation to the real source', () => {
  // The source gained an argument. The German text predates it.
  const newSrc = analyze('Send {count, plural, one {# tab} other {# tabs}} to {device} at {when}?')
  const oldDe = analyze('{count, plural, one {# Tab} other {# Tabs}} an {device} senden?')
  const broken = compareStructure(newSrc, oldDe).length > 0
  assert.equal(broken, true)

  const entry = entryFor({ sourceHash: 's1:0000000000000000' })
  assert.equal(stalenessOf(entry, { ...expected, structurallyBroken: broken }), 'stale-structural')
})

// --- measurement ------------------------------------------------------------

test('display width counts CJK as two columns', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('日本語'), 6)
  assert.equal(displayWidth('タブを送信'), 10)
})

test('combining marks and bidi controls take no width', () => {
  assert.equal(displayWidth('é'), 1)
  assert.equal(displayWidth('⁦x⁩'), 1)
})

test('grapheme count treats a composed pair as one character', () => {
  assert.equal(graphemeCount('é'), 1)
  assert.equal(graphemeCount('👍'), 1)
})

test('measure honours the declared rule', () => {
  assert.equal(measure('日本語', 'display-width'), 6)
  assert.equal(measure('日本語', 'graphemes'), 3)
})
