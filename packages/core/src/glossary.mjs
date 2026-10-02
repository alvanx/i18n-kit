/**
 * Glossary loading and enforcement.
 *
 * Two kinds of entry, enforced differently, because treating them the same is
 * how a glossary lint gets switched off.
 *
 *   doNotTranslate is an ERROR when violated. These are proper nouns and
 *   product names. They do not inflect in the cases that matter, so demanding
 *   them verbatim is a fair test.
 *
 *   A preferred translation is a WARNING at most. German will legitimately
 *   render a glossary term as "Relays" or "Relay-Adresse", and an exact-match
 *   rule against an inflecting language produces noise that buries real
 *   findings. It drops to info for marketing and SEO copy, where rewriting
 *   around a term is the job rather than a mistake.
 */

import { existsSync, readFileSync } from 'node:fs'

export function loadGlossary(path) {
  if (!path || !existsSync(path)) return { terms: [] }

  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`)
  }

  const terms = (doc.terms ?? []).map((t) => ({
    term: t.term,
    doNotTranslate: t.doNotTranslate ?? false,
    caseSensitive: t.caseSensitive ?? false,
    translations: t.translations ?? {},
    notes: t.notes ?? null,
  }))

  for (const t of terms) {
    if (typeof t.term !== 'string' || t.term.length === 0) {
      throw new Error(`${path}: every glossary entry needs a non-empty "term"`)
    }
  }

  return { terms }
}

const contains = (haystack, needle, caseSensitive) =>
  caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase())

/** Glossary entries whose term appears in this source text. Also what the prompt gets. */
export function termsIn(glossary, sourceText) {
  return glossary.terms.filter((t) => contains(sourceText, t.term, t.caseSensitive))
}

/**
 * @param {{terms: Array<object>}} glossary
 * @param {{sourceText: string, translatedText: string, locale: string, contentClass: string}} ctx
 */
export function checkGlossary(glossary, { sourceText, translatedText, locale, contentClass = 'ui' }) {
  const findings = []

  for (const term of termsIn(glossary, sourceText)) {
    if (term.doNotTranslate) {
      if (!contains(translatedText, term.term, true)) {
        findings.push({
          code: 'GLOSSARY_DNT_VIOLATION',
          detail: `"${term.term}" must appear verbatim and does not${term.notes ? ` (${term.notes})` : ''}`,
        })
      }
      continue
    }

    const preferred = term.translations?.[locale]
    if (preferred && !contains(translatedText, preferred, false)) {
      findings.push({
        code: 'GLOSSARY_PREFERRED_MISS',
        // Marketing and SEO copy is expected to restructure around a term, so
        // the same observation is worth less there.
        severityHint: contentClass === 'ui' ? undefined : 'info',
        detail:
          `"${term.term}" is preferred as "${preferred}" in ${locale}` +
          `${term.notes ? ` (${term.notes})` : ''}. Inflected forms are fine; check this is one.`,
      })
    }
  }

  return findings
}

// Shapes that are obviously benign and would otherwise trip the patterns below.
// Dates are the single most common placeholder example, and an ISO date is
// mostly digits and dashes, which is also what a phone number looks like.
const BENIGN = [
  /^\d{4}-\d{2}-\d{2}([T ].*)?$/, // ISO date or date-time
  /^\d{1,2}[:.]\d{2}(:\d{2})?$/, // clock time
  /^-?\d+([.,]\d+)?$/, // a plain number
  /^\d{4}$/, // a year
]

// Patterns that suggest a placeholder example holds something real rather than
// something illustrative. Examples are sent verbatim to a translation provider.
const PERSONAL_PATTERNS = [
  [/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i, 'an email address'],
  [/^\+?\d[\d\s().-]{8,}$/, 'a phone number'],
  [/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'an IBAN'],
  [/^(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{10,}$/, 'an API key or token'],
  [/^[A-Fa-f0-9]{32,}$/, 'a hash or key'],
  [/^\d{3}-\d{2}-\d{4}$/, 'a national ID number'],
]

/**
 * Does this example look like real data?
 *
 * Advisory only, and deliberately quiet. Examples are genuinely useful to a
 * translator, so a check that fires on every date would get switched off within
 * a week and take the real warnings with it.
 */
export function looksPersonal(example) {
  if (typeof example !== 'string') return null
  const trimmed = example.trim()

  if (BENIGN.some((pattern) => pattern.test(trimmed))) return null

  // A phone number needs enough digits to be one. An ISO date has eight.
  const digitCount = (trimmed.match(/\d/g) ?? []).length

  for (const [pattern, what] of PERSONAL_PATTERNS) {
    if (!pattern.test(trimmed)) continue
    if (what === 'a phone number' && digitCount < 9) continue
    return what
  }
  return null
}
