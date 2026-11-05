/**
 * The check gate.
 *
 * One pass over the whole project, reporting everything it finds, so a person
 * fixes a batch rather than playing whack-a-mole one rerun at a time. It makes
 * no network calls and needs no API key, which is what lets it run on a pull
 * request from a fork where secrets are unavailable.
 *
 * The severity of a stale translation depends on WHO wrote it, and that is the
 * point most i18n tooling gets wrong in one direction or the other:
 *
 *   A machine translation behind its source is an error. Regenerating costs a
 *   fraction of a cent, so there is no reason to ship the stale one.
 *
 *   A human translation whose ARGUMENT CONTRACT no longer matches is an error
 *   too. It will render a hole or throw, and who wrote it is irrelevant to that.
 *
 *   A human translation that is merely behind on WORDING is a warning, and an
 *   error only at release. Shipping slightly stale reviewed German beats
 *   shipping English; shipping it without knowing does not.
 */

import { compareStructure, structuralFindings } from './icu.mjs'
import { checkCoverage, isRtl, categoriesFor } from './plurals.mjs'
import { measure, displayWidth, hasEdgeWhitespace, FSI } from './text.mjs'
import { severityOf, RULES } from './rules.mjs'
import { loadGlossary, checkGlossary, looksPersonal } from './glossary.mjs'
import { adapterForTarget, capabilityFindings, resolveLocaleTag, messagesForTarget } from './adapters/index.mjs'
import { checkDrift } from './export.mjs'

/**
 * @param {import('./catalog.mjs').Project} project
 * @param {{
 *   loadFindings?: Array<object>,
 *   release?: boolean,
 *   newKeys?: Set<string>,
 * }} opts
 */
export function check(project, { loadFindings = [], release = false, newKeys = null } = {}) {
  const config = project.config
  const findings = []
  const glossary = loadGlossary(config.paths.glossary)

  const RANK = { error: 0, warn: 1, info: 2, off: 3 }

  /**
   * `downgradeTo` exists for the two rules whose weight genuinely depends on
   * context rather than on the rule itself: the comment ratchet, where a
   * pre-existing backlog is a warning while a new key is an error, and a
   * preferred glossary term, which is advisory in marketing copy. It can only
   * ever soften a finding, and a project's own severity override still wins.
   */
  const emit = (code, detail, where = {}, { downgradeTo } = {}) => {
    const configured = severityOf(code, { overrides: config.severity, release })
    if (configured === 'off') return

    let severity = configured
    if (downgradeTo && !Object.hasOwn(config.severity, code) && RANK[downgradeTo] > RANK[configured]) {
      severity = downgradeTo
    }
    if (severity === 'off') return
    findings.push({ code, severity, detail, ...where })
  }

  // Findings the loader already produced (key shape, schema, promotions).
  for (const f of loadFindings) emit(f.code, f.detail, { file: f.file, key: f.key, locale: f.locale })

  checkSource(project, { emit, newKeys })
  checkTargets(project, { emit })

  for (const locale of config.targetLocales()) {
    checkLocale(project, locale, { emit, glossary, release })
  }

  if (config.generated.committed) {
    for (const f of checkDrift(project)) emit(f.code, f.detail, { target: f.target, path: f.path })
  }

  return summarize(findings, { release })
}

// --- source-side ------------------------------------------------------------

function checkSource(project, { emit, newKeys }) {
  const config = project.config
  const seenResourceNames = new Map()
  const seenText = new Map()
  let commentBacklog = 0

  for (const { namespace, key, entry } of project.entries()) {
    const where = { namespace, key }

    // Resource-name collisions must be checked case-insensitively: Android and
    // Chrome both fold case, so two keys that differ only in case compile to
    // one name and R.string stops compiling.
    const resourceName = key.replaceAll('.', '_').toLowerCase()
    const previous = seenResourceNames.get(resourceName)
    if (previous && previous !== key) {
      emit('NAME_COLLISION', `"${key}" and "${previous}" both become "${resourceName}" as a platform resource name`, where)
    }
    seenResourceNames.set(resourceName, key)

    if (!entry.comment) {
      // Ratchet: a key that is new in this change must have a comment. The
      // pre-existing backlog is reported as a count, not a wall of errors.
      if (newKeys?.has(`${namespace}.${key}`)) {
        emit('COMMENT_MISSING', `"${key}" is new and has no comment`, where)
      } else {
        commentBacklog += 1
      }
    }

    let analysis
    try {
      analysis = project.analysisOf(entry.message)
    } catch (err) {
      emit(err.code ?? 'ICU_PARSE', `${err.message}`, where)
      continue
    }

    for (const f of structuralFindings(entry.message, analysis)) emit(f.code, f.detail, where)

    for (const f of checkCoverage(config.sourceLocale, analysis, {
      isSource: true,
      zeroCase: config.policy.zeroCase,
    })) {
      emit(f.code, f.detail, where)
    }

    checkDeclarations(entry, analysis, { emit, where, config })

    const contentClass = project.classOf(entry)
    if (contentClass === 'seo' && !entry.keywords?.primary) {
      emit('KEYWORD_LOST', `"${key}" is class "seo" but declares no keywords.primary to preserve`, where)
    }

    const maxLength = entry.maxLength
    if (maxLength && ['source', 'both'].includes(maxLength.appliesTo ?? 'translation')) {
      const width = measure(entry.message, maxLength.measure ?? 'display-width')
      if (width > maxLength.value) {
        emit('MAX_LENGTH_EXCEEDED', `source is ${width}, limit is ${maxLength.value}`, where)
      }
    }

    if (hasEdgeWhitespace(entry.message)) {
      emit('LEADING_TRAILING_WS', 'source has leading or trailing whitespace, which several platforms silently trim', where)
    }

    const duplicate = seenText.get(entry.message)
    if (duplicate) {
      emit('DUPLICATE_SOURCE', `identical source text to "${duplicate}"`, where)
    } else {
      seenText.set(entry.message, key)
    }
  }

  // Glossary terminology is only ever checked against translations. The source
  // IS the terminology, so comparing it to itself would say nothing.

  if (commentBacklog > 0) {
    emit(
      'COMMENT_MISSING',
      `${commentBacklog} pre-existing ${commentBacklog === 1 ? 'key has' : 'keys have'} no comment. ` +
        `New keys are an error; this backlog stays a warning until it is worked down.`,
      { backlog: commentBacklog },
      { downgradeTo: 'warn' },
    )
  }
}

/** Declared placeholders against the ones the message actually uses. */
function checkDeclarations(entry, analysis, { emit, where, config }) {
  const declared = new Set(Object.keys(entry.placeholders ?? {}))
  const declaredTags = new Set(
    Object.entries(entry.placeholders ?? {})
      .filter(([, p]) => p.type === 'tag')
      .map(([name]) => name),
  )
  const usedTags = new Set(analysis.tags)

  for (const name of analysis.args.keys()) {
    if (!declared.has(name)) {
      emit('PLACEHOLDER_UNDECLARED', `{${name}} is used but not declared in placeholders`, where)
    }
  }

  for (const name of declared) {
    if (declaredTags.has(name)) {
      if (!usedTags.has(name)) {
        emit('PLACEHOLDER_UNUSED', `<${name}> is declared as a tag but does not appear in the message`, where)
      }
      continue
    }
    if (!analysis.args.has(name)) {
      emit('PLACEHOLDER_UNUSED', `{${name}} is declared but does not appear in the message`, where)
    }
  }

  for (const tag of usedTags) {
    if (!declared.has(tag)) {
      emit('PLACEHOLDER_UNDECLARED', `<${tag}> is used but not declared as a tag in placeholders`, where)
    }
  }

  for (const [name, meta] of analysis.args) {
    const declaredType = entry.placeholders?.[name]?.type
    if (!declaredType) continue
    const usedAsNumber = meta.kinds.has('plural') || meta.kinds.has('selectordinal') || meta.kinds.has('number')
    if (usedAsNumber && !['number'].includes(declaredType)) {
      emit(
        'PLACEHOLDER_TYPE_CONFLICT',
        `{${name}} is declared "${declaredType}" but is used as a number (plural selector or number argument)`,
        where,
      )
    }
    if (meta.kinds.has('date') && declaredType !== 'date') {
      emit('PLACEHOLDER_TYPE_CONFLICT', `{${name}} is declared "${declaredType}" but is used as a date`, where)
    }
  }

  if (config.policy.placeholderExamples === 'forbidden') {
    for (const [name, p] of Object.entries(entry.placeholders ?? {})) {
      if (p.example !== undefined) {
        emit('EXAMPLE_LOOKS_PERSONAL', `{${name}} has an example, and policy.placeholderExamples is "forbidden"`, where)
      }
    }
  } else {
    for (const [name, p] of Object.entries(entry.placeholders ?? {})) {
      const what = looksPersonal(p.example)
      if (what) {
        emit(
          'EXAMPLE_LOOKS_PERSONAL',
          `the example for {${name}} looks like ${what}, and examples are sent to the translation provider`,
          where,
        )
      }
    }
    if (config.policy.placeholderExamples === 'required') {
      for (const [name, p] of Object.entries(entry.placeholders ?? {})) {
        if (p.example === undefined) {
          emit('EXAMPLE_LOOKS_PERSONAL', `{${name}} has no example, and policy.placeholderExamples is "required"`, where)
        }
      }
    }
  }
}

// --- target capabilities ----------------------------------------------------

function checkTargets(project, { emit }) {
  const config = project.config

  for (const [name, target] of config.enabledTargets()) {
    const adapter = adapterForTarget(target)

    for (const locale of config.targetLocales()) {
      const resolved = resolveLocaleTag(locale, target, adapter)
      if (!resolved.ok) emit(resolved.code, resolved.detail, { target: name, locale })
    }

    for (const { namespace, key, entry } of messagesForTarget(project, name)) {
      const analysis = project.tryAnalysisOf(entry.message)
      if (!analysis) continue
      for (const f of capabilityFindings(analysis, adapter, { targetName: name })) {
        emit(f.code, f.detail, { namespace, key, target: name })
      }
    }
  }
}

// --- per locale -------------------------------------------------------------

function checkLocale(project, locale, { emit, glossary }) {
  const config = project.config
  const required = config.isRequired(locale)
  const rtl = isRtl(locale)

  for (const { namespace, key, entry } of project.entries()) {
    const where = { namespace, key, locale }
    const status = project.statusOf(locale, namespace, key)
    const translation = status.translation
    const contentClass = project.classOf(entry)

    if (status.state === 'failed') {
      emit('FAILED_ATTEMPT', `last attempt failed: ${translation.attempt.reason}`, where)
      continue
    }

    if (status.state === 'missing') {
      if (entry.sensitive) {
        emit('SENSITIVE_UNTRANSLATED', 'marked sensitive, so it is excluded from provider requests and needs a human', where)
      } else {
        emit(required ? 'MISSING_KEY' : 'MISSING_KEY_OPTIONAL', `no translation in ${locale}`, where)
      }
      continue
    }

    const text = translation.message
    const sourceAnalysis = project.tryAnalysisOf(entry.message)

    let analysis
    try {
      analysis = project.analysisOf(text)
    } catch (err) {
      emit(err.code ?? 'ICU_PARSE', err.message, where)
      continue
    }

    for (const f of structuralFindings(text, analysis)) emit(f.code, f.detail, where)

    if (sourceAnalysis) {
      for (const f of compareStructure(sourceAnalysis, analysis)) emit(f.code, f.detail, where)
    }

    for (const f of checkCoverage(locale, analysis, {
      isSource: false,
      zeroCase: config.policy.zeroCase,
      sourceAnalysis,
    })) {
      emit(f.code, f.detail, where)
    }

    emitStaleness(status, translation, { emit, where })

    checkLength(entry, text, locale, { emit, where, config, contentClass })

    if (text === entry.message && displayWidth(text) > 3) {
      emit('UNTRANSLATED_IDENTICAL', `identical to the source text in ${locale}`, where)
    }

    if (hasEdgeWhitespace(text)) {
      emit('LEADING_TRAILING_WS', 'leading or trailing whitespace', where)
    }

    if (rtl) checkBidi(entry, analysis, text, { emit, where })

    for (const f of checkGlossary(glossary, {
      sourceText: entry.message,
      translatedText: text,
      locale,
      contentClass,
    })) {
      emit(f.code, f.detail, where, { downgradeTo: f.severityHint })
    }

    if (contentClass === 'seo' && entry.keywords?.primary) {
      // The keyword must survive, though not necessarily in the source language.
      // Only its absence entirely is checkable here; a model judges the rest.
      if (translation.qa?.findings?.some((f) => f.category === 'keyword-loss')) {
        emit('KEYWORD_LOST', 'a qa review reported the primary keyword was lost', where)
      }
    }

    if (translation.note) {
      emit('MODEL_NOTE', `${translation.note.kind}: ${translation.note.text}`, where)
    }

    for (const finding of translation.qa?.findings ?? []) {
      emit('QA_FINDING', `${finding.category} (${finding.severity}): ${finding.detail}`, where)
    }
  }

  // Translations for keys the source no longer defines.
  for (const [namespace, file] of project.translations.get(locale) ?? []) {
    for (const key of file.messages.keys()) {
      if (!project.sourceEntry(namespace, key)) {
        emit('ORPHAN_KEY', `${locale} has a translation for "${key}", which the source no longer defines`, {
          namespace,
          key,
          locale,
        })
      }
    }
  }
}

/** The who-wrote-it matrix, in one place. */
function emitStaleness(status, translation, { emit, where }) {
  const human = translation.origin === 'human'

  switch (status.state) {
    case 'stale-structural':
      emit(
        human ? 'STALE_HUMAN_STRUCTURAL' : 'STALE_MACHINE',
        human
          ? 'the source changed its placeholder or plural contract under a human translation, so it will now misformat'
          : 'the source changed and this machine translation was not regenerated',
        where,
      )
      break
    case 'stale-text':
      emit(
        human ? 'STALE_HUMAN_TEXT' : 'STALE_MACHINE',
        human
          ? 'the source wording changed; the human translation still ships, but a release should not go out unaware'
          : 'the source changed and this machine translation was not regenerated',
        where,
      )
      break
    case 'stale-context':
      emit('STALE_CONTEXT', 'the comment or placeholder documentation changed since this was translated', where)
      break
    default:
      break
  }
}

function checkLength(entry, text, locale, { emit, where, config, contentClass }) {
  const maxLength = entry.maxLength
  if (maxLength && ['translation', 'both'].includes(maxLength.appliesTo ?? 'translation')) {
    const width = measure(text, maxLength.measure ?? 'display-width')
    if (width > maxLength.value) {
      emit('MAX_LENGTH_EXCEEDED', `${width} exceeds the declared limit of ${maxLength.value}`, where)
    }
    return
  }

  // Marketing copy is expected to be rewritten rather than rendered, so an
  // expansion budget is the wrong lens for it.
  if (contentClass === 'marketing') return

  const sourceWidth = displayWidth(entry.message)
  if (sourceWidth === 0) return
  const budget = config.expansionBudgetFor(sourceWidth, locale)
  const ratio = displayWidth(text) / sourceWidth
  if (ratio > budget) {
    emit(
      'TEXT_EXPANSION',
      `${Math.round(ratio * 100)}% of source width, budget is ${Math.round(budget * 100)}%`,
      where,
    )
  }
}

/**
 * An LTR value dropped into RTL text reorders whatever surrounds it unless it
 * is isolated. Only string arguments matter: numbers and dates are formatted by
 * the runtime, which isolates them itself.
 */
function checkBidi(entry, analysis, text, { emit, where }) {
  if (text.includes(FSI)) return

  const bare = [...analysis.args.entries()]
    .filter(([name, meta]) => {
      if (!meta.kinds.has('string')) return false
      const declared = entry.placeholders?.[name]
      // A value the user chose is the dangerous case: it can be in any script.
      return declared?.doNotTranslate || declared?.type === 'string'
    })
    .map(([name]) => name)

  if (bare.length) {
    emit(
      'BIDI_ISOLATION',
      `{${bare.join('}, {')}} will be substituted into right-to-left text without isolation. ` +
        `Enable bidiIsolate in the runtime, or the surrounding words can visually reorder.`,
      where,
    )
  }
}

// --- reporting --------------------------------------------------------------

function summarize(findings, { release }) {
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity] += 1

  const order = { error: 0, warn: 1, info: 2 }
  findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.locale ?? '').localeCompare(b.locale ?? '') ||
      (a.key ?? '').localeCompare(b.key ?? '') ||
      a.code.localeCompare(b.code),
  )

  return {
    findings,
    counts,
    ok: counts.error === 0,
    release,
    /** Rule descriptions, so a report can explain a code without a second lookup. */
    describe: (code) => RULES[code]?.desc ?? '',
  }
}

/** Plural categories a locale needs, re-exported so the CLI and prompts share one source. */
export { categoriesFor }
