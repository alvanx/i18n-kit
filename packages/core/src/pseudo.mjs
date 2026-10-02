/**
 * Pseudo-locale generation.
 *
 * Worth being honest about what this does and does not do. It is a manual QA
 * aid, not a static check: it only finds a hardcoded string when somebody runs
 * the app and looks at the screen that contains it. Nothing here can tell you
 * about a screen nobody opened.
 *
 * Two locales, because they catch different faults:
 *
 *   en-XA expands. Accents every vowel, pads 40%, and brackets the whole
 *   string. Anything on screen without brackets did not come from the catalog.
 *   Anything clipped will clip in German.
 *
 *   ar-XB reverses. Real RTL marks around Latin text, so the base direction
 *   flips while the words stay readable. Finds unmirrored icons, hardcoded
 *   left/right padding, and placeholders that reorder their surroundings.
 *
 * Both preserve ICU structure exactly. Only literal text is transformed, so
 * placeholders, plural branches, and tags survive untouched and the pseudo
 * output still passes every structural check.
 */

import { TYPE } from '@formatjs/icu-messageformat-parser'
import { analyze } from './icu.mjs'

export const PSEUDO_LOCALES = {
  'en-XA': { kind: 'expansion', description: 'Accented and padded. Finds clipping and hardcoded strings.' },
  'ar-XB': { kind: 'bidi', description: 'Right-to-left with readable Latin. Finds mirroring and isolation faults.' },
}

const ACCENTS = new Map(
  Object.entries({
    a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ',
    k: 'ķ', l: 'ł', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: ' q', r: 'ŕ', s: 'š', t: 'ţ',
    u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
    A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ',
    K: 'Ķ', L: 'Ł', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Q', R: 'Ŕ', S: 'Š', T: 'Ţ',
    U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
  }),
)

/** Padding that is obviously filler, so a reviewer never mistakes it for content. */
const PAD = '·' // middle dot

const RLI = '⁧' // right-to-left isolate
const PDI = '⁩' // pop directional isolate
const RLM = '‏' // right-to-left mark

function accent(text) {
  let out = ''
  for (const ch of text) out += ACCENTS.get(ch) ?? ch
  return out
}

/**
 * Grow a string by roughly `ratio`, using filler that cannot be confused with
 * real text. Only whole-string padding: inserting inside words would make the
 * result unreadable and hide the very clipping it is meant to reveal.
 */
function expand(text, ratio) {
  const target = Math.ceil(text.length * ratio)
  const needed = Math.max(0, target - text.length)
  return needed > 0 ? `${text} ${PAD.repeat(needed)}` : text
}

function transformLiteral(value, kind) {
  if (kind === 'expansion') return expand(accent(value), 1.4)
  // Keep Latin readable, but mark it right-to-left so the layout flips.
  return `${RLM}${value}${RLM}`
}

/**
 * Every literal text span in the message, as offsets into the original string.
 *
 * Collecting spans and splicing them is the whole trick here. The obvious
 * alternative, walking the AST and printing it back out, has to reconstruct
 * every construct it did not change: plural offsets, exact-match selectors,
 * and above all number and date skeletons like `::currency/EUR`, which the
 * parser turns into a structured object with no faithful round trip. Splicing
 * copies all of that byte for byte and touches only the words.
 */
function literalSpans(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === TYPE.literal && node.location) {
      out.push({ start: node.location.start.offset, end: node.location.end.offset })
      continue
    }
    if (node.type === TYPE.tag) literalSpans(node.children ?? [], out)
    if (node.type === TYPE.plural || node.type === TYPE.select) {
      for (const option of Object.values(node.options ?? {})) literalSpans(option.value ?? [], out)
    }
  }
  return out
}

/**
 * Build one pseudo message from a source message.
 *
 * @param {string} message  source ICU text
 * @param {'en-XA'|'ar-XB'} locale
 */
export function pseudoMessage(message, locale) {
  const spec = PSEUDO_LOCALES[locale]
  if (!spec) throw new Error(`Unknown pseudo-locale "${locale}". Known: ${Object.keys(PSEUDO_LOCALES).join(', ')}.`)

  const { ast } = analyze(message)
  const spans = literalSpans(ast).sort((a, b) => a.start - b.start)

  let body = ''
  let cursor = 0
  for (const span of spans) {
    body += message.slice(cursor, span.start)
    body += transformLiteral(message.slice(span.start, span.end), spec.kind)
    cursor = span.end
  }
  body += message.slice(cursor)

  return spec.kind === 'expansion' ? `⟦${body}⟧` : `${RLI}${body}${PDI}`
}

/**
 * Generate a whole pseudo-locale catalog from the project's source.
 *
 * Output goes to the export directory, not to i18n/translations. A pseudo
 * locale is generated, disposable, and must never be mistaken for something a
 * translator produced.
 *
 * @returns {{locale: string, messages: Record<string, string>, skipped: Array<{key: string, reason: string}>}}
 */
export function generatePseudoLocale(project, locale) {
  const messages = {}
  const skipped = []

  for (const { namespace, key, entry } of project.entries()) {
    if (entry.deprecated) continue
    try {
      messages[key] = pseudoMessage(entry.message, locale)
    } catch (err) {
      // A message that does not parse is already an error from `check`. Skip it
      // here rather than failing the whole pseudo run for a known problem.
      skipped.push({ namespace, key, reason: err.message })
    }
  }

  return { locale, messages, skipped }
}
