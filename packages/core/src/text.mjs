/**
 * Text normalization and measurement.
 *
 * Normalization exists for one purpose: deciding whether a source string
 * changed *enough to be worth retranslating*. A smart-quote sweep or a
 * trailing-space cleanup across a catalog should cost nothing, so those
 * differences are erased before the source is hashed.
 *
 * It is deliberately NOT used on translated text. A human's typographic
 * correction is exactly the edit normalization erases, and detecting that edit
 * is the whole safety mechanism. See hash.mjs.
 *
 * Every non-ASCII character in this file is written as an escape. The whole
 * module is about characters that look alike, so source you cannot read is a
 * liability.
 */

/** Characters that differ typographically but never semantically, for hashing. */
const FOLD = new Map([
  ['‘', "'"], // left single quote
  ['’', "'"], // right single quote, the typographic apostrophe
  ['‚', "'"], // single low-9 quote
  ['‛', "'"], // single high-reversed-9 quote
  ['“', '"'], // left double quote
  ['”', '"'], // right double quote
  ['„', '"'], // double low-9 quote
  ['′', "'"], // prime
  ['″', '"'], // double prime
  ['–', '-'], // en dash
  ['—', '-'], // em dash
  ['−', '-'], // minus sign
  ['…', '...'], // horizontal ellipsis
])

/**
 * Every space that is not U+0020: NBSP, the quad/em family, narrow and
 * ideographic spaces, zero-width space, and the BOM when used as one.
 */
const SPACE_RE = /[   -​  　﻿]/g

/**
 * Fold away differences that never change meaning.
 *
 * NFC first, so a precomposed é and a decomposed e + U+0301 hash the same.
 */
export function normalize(text) {
  if (typeof text !== 'string') return ''
  const spaced = text.normalize('NFC').replace(SPACE_RE, ' ')
  let folded = ''
  for (const ch of spaced) folded += FOLD.get(ch) ?? ch
  return folded.replace(/\s+/g, ' ').trim()
}

/** Stable JSON for hashing: object keys sorted at every level, no whitespace. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

// East Asian Wide and Fullwidth ranges, plus emoji. Anything here occupies two
// columns wherever text is laid out in a grid.
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // kana, Bopomofo, Hangul compat jamo, enclosed CJK
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff], // supplemental emoji
  [0x20000, 0x2fffd], // CJK extension B and beyond
  [0x30000, 0x3fffd],
]

// Combining marks, bidi controls, and variation selectors render on top of or
// alongside the previous character rather than taking a column of their own.
const ZERO_RANGES = [
  [0x0300, 0x036f], // combining diacritics
  [0x0483, 0x0489],
  [0x0591, 0x05bd], // Hebrew points
  [0x0610, 0x061a], // Arabic marks
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31], // Thai
  [0x0e34, 0x0e3a],
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embedding and override
  [0x2066, 0x2069], // bidi isolates
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
]

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

/**
 * Columns a string occupies, counting CJK and emoji as two.
 *
 * Code-unit length is the wrong measure for a length budget: it makes every CJK
 * locale look far shorter than it renders, so a Japanese string that overflows
 * a button passes while a German one that fits gets flagged.
 */
export function displayWidth(text) {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (inRanges(cp, ZERO_RANGES)) continue
    width += inRanges(cp, WIDE_RANGES) ? 2 : 1
  }
  return width
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** User-perceived character count, so a flag emoji or an accented pair counts once. */
export function graphemeCount(text) {
  let n = 0
  // eslint-disable-next-line no-unused-vars
  for (const _ of segmenter.segment(text)) n += 1
  return n
}

/** Measure by whichever rule a maxLength declared. */
export function measure(text, measureKind = 'display-width') {
  return measureKind === 'graphemes' ? graphemeCount(text) : displayWidth(text)
}

/** True when a string carries leading or trailing whitespace that platforms silently trim. */
export function hasEdgeWhitespace(text) {
  return typeof text === 'string' && text !== text.trim()
}

/** Bidi isolation, so an LTR value substituted into RTL text cannot reorder its surroundings. */
export const FSI = '⁨'
export const PDI = '⁩'

export function isolate(value) {
  return `${FSI}${value}${PDI}`
}
