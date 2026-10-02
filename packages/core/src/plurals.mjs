/**
 * CLDR plural categories and text direction, resolved from the platform rather
 * than from a table we would have to maintain.
 *
 * This module exists because "which plural forms does this language need" is
 * the single fact a translation model is least reliable about. Two English
 * forms cannot tell anyone what Arabic's dual, few, and many should say, and a
 * model asked to recall Russian's categories from memory will sometimes return
 * three instead of four. So the categories are computed here and injected into
 * the prompt, and checked here again on the way back.
 */

const categoryCache = new Map()

/**
 * The CLDR plural categories a locale actually selects between.
 *
 * English returns ['one', 'other']. Russian returns ['one', 'few', 'many',
 * 'other']. Arabic returns all six. Japanese returns ['other'] alone.
 */
export function categoriesFor(locale, type = 'cardinal') {
  const cacheKey = `${locale}/${type}`
  const cached = categoryCache.get(cacheKey)
  if (cached) return cached

  let categories
  try {
    categories = new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories
  } catch {
    throw new Error(`Unknown locale "${locale}": Intl cannot resolve plural rules for it`)
  }

  // Intl returns them in an unspecified order; CLDR order makes diffs and
  // generated files stable and reads naturally to a translator.
  const CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']
  const sorted = Object.freeze(
    [...categories].sort((a, b) => CLDR_ORDER.indexOf(a) - CLDR_ORDER.indexOf(b)),
  )
  categoryCache.set(cacheKey, sorted)
  return sorted
}

/** True when the locale's own plural rules include a distinct zero form. */
export function hasZeroCategory(locale) {
  return categoriesFor(locale).includes('zero')
}

/**
 * Check one message's plural branches against what the locale requires.
 *
 * Missing categories are an error: the branch simply will not exist at runtime
 * and the formatter falls through to `other`, which is wrong in Russian and
 * badly wrong in Arabic. Extra categories are a warning: dead weight on the web
 * and noise that `aapt2` strips on Android, but nothing breaks.
 *
 * @param {string} locale
 * @param {ReturnType<import('./icu.mjs').analyze>} analysis
 * @param {{ isSource?: boolean, zeroCase?: 'separate-key'|'exact-match' }} opts
 */
export function checkCoverage(locale, analysis, { isSource = false, zeroCase = 'separate-key' } = {}) {
  const findings = []

  for (const plural of analysis.plurals) {
    const required = categoriesFor(locale, plural.pluralType === 'ordinal' ? 'ordinal' : 'cardinal')
    const present = new Set(plural.categories)

    // A `zero` branch in a language with no zero category never fires. Authors
    // reach for it meaning "none", and get a branch that is silently dead.
    if (present.has('zero') && !required.includes('zero')) {
      if (isSource) {
        findings.push({
          code: 'PLURAL_ZERO_IN_SOURCE',
          detail:
            `{${plural.arg}} has a "zero" branch, but ${locale} has no CLDR zero category, so it never fires. ` +
            (zeroCase === 'exact-match'
              ? 'Use =0 instead.'
              : 'Use a separate key for the empty case, which every export target can represent.'),
        })
      } else {
        findings.push({
          code: 'PLURAL_CATEGORY_EXTRA',
          detail: `{${plural.arg}} has a "zero" branch, which ${locale} never selects`,
        })
      }
    }

    const missing = required.filter((c) => !present.has(c))
    if (missing.length) {
      findings.push({
        code: 'PLURAL_CATEGORY_MISSING',
        detail:
          `${locale} requires ${required.join(', ')} for {${plural.arg}}; ` +
          `missing ${missing.join(', ')}`,
      })
    }

    const extra = [...present].filter((c) => !required.includes(c) && c !== 'zero')
    if (extra.length) {
      findings.push({
        code: 'PLURAL_CATEGORY_EXTRA',
        detail: `{${plural.arg}} has ${extra.join(', ')}, which ${locale} never selects`,
      })
    }

    if (plural.exact.length && zeroCase === 'separate-key' && plural.exact.includes('=0')) {
      findings.push({
        code: 'PLURAL_ZERO_IN_SOURCE',
        detail:
          `{${plural.arg}} uses =0, but policy.zeroCase is "separate-key". ` +
          'Android and Apple cannot express an exact match, so the empty case needs its own key.',
      })
    }
  }

  return findings
}

const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Nkoo', 'Syrc', 'Samr', 'Mand', 'Adlm'])
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ku', 'nqo'])

/** Text direction, preferring the platform's own data and falling back to script and language. */
export function isRtl(locale) {
  try {
    const info = new Intl.Locale(locale).getTextInfo?.()
    if (info?.direction) return info.direction === 'rtl'
  } catch {
    // fall through to the static lists
  }
  try {
    const parsed = new Intl.Locale(locale)
    if (parsed.script && RTL_SCRIPTS.has(parsed.script)) return true
    if (parsed.language && RTL_LANGUAGES.has(parsed.language)) return true
  } catch {
    // not a parseable tag; treat as LTR
  }
  return false
}
