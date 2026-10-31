/**
 * ICU MessageFormat analysis.
 *
 * Everything that needs to understand a message goes through here: the
 * checker, the hasher, and every export adapter. Adapters receive a parsed
 * analysis rather than raw text, because four hand-rolled ICU parsers would be
 * four sets of subtly different bugs.
 *
 * The two properties worth knowing about:
 *
 *   argOrder is derived from the SOURCE message, once, and handed to every
 *   adapter. Android and Apple use positional arguments (%1$s, %1$@), and
 *   German and Japanese reorder clauses. Deriving positions from translated
 *   text scrambles arguments in exactly the languages nobody proofreads first.
 *
 *   A swallowed placeholder is detectable and worth detecting. In ICU an
 *   apostrophe before a brace opens a quoted literal, so the French
 *   `l'{name} chien` parses to the single literal `l{name} chien` and the
 *   placeholder disappears with no error. Comparing the braces in the raw text
 *   against the arguments the parser actually found catches it.
 */

import { parse, TYPE } from '@formatjs/icu-messageformat-parser'

export const MAX_NESTING_DEPTH = 3

/** How an argument is used, which is not always what it was declared as. */
export const ARG_KIND = {
  [TYPE.argument]: 'string',
  [TYPE.number]: 'number',
  [TYPE.date]: 'date',
  [TYPE.time]: 'time',
  [TYPE.select]: 'select',
  [TYPE.plural]: 'plural',
  [TYPE.tag]: 'tag',
}

export class IcuError extends Error {
  constructor(message, { code = 'ICU_PARSE', location } = {}) {
    super(message)
    this.name = 'IcuError'
    this.code = code
    this.location = location
  }
}

/**
 * Parser error kinds worth reporting as something more specific than "this did
 * not parse". The parser rejects these before analysis can see them, so the
 * mapping is what lets the checker still name the actual rule.
 */
const PARSER_ERROR_RULES = new Map([
  ['MISSING_OTHER_CLAUSE', 'PLURAL_OTHER_MISSING'],
])

const PARSER_ERROR_HINTS = new Map([
  ['MISSING_OTHER_CLAUSE', 'ICU requires an "other" branch on every plural, selectordinal, and select.'],
  ['EXPECT_ARGUMENT_CLOSING_BRACE', 'A placeholder was opened but never closed.'],
  ['INVALID_PLURAL_ARGUMENT_OPTION_VALUE', 'A plural branch is missing its {braces}.'],
  ['DUPLICATE_PLURAL_ARGUMENT_SELECTOR', 'The same plural category is listed twice.'],
  ['DUPLICATE_SELECT_ARGUMENT_SELECTOR', 'The same select branch is listed twice.'],
])

/** Parse, converting the parser's own error into ours with a usable position and rule. */
export function parseMessage(text) {
  try {
    return parse(text, { captureLocation: true })
  } catch (err) {
    const kind = err.message
    const at = err.location?.start
    const hint = PARSER_ERROR_HINTS.get(kind)
    throw new IcuError(
      [kind, at ? `at offset ${at.offset}` : null].filter(Boolean).join(' ') +
        (hint ? `. ${hint}` : ''),
      { code: PARSER_ERROR_RULES.get(kind) ?? 'ICU_PARSE', location: err.location, kind },
    )
  }
}

/**
 * Parse and describe a message.
 *
 * @param {string} text
 * @returns {{
 *   ast: unknown[],
 *   args: Map<string, {kinds: Set<string>, count: number}>,
 *   argOrder: string[],
 *   tags: string[],
 *   plurals: Array<{arg: string, pluralType: string, categories: string[], exact: string[], offset: number}>,
 *   selects: Array<{arg: string, options: string[]}>,
 *   constructs: Record<string, boolean|number|string[]>,
 * }}
 */
export function analyze(text) {
  const ast = parseMessage(text)

  const args = new Map()
  const argOrder = []
  const tags = []
  const plurals = []
  const selects = []
  let maxDepth = 0
  let poundOutsidePlural = 0
  let hasPound = false
  // A plain {n, number} and a styled {n, number, ::currency/EUR} are different
  // questions for an adapter: Android can write the first as %d and has no way
  // at all to write the second. Conflating them would either reject harmless
  // messages or export a currency with the wrong symbol.
  let hasSkeleton = false
  let hasPlainNumber = false
  let hasDateTime = false

  const note = (name, kind) => {
    let entry = args.get(name)
    if (!entry) {
      entry = { kinds: new Set(), count: 0 }
      args.set(name, entry)
      argOrder.push(name)
    }
    entry.kinds.add(kind)
    entry.count += 1
  }

  const walk = (nodes, depth, insidePlural) => {
    maxDepth = Math.max(maxDepth, depth)

    for (const node of nodes) {
      switch (node.type) {
        case TYPE.literal:
          break

        case TYPE.pound:
          hasPound = true
          // Defensive: the parser only emits pound inside a plural today, and
          // a bare # elsewhere stays literal text. If that ever changes, the
          // checker should hear about it rather than silently format wrong.
          if (!insidePlural) poundOutsidePlural += 1
          break

        case TYPE.argument:
          note(node.value, ARG_KIND[node.type])
          break

        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          note(node.value, ARG_KIND[node.type])
          if (node.style !== null && node.style !== undefined) hasSkeleton = true
          else if (node.type === TYPE.number) hasPlainNumber = true
          if (node.type === TYPE.date || node.type === TYPE.time) hasDateTime = true
          break

        case TYPE.tag:
          // Tags are tracked separately from arguments on purpose. A tag is a
          // rendering hook the caller supplies, not a value substituted into
          // the string, and conflating them makes a single lost <link> report
          // as both a missing placeholder and a missing tag.
          tags.push(node.value)
          walk(node.children ?? [], depth + 1, insidePlural)
          break

        case TYPE.plural: {
          note(node.value, node.pluralType === 'ordinal' ? 'selectordinal' : 'plural')
          const options = Object.keys(node.options ?? {})
          plurals.push({
            arg: node.value,
            pluralType: node.pluralType ?? 'cardinal',
            categories: options.filter((o) => !o.startsWith('=')).sort(),
            exact: options.filter((o) => o.startsWith('=')).sort(),
            offset: node.offset ?? 0,
          })
          for (const option of Object.values(node.options ?? {})) {
            walk(option.value ?? [], depth + 1, true)
          }
          break
        }

        case TYPE.select: {
          note(node.value, 'select')
          selects.push({ arg: node.value, options: Object.keys(node.options ?? {}).sort() })
          for (const option of Object.values(node.options ?? {})) {
            walk(option.value ?? [], depth + 1, insidePlural)
          }
          break
        }

        default:
          break
      }
    }
  }

  walk(ast, 1, false)

  const repeated = [...args.entries()].filter(([, v]) => v.count > 1).map(([k]) => k)

  return {
    ast,
    args,
    argOrder,
    tags: [...new Set(tags)].sort(),
    plurals,
    selects,
    constructs: {
      hasPlural: plurals.some((p) => p.pluralType !== 'ordinal'),
      hasSelectOrdinal: plurals.some((p) => p.pluralType === 'ordinal'),
      hasSelect: selects.length > 0,
      hasOffset: plurals.some((p) => p.offset !== 0),
      hasExactMatch: plurals.some((p) => p.exact.length > 0),
      hasTags: tags.length > 0,
      hasNumberOrDate: [...args.values()].some((v) =>
        ['number', 'date', 'time'].some((k) => v.kinds.has(k)),
      ),
      hasSkeleton,
      hasPlainNumber,
      hasDateTime,
      hasPound,
      poundOutsidePlural,
      maxDepth,
      repeated,
    },
  }
}

/**
 * A stable serialization of everything about a message that a translation must
 * preserve: which arguments exist, how each is used, and the shape of every
 * plural and select.
 *
 * This feeds sourceHash alongside the normalized text. Keeping it explicit is
 * what lets the checker tell a wording change (retranslate, cheap) from a
 * contract change (a human translation now misformats, and must be fixed
 * regardless of who wrote it).
 */
export function contractOf(analysis) {
  const args = [...analysis.args.entries()]
    .map(([name, v]) => `${name}:${[...v.kinds].sort().join('|')}`)
    .sort()
    .join(',')

  const plurals = analysis.plurals
    .map((p) => `${p.arg}/${p.pluralType}/${p.categories.join('+')}/${p.exact.join('+')}/o${p.offset}`)
    .sort()
    .join(',')

  const selects = analysis.selects.map((s) => `${s.arg}/${s.options.join('+')}`).sort().join(',')

  return `args(${args});plural(${plurals});select(${selects});tags(${analysis.tags.join('+')})`
}

/**
 * Braces the raw text appears to open, used to catch arguments the parser lost.
 * Deliberately loose: it only needs to spot `{identifier}` and `{identifier,`.
 */
function bracedNames(text) {
  const names = new Set()
  for (const match of text.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[,}]/g)) {
    names.add(match[1])
  }
  return names
}

/**
 * Findings about a single message on its own terms, independent of any
 * translation. Returns rule codes from ../src/rules.mjs.
 */
export function structuralFindings(text, analysis) {
  const findings = []

  const swallowed = [...bracedNames(text)].filter((name) => !analysis.args.has(name))
  if (swallowed.length > 0) {
    const quoted = /'[{}#]/.test(text)
    findings.push({
      code: 'ICU_APOSTROPHE_EATS_ARG',
      detail:
        `${swallowed.map((s) => `{${s}}`).join(', ')} ${swallowed.length === 1 ? 'is' : 'are'} written in the text but ` +
        `did not survive parsing` +
        (quoted
          ? `, because an apostrophe before a brace opens an ICU quoted literal. ` +
            `Use the typographic apostrophe U+2019 (’), which is correct typography and not an escape character. ` +
            `If you meant a literal brace, double the apostrophe ('').`
          : `.`),
    })
  }

  if (analysis.constructs.maxDepth > MAX_NESTING_DEPTH) {
    findings.push({
      code: 'NESTING_TOO_DEEP',
      detail: `nesting depth ${analysis.constructs.maxDepth} exceeds the supported maximum of ${MAX_NESTING_DEPTH}`,
    })
  }

  if (analysis.constructs.poundOutsidePlural > 0) {
    findings.push({
      code: 'HASH_ESCAPE',
      detail: 'a # appears outside any plural, where it has no number to bind to',
    })
  }

  for (const plural of analysis.plurals) {
    if (!plural.categories.includes('other')) {
      findings.push({
        code: 'PLURAL_OTHER_MISSING',
        detail: `plural on {${plural.arg}} has no "other" branch, which ICU requires`,
      })
    }
  }

  for (const select of analysis.selects) {
    if (!select.options.includes('other')) {
      findings.push({
        code: 'PLURAL_OTHER_MISSING',
        detail: `select on {${select.arg}} has no "other" branch, which ICU requires`,
      })
    }
  }

  return findings
}

/**
 * Compare a translation against its source.
 *
 * Splits the two failure modes deliberately. A differing argument set or a
 * flattened plural will misformat at runtime and is an error no matter who
 * wrote the translation. Everything else is the checker's business, not this
 * function's.
 */
export function compareStructure(source, translation) {
  const findings = []

  const srcArgs = new Set(source.args.keys())
  const transArgs = new Set(translation.args.keys())

  const missing = [...srcArgs].filter((a) => !transArgs.has(a))
  const extra = [...transArgs].filter((a) => !srcArgs.has(a))

  if (missing.length || extra.length) {
    const parts = []
    if (missing.length) parts.push(`dropped ${missing.map((a) => `{${a}}`).join(', ')}`)
    if (extra.length) parts.push(`introduced ${extra.map((a) => `{${a}}`).join(', ')}`)
    findings.push({ code: 'PLACEHOLDER_MISMATCH', detail: parts.join('; ') })
  }

  // A plural that became a bare placeholder still "has" the argument, so the
  // argument check above misses it. This is the common model failure.
  const srcPlurals = new Map(source.plurals.map((p) => [p.arg, p]))
  const transPlurals = new Map(translation.plurals.map((p) => [p.arg, p]))

  for (const [arg, srcPlural] of srcPlurals) {
    const transPlural = transPlurals.get(arg)
    if (!transPlural) {
      findings.push({
        code: 'PLURAL_STRUCTURE_MISMATCH',
        detail: `{${arg}} is a ${srcPlural.pluralType === 'ordinal' ? 'selectordinal' : 'plural'} in the source but not in the translation`,
      })
      continue
    }
    if (transPlural.pluralType !== srcPlural.pluralType) {
      findings.push({
        code: 'PLURAL_STRUCTURE_MISMATCH',
        detail: `{${arg}} is ${srcPlural.pluralType} in the source and ${transPlural.pluralType} in the translation`,
      })
    }
    if (transPlural.offset !== srcPlural.offset) {
      findings.push({
        code: 'PLURAL_STRUCTURE_MISMATCH',
        detail: `{${arg}} has offset ${srcPlural.offset} in the source and ${transPlural.offset} in the translation`,
      })
    }
  }

  for (const arg of transPlurals.keys()) {
    if (!srcPlurals.has(arg)) {
      findings.push({
        code: 'PLURAL_STRUCTURE_MISMATCH',
        detail: `{${arg}} is a plural in the translation but not in the source`,
      })
    }
  }

  const srcSelects = new Map(source.selects.map((s) => [s.arg, s]))
  for (const [arg, srcSelect] of srcSelects) {
    const transSelect = translation.selects.find((s) => s.arg === arg)
    if (!transSelect) {
      findings.push({
        code: 'PLURAL_STRUCTURE_MISMATCH',
        detail: `{${arg}} is a select in the source but not in the translation`,
      })
    } else if (srcSelect.options.join('+') !== transSelect.options.join('+')) {
      findings.push({
        code: 'PLURAL_STRUCTURE_MISMATCH',
        detail: `select on {${arg}} has branches ${srcSelect.options.join(', ')} in the source and ${transSelect.options.join(', ')} in the translation`,
      })
    }
  }

  const srcTags = source.tags.join('+')
  const transTags = translation.tags.join('+')
  if (srcTags !== transTags) {
    findings.push({
      code: 'TAG_MISMATCH',
      detail: `source has <${source.tags.join('>, <') || 'none'}>, translation has <${translation.tags.join('>, <') || 'none'}>`,
    })
  }

  return findings
}
