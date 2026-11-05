/**
 * The adapter registry and the capability contract.
 *
 * An adapter turns the whole catalog into a set of files. It is not
 * `render(message) -> string`, because the export targets disagree about what a
 * file even is: Apple writes one file for every locale at once, and Android
 * puts the locale in the directory name rather than the filename. So the unit
 * of output is a file plan, and the adapter owns its own fan-out.
 *
 * `capabilities` is not documentation. It drives lint. Every construct a target
 * cannot express is reported by `check` before `export` runs, and export fails
 * rather than emitting something lossy. That is the difference between finding
 * out at check time that Chrome cannot do `select`, and finding out from a user
 * that half your German dialog is missing.
 *
 * Everything an adapter would otherwise reimplement lives in core and is handed
 * to it: the parsed ICU, the canonical argument order, the resolved plural
 * categories, and the deterministic writer. Four hand-rolled ICU parsers would
 * be four sets of subtly different bugs.
 */

import web from './web.mjs'
import android from './android.mjs'
import chrome from './chrome.mjs'
import apple from './apple.mjs'
import icuJson from './icu-json.mjs'

/** @type {Record<string, Adapter>} */
export const ADAPTERS = {
  web,
  android,
  chrome,
  apple,
  'icu-json': icuJson,
}

export function getAdapter(id) {
  const adapter = ADAPTERS[id]
  if (!adapter) {
    throw new Error(`Unknown adapter "${id}". Available: ${Object.keys(ADAPTERS).join(', ')}.`)
  }
  return adapter
}

/**
 * The capability flags a project may narrow for one of its own targets.
 *
 * A hand-written formatter is the normal case, not the exception: most projects
 * carry a few hundred lines that read the ICU subset they actually needed, and
 * the full-ICU default would then pass a construct the app throws on at render
 * time. Declaring the subset moves that failure from a user's screen to
 * `check`.
 *
 * Narrowing only. Claiming a construct the adapter cannot write would be a
 * promise the writer breaks, so widening is a config error rather than a
 * surprise at export. The flags that decide HOW a file is written (`plurals`,
 * `placeholders`) are not here: those are the adapter's job, not a project's.
 */
export const NARROWABLE = new Set([
  'exactMatch',
  'select',
  'selectordinal',
  'offset',
  'repeatedPlaceholders',
  'numberArgs',
  'dateTimeArgs',
  'numberDateSkeletons',
  'richText',
  'nesting',
])

/**
 * The adapter a target actually renders through: the registered one, with the
 * target's declared subset applied.
 *
 * @param {{adapter: string, capabilities?: Record<string, unknown>}} target
 */
export function adapterForTarget(target) {
  const adapter = getAdapter(target.adapter)
  const narrowed = target.capabilities
  if (!narrowed || Object.keys(narrowed).length === 0) return adapter
  return { ...adapter, capabilities: { ...adapter.capabilities, ...narrowed } }
}

/**
 * The shape every adapter declares.
 *
 * @typedef {object} Capabilities
 * @property {'icu'|'cldr-categories'|'explode'|'variations'|'none'} plurals
 *   How the target represents a plural. 'icu' passes it through, 'explode'
 *   flattens it into sibling keys, 'none' cannot represent one at all.
 * @property {boolean} exactMatch          `=0` / `=1`
 * @property {boolean} select
 * @property {boolean} selectordinal
 * @property {boolean} offset
 * @property {number}  nesting             maximum supported depth
 * @property {'named'|'positional'} placeholders
 * @property {boolean} repeatedPlaceholders
 * @property {boolean} numberArgs            plain `{n, number}`
 * @property {boolean} dateTimeArgs          plain `{d, date}` / `{t, time}`
 * @property {boolean} numberDateSkeletons   styled, e.g. `::currency/EUR`
 * @property {boolean} richText
 * @property {'full'|'default-locale-only'|'none'} comments
 * @property {boolean} needsLocaleMap      whether an unmapped locale is an error
 */

/**
 * Which constructs in this message the target cannot express.
 *
 * Returned as findings rather than thrown so `check` can report every offending
 * key in one pass instead of one per run.
 *
 * @param {ReturnType<import('../icu.mjs').analyze>} analysis
 * @param {{id: string, capabilities: Capabilities}} adapter
 * @param {{targetName: string}} ctx
 */
export function capabilityFindings(analysis, adapter, { targetName }) {
  const c = adapter.capabilities
  const findings = []
  const cannot = (what, why) =>
    findings.push({
      code: 'UNSUPPORTED_FEATURE',
      detail: `target "${targetName}" (${adapter.id}) cannot express ${what}${why ? `: ${why}` : ''}`,
    })

  if (analysis.constructs.hasPlural && c.plurals === 'none') {
    cannot('a plural')
  }
  if (analysis.constructs.hasSelectOrdinal && !c.selectordinal) {
    cannot('selectordinal', 'ordinal plurals have no representation in this format')
  }
  if (analysis.constructs.hasSelect && !c.select) {
    cannot('select', 'split the branches into separate keys chosen at the call site')
  }
  if (analysis.constructs.hasOffset && !c.offset) {
    cannot('a plural offset')
  }
  if (analysis.constructs.hasExactMatch && !c.exactMatch) {
    cannot('an exact match (=0 or =1)', 'use a separate key for the empty case')
  }
  if (analysis.constructs.hasTags && !c.richText) {
    cannot('rich-text tags')
  }
  if (analysis.constructs.hasSkeleton && !c.numberDateSkeletons) {
    cannot(
      'a number or date skeleton',
      'this format has no way to carry one, so format the value before passing it in and use a plain argument',
    )
  }
  if (analysis.constructs.hasPlainNumber && !c.numberArgs) {
    cannot('a number argument', 'format the value before passing it in')
  }
  if (analysis.constructs.hasDateTime && !c.dateTimeArgs) {
    cannot(
      'a date or time argument',
      'format it in the caller, where the time zone and calendar are known, and pass the result as text',
    )
  }
  if (analysis.constructs.repeated.length && !c.repeatedPlaceholders) {
    cannot(`a repeated placeholder ({${analysis.constructs.repeated[0]}} appears more than once)`)
  }
  if (analysis.constructs.maxDepth > c.nesting) {
    cannot(`nesting depth ${analysis.constructs.maxDepth}`, `this format supports ${c.nesting}`)
  }

  return findings
}

/**
 * The platform's own tag for a locale.
 *
 * A target that needs a mapping and does not have one is an error, never a
 * guess. Inferring here is how `zh-Hans` silently becomes `zh` and every
 * Simplified Chinese user gets Traditional, which nobody notices until they do.
 */
export function resolveLocaleTag(locale, target, adapter) {
  const mapped = target.localeMap?.[locale]
  if (mapped) return { ok: true, tag: mapped }

  if (adapter.capabilities.needsLocaleMap) {
    const derived = adapter.localeTag?.(locale, target)
    if (derived) return { ok: true, tag: derived }
    return {
      ok: false,
      code: 'UNMAPPED_LOCALE',
      detail:
        `target "${target.name}" has no mapping for locale "${locale}". ` +
        `Add it to targets.${target.name}.localeMap. ` +
        `Guessing here silently breaks script variants like zh-Hans and sr-Latn.`,
    }
  }

  return { ok: true, tag: adapter.localeTag?.(locale, target) ?? locale }
}

/**
 * Messages that belong in a given target, with deprecated keys dropped.
 * Shared by every adapter so the filtering rule cannot drift between them.
 */
export function messagesForTarget(project, targetName) {
  const out = []
  for (const { namespace, key, entry } of project.entries()) {
    if (entry.deprecated) continue
    if (Array.isArray(entry.targets) && !entry.targets.includes(targetName)) continue
    out.push({ namespace, key, entry })
  }
  return out
}
