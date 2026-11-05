/**
 * Chrome extension `_locales/<locale>/messages.json` to catalog entries.
 *
 * The easiest of the importers, because Chrome already names its placeholders
 * and already has a `description` field. What it does not have is plurals: an
 * extension that needed one wrote two keys and an `if`, so there is nothing to
 * reconstruct and nothing is invented here.
 *
 * Chrome's placeholder names are case-insensitive and conventionally shouted
 * (`$COUNT$`). They are lowered to camelCase for ICU, and the original name is
 * recorded so export writes the file back the way Chrome expects it.
 */

const RESERVED = new Set(['@@extension_id', '@@ui_locale', '@@bidi_dir', '@@bidi_reversed_dir', '@@bidi_start_edge', '@@bidi_end_edge'])

function toArgName(name) {
  const parts = name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return 'arg'
  // ALLCAPS is Chrome's convention, not a word boundary, so lower it whole.
  const words = parts.flatMap((p) => (/^[A-Z0-9]+$/.test(p) ? [p.toLowerCase()] : p.split(/(?=[A-Z])/)))
  const [first, ...rest] = words.filter(Boolean)
  return first.toLowerCase() + rest.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}

function keyFor(name, namespace) {
  const underscore = name.indexOf('_')
  if (underscore > 0 && underscore < name.length - 1) {
    return `${name.slice(0, underscore)}.${name.slice(underscore + 1)}`.toLowerCase()
  }
  return `${namespace}.${name.toLowerCase()}`
}

export function importChrome(text, { namespace = 'app', file = '<chrome>' } = {}) {
  const entries = []
  const findings = []

  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { entries: [], findings: [{ code: 'IMPORT_UNREADABLE', detail: `not valid JSON: ${err.message}`, file }] }
  }

  for (const [name, value] of Object.entries(doc)) {
    const where = { key: name, file }

    if (typeof value?.message !== 'string') {
      findings.push({ code: 'IMPORT_UNREADABLE', detail: `"${name}" has no message string`, ...where })
      continue
    }

    const placeholders = {}
    const declared = value.placeholders ?? {}
    let message = value.message

    // `$$` is a literal dollar sign and must not be read as a placeholder.
    const DOLLAR = '\u0000dollar\u0000'
    message = message.replaceAll('$$', DOLLAR)

    message = message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, rawName) => {
      if (RESERVED.has(`@@${rawName.replace(/^@@/, '')}`) || rawName.startsWith('@@')) {
        findings.push({
          code: 'IMPORT_SKIPPED',
          detail: `"${name}" uses the Chrome predefined message ${whole}, which has no catalog equivalent. Resolve it at the call site instead.`,
          ...where,
        })
        return whole
      }
      const spec = Object.entries(declared).find(([k]) => k.toLowerCase() === rawName.toLowerCase())?.[1]
      const argName = toArgName(rawName)
      const entry = {}
      if (spec?.example) entry.example = spec.example
      placeholders[argName] = entry
      return `{${argName}}`
    })

    // `$14.99` is a price, but Chrome reads its `$1` as a substitution, so the
    // file is already wrong wherever this appears. Converting it would turn
    // money into `{arg1}4.99` and ship that in every language, so it is
    // reported and left alone. Guessing here is how a tool corrupts text that
    // nobody rereads once it is translated.
    message = message.replace(/\$(\d)(?=\d|[.,]\d)/g, (whole, digit) => {
      findings.push({
        code: 'IMPORT_DOLLAR_AMOUNT',
        detail: `"${name}" contains ${whole}, which Chrome reads as the positional $${digit} followed by digits, not as a dollar amount. Write $$ for a literal dollar sign. Left unchanged here rather than converted, so the text is not corrupted.`,
        ...where,
        catalogKey: keyFor(name, namespace),
      })
      // Hidden behind the sentinel so the positional pass below cannot eat it.
      return `${DOLLAR}${digit}`
    })

    // A bare `$1` with no placeholders block is legal Chrome and anonymous.
    message = message.replace(/\$(\d)/g, (_, digit) => {
      const argName = `arg${digit}`
      placeholders[argName] ??= {}
      findings.push({
        code: 'IMPORT_UNNAMED_ARG',
        detail: `"${name}" uses the positional $${digit} with no placeholders entry, so it became {${argName}}. Rename it in the catalog: a translator cannot work out what $${digit} holds.`,
        ...where,
        catalogKey: keyFor(name, namespace),
        arg: argName,
      })
      return `{${argName}}`
    })

    message = message.replaceAll(DOLLAR, '$')
    // ICU treats braces as structure, so any that survived from the source are literal.
    message = message.replace(/\{(?![a-zA-Z])/g, "'{'")

    const entry = { message }
    if (value.description) entry.comment = value.description
    if (Object.keys(placeholders).length) entry.placeholders = placeholders
    entry.platformNames = { chrome: name }

    entries.push({ namespace, key: keyFor(name, namespace), entry })
  }

  return { entries, findings }
}

export default { id: 'chrome', extensions: ['.json'], importText: importChrome }
