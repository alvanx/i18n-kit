/**
 * The gate every machine translation passes before it is allowed into the
 * catalog.
 *
 * This module is the reason the engine exists at all. Asking a model to
 * translate a string file is a ten-line script; the hard part is that a model
 * will occasionally drop a placeholder, give Russian two plural branches
 * because English had two, translate a product name, or return prose instead of
 * ICU, and every one of those ships silently. Each is cheap to detect
 * mechanically, so each is detected here and fed back as a specific correction
 * rather than a vague retry.
 *
 * Severity is deliberately split in two.
 *
 *   BLOCKING faults make the string wrong: a lost argument, a broken plural, an
 *   unparseable message, a product name that got translated. These are retried,
 *   and a string that still fails is recorded as a failure with no text. An
 *   empty slot falls back to the source language, which is a visible gap. A
 *   plausible-looking string with a missing placeholder is an invisible one.
 *
 *   ADVISORY faults are judgement calls: over the length budget, a glossary
 *   preference not followed, suspiciously identical to the source. These are
 *   mentioned on the first retry and then accepted, because a tool that refuses
 *   to accept any translation it cannot prove perfect never finishes.
 *
 * Nothing here is network-aware, so the whole gate is testable without a key.
 */

import {
  analyze,
  compareStructure,
  structuralFindings,
  categoriesFor,
  checkGlossary,
  measure,
  normalize,
  checkCoverage,
} from '@i18n-kit/core'

/** @typedef {{blocking: Array<{code: string, detail: string}>, advisory: Array<{code: string, detail: string}>}} Verdict */

/**
 * @param {object} args
 * @param {string} args.candidate      the translation to judge
 * @param {string} args.sourceText     the source message
 * @param {string} args.locale
 * @param {object} args.entry          the source catalog entry
 * @param {{terms: Array<object>}} args.glossary
 * @param {{expansionBudgetFor: Function, policy: object}} args.config
 * @returns {Verdict}
 */
export function validateCandidate({ candidate, sourceText, locale, entry, glossary, config }) {
  const blocking = []
  const advisory = []
  const fail = (code, detail) => blocking.push({ code, detail })
  const warn = (code, detail) => advisory.push({ code, detail })

  if (typeof candidate !== 'string' || candidate.trim() === '') {
    fail('EMPTY_TRANSLATION', 'the translation is empty')
    return { blocking, advisory }
  }

  let sourceAnalysis
  try {
    sourceAnalysis = analyze(sourceText)
  } catch (err) {
    // The source itself is broken. Not this translation's fault, and not
    // something a retry can fix.
    return { blocking: [{ code: 'SOURCE_UNPARSEABLE', detail: err.message }], advisory }
  }

  let analysis
  try {
    analysis = analyze(candidate)
  } catch (err) {
    fail(
      'ICU_PARSE',
      `the translation is not valid ICU MessageFormat: ${err.message}. ` +
        `Return the same structure as the source, translating only the words outside the braces.`,
    )
    return { blocking, advisory }
  }

  // Lost, gained, or renamed arguments; a changed plural shape; a dropped tag.
  for (const finding of compareStructure(sourceAnalysis, analysis)) {
    fail(finding.code, finding.detail)
  }

  // The apostrophe trap, a stray `#`, nesting too deep. Worth re-checking on
  // the translation because French and Italian produce `l'{name}` constantly,
  // and that silently eats the argument.
  for (const finding of structuralFindings(candidate, analysis)) {
    fail(finding.code, finding.detail)
  }

  // Plural categories for the TARGET locale, which is the fault a model makes
  // most: it mirrors the source's branches instead of the language's.
  for (const finding of checkCoverage(locale, analysis, {
    isSource: false,
    zeroCase: config.policy?.zeroCase ?? 'separate-key',
  })) {
    // A missing category is a wrong string for real counts. An extra one is
    // dead weight, so it is worth saying but not worth another round trip.
    if (finding.code === 'PLURAL_CATEGORY_MISSING') {
      const required = categoriesFor(locale)
      fail(
        finding.code,
        `${finding.detail}. ${locale} selects among ${required.join(', ')}; every one needs its own branch.`,
      )
    } else {
      warn(finding.code, finding.detail)
    }
  }

  // Product names and other do-not-translate terms are an error; a preferred
  // translation is advice, because inflecting languages legitimately bend it.
  for (const finding of checkGlossary(glossary, {
    sourceText,
    translatedText: candidate,
    locale,
    contentClass: entry.class ?? config.policy?.defaultClass ?? 'ui',
  })) {
    if (finding.code === 'GLOSSARY_DNT_VIOLATION') fail(finding.code, finding.detail)
    else warn(finding.code, finding.detail)
  }

  // A hard character budget comes from a real UI constraint, so it blocks.
  if (typeof entry.maxLength === 'number') {
    const length = measure(candidate, config.policy?.lengthMeasure ?? 'display-width')
    if (length > entry.maxLength) {
      fail(
        'MAX_LENGTH_EXCEEDED',
        `${length} units long, and the limit is ${entry.maxLength}. ` +
          `Shorten it; an abbreviation the language actually uses is better than a truncation.`,
      )
    }
  } else {
    // No hard budget, so expansion is advice: a long German string is normal,
    // it just needs a human to look at the layout.
    const sourceWidth = measure(sourceText, 'display-width')
    const budget = config.expansionBudgetFor?.(sourceWidth, locale)
    const width = measure(candidate, 'display-width')
    if (budget && sourceWidth > 0 && width / sourceWidth > budget) {
      warn(
        'TEXT_EXPANSION',
        `${Math.round((width / sourceWidth) * 100)}% of the source width, over the ${Math.round(budget * 100)}% budget`,
      )
    }
  }

  if (normalize(candidate) === normalize(sourceText) && /[A-Za-z]{4}/.test(sourceText)) {
    // Sometimes right: "OK" and a brand name are the same everywhere. Often a
    // model declining to translate, so it gets flagged for a human.
    warn(
      'UNTRANSLATED_IDENTICAL',
      'identical to the source. If that is correct for this language, say so in the note.',
    )
  }

  if (/^\s|\s$/.test(candidate) !== /^\s|\s$/.test(sourceText)) {
    warn(
      'LEADING_TRAILING_WS',
      'leading or trailing whitespace differs from the source, which usually means a layout assumption was lost',
    )
  }

  return { blocking, advisory }
}

/** The correction text handed back to the provider on a retry. */
export function correctionFor(item, verdict) {
  const lines = [`Key ${item.key}: your previous answer was rejected.`]
  for (const finding of verdict.blocking) lines.push(`  - ${finding.code}: ${finding.detail}`)
  if (verdict.advisory.length) {
    lines.push('  Also worth fixing if you can, but not a rejection on its own:')
    for (const finding of verdict.advisory) lines.push(`  - ${finding.code}: ${finding.detail}`)
  }
  return lines.join('\n')
}
