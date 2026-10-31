/**
 * Plain JSON of ICU strings to catalog entries. The format react-intl,
 * FormatJS, i18next and vue-i18n all land on, flat or nested.
 *
 * Nothing is converted, because the messages are already ICU. What this
 * importer adds is the surrounding apparatus: a key that fits the grammar, a
 * place for the comment that the format has nowhere to put, and the hashes
 * that make a later edit detectable. Every key arrives without a comment,
 * which is why `check` reports the backlog as a count rather than a wall.
 */

function flatten(value, prefix, out, findings, file) {
  for (const [name, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${name}` : name
    if (typeof child === 'string') {
      out.set(path, { message: child })
      continue
    }
    // react-intl's extracted form: { defaultMessage, description }.
    if (child && typeof child === 'object' && typeof child.defaultMessage === 'string') {
      out.set(path, { message: child.defaultMessage, comment: child.description ?? null })
      continue
    }
    if (child && typeof child === 'object') {
      flatten(child, path, out, findings, file)
      continue
    }
    findings.push({ code: 'IMPORT_UNREADABLE', detail: `"${path}" is ${typeof child}, not a string`, key: path, file })
  }
}

export function importIcuJson(text, { namespace = 'app', file = '<json>' } = {}) {
  const findings = []
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { entries: [], findings: [{ code: 'IMPORT_UNREADABLE', detail: `not valid JSON: ${err.message}`, file }] }
  }

  const flat = new Map()
  flatten(doc, '', flat, findings, file)

  const entries = []
  for (const [path, value] of flat) {
    const segments = path.split('.').map((s) =>
      s
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, ''),
    )
    const key = segments.length > 1 ? segments.join('.') : `${namespace}.${segments[0]}`
    const entry = { message: value.message }
    if (value.comment) entry.comment = value.comment
    // The original path is the lookup key the app already calls with, so it has
    // to survive even when the catalog key had to be reshaped.
    entry.platformNames = { web: path }
    entries.push({ namespace, key, entry })
  }

  return { entries, findings }
}

export default { id: 'icu-json', extensions: ['.json'], importText: importIcuJson }
