/**
 * Apple String Catalogs (`.xcstrings`) and legacy `.strings` to catalog entries.
 *
 * `.xcstrings` is JSON, so reading it is easy; the work is in its plural shape.
 * Xcode writes a plural as a SUBSTITUTION: the unit holds `%#@tabCount@` and a
 * sibling `substitutions` block holds that name's per-category variations, with
 * `%arg` standing for the number inside each branch. The older shape puts
 * `variations.plural` directly on the localization and has no name at all.
 * Both appear in real projects, so both are handled, and anything else is
 * reported rather than flattened to its `other` branch, which would silently
 * ship a singular to every German plural.
 *
 * Format specifiers are positional like Android's but spelled Apple's way:
 * `%@` for an object, `%lld` for a 64-bit integer. The same naming problem
 * applies, and the same finding is raised, because `.xcstrings` has no
 * equivalent of `<xliff:g>` to carry a name.
 */

const CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

const SPECIFIER_RE = /%(?:(\d+)\$)?(?:#@([A-Za-z_][\w]*)@|([-+ 0#]*)(\d+)?(?:\.(\d+))?(?:hh|h|ll|l|q|z|t|j|L)?([@aAdDeEfFgGiouUxXcCsSpn%]))/g

function escapeIcuLiteral(text, { inPlural }) {
  let out = text.replaceAll('{', "'{'").replaceAll('}', "'}'")
  if (inPlural) out = out.replaceAll('#', "'#'")
  return out
}

/**
 * Append a placeholder, doubling a trailing apostrophe first.
 *
 * `l'{name}` is the trap: ICU reads the apostrophe as opening a quoted section
 * and the placeholder comes out as the literal text `{name}`. French and
 * Italian hit this constantly. The fix is `l''{name}`, and it has to be decided
 * here rather than while escaping the literal, because at that point the
 * placeholder has not been emitted yet and there is nothing to look ahead to.
 *
 * Counted rather than tested, because an apostrophe that is already doubled is
 * a literal one and must be left alone.
 */
function appendPlaceholder(out, placeholder) {
  const trailing = /('+)$/.exec(out)?.[1].length ?? 0
  return (trailing % 2 === 1 ? `${out}'` : out) + placeholder
}

/** Convert one Apple format string, resolving `%#@name@` through `substitutions`. */
function toIcu(text, { substitutions = {}, inPlural = false, countName = null, placeholders, findings, name, file }) {
  let out = ''
  let cursor = 0
  let positional = 0

  for (const match of text.matchAll(SPECIFIER_RE)) {
    out += escapeIcuLiteral(text.slice(cursor, match.index), { inPlural })
    cursor = match.index + match[0].length

    const [, indexText, substitutionName, , , precision, conversion] = match

    if (conversion === '%') {
      out += '%'
      continue
    }

    if (substitutionName) {
      const spec = substitutions[substitutionName]
      const variations = spec?.variations?.plural
      if (!variations) {
        findings.push({
          code: 'IMPORT_UNREADABLE',
          detail: `"${name}" refers to the substitution %#@${substitutionName}@ but no plural variations are declared for it`,
          key: name,
          file,
        })
        out = appendPlaceholder(out, `{${substitutionName}}`)
        placeholders[substitutionName] = {}
        continue
      }
      const branches = []
      for (const category of ['zero', 'one', 'two', 'few', 'many', 'other']) {
        const value = variations[category]?.stringUnit?.value
        if (typeof value !== 'string') continue
        // `%arg` is this substitution's own number.
        const body = toIcu(value.replaceAll('%arg', '\u0000n\u0000'), {
          substitutions,
          inPlural: true,
          countName: substitutionName,
          placeholders,
          findings,
          name,
          file,
        }).replaceAll('\u0000n\u0000', '#')
        branches.push(`${category} {${body}}`)
      }
      out = appendPlaceholder(out, `{${substitutionName}, plural, ${branches.join(' ')}}`)
      placeholders[substitutionName] = {}
      continue
    }

    const index = indexText ? Number(indexText) : (positional += 1)
    if (inPlural && countName && index === 1 && /[diouU]/.test(conversion)) {
      out = appendPlaceholder(out, '#')
      continue
    }

    const argName = `arg${index}`
    const numeric = /[diouUeEfFgG]/.test(conversion)
    placeholders[argName] = {}
    findings.push({
      code: 'IMPORT_UNNAMED_ARG',
      detail:
        `"${name}" argument ${index} became {${argName}}, because an Apple format specifier carries no name. ` +
        `Rename it in the catalog. A string catalog has nowhere to record what an argument holds, so this is expected on import.`,
      key: name,
      arg: argName,
      file,
    })
    out = appendPlaceholder(
      out,
      numeric
        ? `{${argName}, number${precision !== undefined ? `, ::.${'0'.repeat(Number(precision))}` : ''}}`
        : `{${argName}}`,
    )
  }

  out += escapeIcuLiteral(text.slice(cursor), { inPlural })
  return out
}

function keyFor(name, namespace) {
  // An .xcstrings key is often the English text itself, which makes no kind of
  // catalog key. A key that cannot be reshaped gets a stable slug and keeps its
  // original in platformNames.
  const slug = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/, '')

  if (!slug) return `${namespace}.untitled`
  const underscore = slug.indexOf('_')
  if (underscore > 0 && underscore < slug.length - 1) {
    return `${slug.slice(0, underscore)}.${slug.slice(underscore + 1)}`
  }
  return `${namespace}.${slug}`
}

export function importXcstrings(text, { namespace = 'app', file = '<xcstrings>', sourceLocale = null } = {}) {
  const entries = []
  const findings = []

  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { entries: [], findings: [{ code: 'IMPORT_UNREADABLE', detail: `not valid JSON: ${err.message}`, file }] }
  }

  const source = sourceLocale ?? doc.sourceLanguage
  if (!source) {
    return { entries: [], findings: [{ code: 'IMPORT_UNREADABLE', detail: 'no sourceLanguage, and none was given', file }] }
  }

  const seen = new Map()

  for (const [name, record] of Object.entries(doc.strings ?? {})) {
    const localization = record.localizations?.[source]
    const placeholders = {}

    let raw
    let substitutions = localization?.substitutions ?? {}

    if (localization?.stringUnit?.value !== undefined) {
      raw = localization.stringUnit.value
    } else if (localization?.variations?.plural) {
      // The unnamed shape: the whole string varies, with no substitution name.
      const branches = []
      for (const category of ['zero', 'one', 'two', 'few', 'many', 'other']) {
        const value = localization.variations.plural[category]?.stringUnit?.value
        if (typeof value !== 'string') continue
        if (!CATEGORIES.has(category)) continue
        branches.push([category, value])
      }
      if (branches.length === 0) {
        findings.push({ code: 'IMPORT_UNREADABLE', detail: `"${name}" has plural variations with no usable branches`, key: name, file })
        continue
      }
      const converted = branches.map(
        ([category, value]) =>
          `${category} {${toIcu(value, { substitutions, inPlural: true, countName: 'count', placeholders, findings, name, file })}}`,
      )
      placeholders.count = {}
      const entry = { message: `{count, plural, ${converted.join(' ')}}` }
      if (record.comment) entry.comment = record.comment
      entry.placeholders = placeholders
      entry.platformNames = { apple: name }
      entries.push({ namespace, key: uniqueKey(keyFor(name, namespace), seen), entry })
      continue
    } else if (record.extractionState === 'stale') {
      findings.push({ code: 'IMPORT_SKIPPED', detail: `"${name}" is marked stale by Xcode and has no source value`, key: name, file })
      continue
    } else {
      // Xcode omits the source localization when the key IS the English text.
      raw = name
    }

    const message = toIcu(raw, { substitutions, placeholders, findings, name, file })
    const entry = { message }
    if (record.comment) entry.comment = record.comment
    if (Object.keys(placeholders).length) entry.placeholders = placeholders
    entry.platformNames = { apple: name }
    entries.push({ namespace, key: uniqueKey(keyFor(name, namespace), seen), entry })
  }

  return { entries, findings }
}

function uniqueKey(key, seen) {
  const count = (seen.get(key) ?? 0) + 1
  seen.set(key, count)
  return count === 1 ? key : `${key}_${count}`
}

/**
 * Legacy `.strings`: `"key" = "value";` with `/* *\/` comments.
 *
 * Supported because plenty of shipped apps still use it, but it carries no
 * plural information at all. Apple's plurals lived in a parallel
 * `.stringsdict` plist, which is not read here: an XML plist parser for a
 * format Apple has replaced is not worth the surface, and reporting the gap is
 * more honest than importing the singular and calling it done.
 */
export function importStrings(text, { namespace = 'app', file = '<strings>' } = {}) {
  const entries = []
  const findings = []
  const seen = new Map()

  // Comment, then "key" = "value";
  const ENTRY_RE = /(?:\/\*([\s\S]*?)\*\/\s*)?"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g
  const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))

  let matched = 0
  for (const match of text.matchAll(ENTRY_RE)) {
    matched += 1
    const [, comment, rawKey, rawValue] = match
    const name = unescape(rawKey)
    const placeholders = {}
    const message = toIcu(unescape(rawValue), { placeholders, findings, name, file })
    const entry = { message }
    if (comment?.trim()) entry.comment = comment.trim().replace(/\s+/g, ' ')
    if (Object.keys(placeholders).length) entry.placeholders = placeholders
    entry.platformNames = { apple: name }
    entries.push({ namespace, key: uniqueKey(keyFor(name, namespace), seen), entry })
  }

  if (matched === 0 && text.trim()) {
    findings.push({ code: 'IMPORT_UNREADABLE', detail: 'no "key" = "value"; pairs found', file })
  }

  return { entries, findings }
}

export default { id: 'apple', extensions: ['.xcstrings', '.strings'], importText: importXcstrings }
