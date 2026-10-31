/**
 * Android `res/values/strings.xml` to catalog entries.
 *
 * The conversion that matters is printf to ICU. Android numbers its arguments
 * (`%1$s`, `%2$d`) and ICU names them, and a name is not recoverable from a
 * number. Three sources are tried in order, and the importer says which it
 * used so a human can improve the worst case:
 *
 *   1. `<xliff:g id="device" example="Phone">%1$s</xliff:g>`, the documented
 *      Android way to say what an argument is. This is the good case: it gives
 *      a name AND an example, which is most of what a translator needs.
 *   2. The plural count, which is `%1$d` by convention because
 *      getQuantityString takes the quantity first. Named `count`.
 *   3. `arg2`, with a finding. A translation prompt containing `{arg2}` is
 *      measurably worse than one containing `{senderDevice}`, so this is
 *      reported rather than quietly accepted.
 *
 * The original resource name is recorded on each entry. Export uses it
 * verbatim, so a round trip through the catalog returns the same name even
 * where the catalog key had to be reshaped to fit the key grammar.
 */

import { parseXml, childrenNamed, commentBefore, decodeEntities, XmlError } from './xml.mjs'

/** Android quantity values are CLDR category names already. */
const QUANTITIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

/**
 * Is this comment a section header rather than a description?
 *
 * `<!-- Notifications -->` above a run of strings labels the group; it does not
 * describe the string below it. Treating it as that string's context would
 * attach "Notifications" to one string and leave the other nine with nothing.
 * Carried as a group label instead, which is real context for every string in
 * the run.
 */
function looksLikeSectionHeader(comment) {
  if (!comment) return false
  if (/[.!?;:]$/.test(comment)) return false
  return comment.split(/\s+/).length <= 4
}

/**
 * Undo Android's string escaping.
 *
 * Android collapses runs of whitespace in an unquoted string and strips the
 * ends, which is why a wrapped `<string>` in a hand-formatted file does not
 * ship with its newlines. A string wrapped in literal double quotes keeps its
 * whitespace exactly.
 */
function unescapeAndroid(raw) {
  const decoded = decodeEntities(raw)
  const quoted = /^"[\s\S]*"$/.test(decoded.trim())
  const body = quoted ? decoded.trim().slice(1, -1) : decoded.replace(/\s+/g, ' ').trim()

  return body.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'u': return '\\u' // left alone; a \uXXXX escape is handled by the XML layer
      default: return ch // \' \" \@ \? \\ all stand for themselves
    }
  })
}

/** Text that is literal in ICU, with ICU's own metacharacters escaped. */
function escapeIcuLiteral(text, { inPlural }) {
  let out = text.replaceAll('{', "'{'").replaceAll('}', "'}'")
  // Inside a plural branch `#` is the formatted number, so a literal one needs
  // escaping too.
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

const PRINTF_RE = /%(?:(\d+)\$)?([-+ 0#,]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g

/**
 * Convert one Android string body to ICU.
 *
 * @param {string} body            unescaped Android text
 * @param {Map<number,{name:string,example?:string}>} names  known argument names by 1-based index
 * @param {{inPlural?: boolean, countIndex?: number|null}} opts
 */
function toIcu(body, names, { inPlural = false, countIndex = null } = {}) {
  const used = new Map()
  let out = ''
  let cursor = 0
  let positional = 0
  let sawUnindexed = false
  let sawIndexed = false

  for (const match of body.matchAll(PRINTF_RE)) {
    out += escapeIcuLiteral(body.slice(cursor, match.index), { inPlural })
    cursor = match.index + match[0].length

    const [, indexText, , , precision, conversion] = match

    if (conversion === '%') {
      out += '%'
      continue
    }

    let index
    if (indexText) {
      sawIndexed = true
      index = Number(indexText)
    } else {
      sawUnindexed = true
      positional += 1
      index = positional
    }

    const known = names.get(index)
    const name = known?.name ?? (index === countIndex ? 'count' : `arg${index}`)

    if (index === countIndex && inPlural) {
      // The plural's own number. ICU writes it as `#`, which carries the
      // locale's digits and grouping.
      out = appendPlaceholder(out, '#')
    } else if (conversion === 'd' || conversion === 'f' || conversion === 'e' || conversion === 'g') {
      // A number argument, so say so: ICU then applies the locale's digits,
      // decimal separator, and grouping, which printf would not.
      const skeleton = precision !== undefined ? `, number, ::.${'0'.repeat(Number(precision))}` : ', number'
      out = appendPlaceholder(out, `{${name}${skeleton}}`)
    } else {
      out = appendPlaceholder(out, `{${name}}`)
    }

    used.set(index, { name, conversion, example: known?.example ?? null })
  }

  out += escapeIcuLiteral(body.slice(cursor), { inPlural })

  return { icu: out, used, mixedIndexing: sawIndexed && sawUnindexed }
}

/**
 * Pull `<xliff:g>` out of a raw element body, returning the plain body plus
 * whatever the markup said about each argument.
 *
 * The id is the argument name and the example is the sample value, both of
 * which the prompt uses directly. This is the one piece of inline markup worth
 * parsing rather than passing through.
 */
function extractXliff(raw) {
  const names = new Map()
  let seen = 0

  const stripped = raw.replace(
    /<xliff:g\b([^>]*)>([\s\S]*?)<\/xliff:g>/g,
    (_, attrText, inner) => {
      seen += 1
      const id = /\bid\s*=\s*(["'])(.*?)\1/.exec(attrText)?.[2] ?? null
      const example = /\bexample\s*=\s*(["'])(.*?)\1/.exec(attrText)?.[2] ?? null
      const index = Number(/%(\d+)\$/.exec(inner)?.[1] ?? seen)
      if (id) names.set(index, { name: toArgName(id), example })
      else if (example) names.set(index, { name: `arg${index}`, example })
      return inner
    },
  )

  return { body: stripped, names }
}

/** An xliff id may be written in any style; ICU argument names are camelCase here. */
function toArgName(id) {
  const parts = id.trim().split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return 'arg'
  const [first, ...rest] = parts
  return first.toLowerCase() + rest.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('')
}

/**
 * A catalog key for an Android resource name.
 *
 * The key grammar wants at least two dot-separated segments, so the first
 * underscore becomes a dot: `batch_summary_title` reads as `batch.summary_title`
 * and converts straight back. A name with no underscore gets the namespace as
 * its first segment; `platformNames` then carries the original so export is
 * still byte-exact.
 */
function keyFor(resourceName, namespace) {
  const underscore = resourceName.indexOf('_')
  if (underscore > 0 && underscore < resourceName.length - 1) {
    return `${resourceName.slice(0, underscore)}.${resourceName.slice(underscore + 1)}`
  }
  return `${namespace}.${resourceName}`
}

/**
 * @param {string} text       file contents
 * @param {{namespace?: string, file?: string, locale?: string}} opts
 * @returns {{entries: Array<object>, findings: Array<object>}}
 */
export function importAndroid(text, { namespace = 'app', file = '<android>' } = {}) {
  const entries = []
  const findings = []
  const note = (code, detail, where = {}) => findings.push({ code, detail, file, ...where })

  let doc
  try {
    doc = parseXml(text)
  } catch (err) {
    if (err instanceof XmlError) {
      return { entries: [], findings: [{ code: 'IMPORT_UNREADABLE', detail: err.message, file }] }
    }
    throw err
  }

  const resources = doc.children.find((c) => c.name === 'resources')
  if (!resources) {
    return { entries: [], findings: [{ code: 'IMPORT_UNREADABLE', detail: 'No <resources> element', file }] }
  }

  let group = null

  for (const node of resources.children) {
    if (node.comment !== undefined) {
      if (looksLikeSectionHeader(node.comment)) group = node.comment
      continue
    }

    const name = node.attrs?.name
    const where = { key: name, line: node.line }

    if (node.name === 'string-array' || node.name === 'integer-array' || node.name === 'array') {
      note('IMPORT_SKIPPED', `<${node.name} name="${name}"> has no catalog equivalent: a list of strings is not one message. Split it into numbered keys if its contents are user-facing.`, where)
      continue
    }
    if (node.name !== 'string' && node.name !== 'plurals') {
      note('IMPORT_SKIPPED', `<${node.name}> is not a string resource`, where)
      continue
    }
    if (!name) {
      note('IMPORT_UNREADABLE', `<${node.name}> has no name attribute`, where)
      continue
    }
    if (node.attrs.translatable === 'false') continue

    const rawComment = commentBefore(resources, node)
    const comment = looksLikeSectionHeader(rawComment) ? null : rawComment
    const key = keyFor(name, namespace)

    let message
    let used = new Map()

    try {
    if (node.name === 'string') {
      const { body, names } = extractXliff(node.raw)
      const converted = toIcu(unescapeAndroid(body), names, {})
      message = converted.icu
      used = converted.used
      if (converted.mixedIndexing) {
        note('IMPORT_AMBIGUOUS', `"${name}" mixes %s with %1$s. Android resolves the unindexed ones left to right; confirm the imported argument names are right.`, where)
      }
    } else {
      const items = childrenNamed(node, 'item')
      if (items.length === 0) {
        note('IMPORT_UNREADABLE', `<plurals name="${name}"> has no items`, where)
        continue
      }

      const branches = []
      let countName = 'count'

      for (const item of items) {
        const quantity = item.attrs.quantity
        if (!QUANTITIES.has(quantity)) {
          note('IMPORT_UNREADABLE', `<item quantity="${quantity}"> in "${name}" is not a CLDR category`, where)
          continue
        }
        const { body, names } = extractXliff(item.raw)
        // getQuantityString passes the quantity first, so argument 1 is the
        // count whenever the branch formats a number at all.
        const converted = toIcu(unescapeAndroid(body), names, { inPlural: true, countIndex: 1 })
        for (const [index, info] of converted.used) used.set(index, info)
        if (names.get(1)?.name) countName = names.get(1).name
        branches.push([quantity, converted.icu])
      }

      if (branches.length === 0) continue

      // CLDR order, so the exported file and the catalog read the same way.
      const order = ['zero', 'one', 'two', 'few', 'many', 'other']
      branches.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      message = `{${countName}, plural, ${branches.map(([q, body]) => `${q} {${body}}`).join(' ')}}`
      used.set(1, { name: countName, conversion: 'd', example: null })
    }
    } catch (err) {
      // Most likely an entity with no definition, which would need a DTD to
      // resolve. One unreadable string must not stop the other fifty-six.
      note('IMPORT_UNREADABLE', `"${name}" could not be read: ${err.message}`, where)
      continue
    }

    const placeholders = {}
    for (const [index, info] of [...used].sort((a, b) => a[0] - b[0])) {
      const entry = {}
      if (info.example) entry.example = info.example
      if (/^arg\d+$/.test(info.name)) {
        note(
          'IMPORT_UNNAMED_ARG',
          `"${name}" argument ${index} became {${info.name}}, because %${index}$${info.conversion} carries no name. ` +
            `Rename it in the catalog, or wrap it in <xliff:g id="..."> in strings.xml. ` +
            `A translator shown {${info.name}} cannot tell a device name from a person's name.`,
          { ...where, catalogKey: key, arg: info.name },
        )
      }
      placeholders[info.name] = entry
    }

    const entry = { message }
    if (comment) entry.comment = comment
    if (group) entry.group = group
    if (Object.keys(placeholders).length) entry.placeholders = placeholders
    entry.platformNames = { android: name }

    entries.push({ namespace, key, entry })
  }

  return { entries, findings }
}

export default {
  id: 'android',
  extensions: ['.xml'],
  importText: importAndroid,
}
