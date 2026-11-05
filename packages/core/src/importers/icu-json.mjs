import { analyze } from '../icu.mjs'

/**
 * Plain JSON of ICU strings to catalog entries. The format react-intl,
 * FormatJS, i18next and vue-i18n all land on, flat or nested.
 *
 * Also reads the `{ message, description }` shape, which hand-written
 * translators borrow from Chrome while keeping ICU text in `message`. That is
 * not the same format as Chrome's own: there are no `$NAME$` placeholders and a
 * dollar sign is just a dollar sign, so prices survive.
 *
 * Nothing is converted, because the messages are already ICU. What this
 * importer adds is the surrounding apparatus: a key that fits the grammar, a
 * place for the comment that the format has nowhere to put, and the hashes
 * that make a later edit detectable. Every key arrives without a comment,
 * which is why `check` reports the backlog as a count rather than a wall.
 */

const LEAF_KEYS = new Set(['message', 'description', 'comment', 'placeholders', 'meta'])

/** A `{ message }` node is a string, not a group, only if nothing unfamiliar rides along. */
function isLeaf(node) {
  return Object.keys(node).every((k) => LEAF_KEYS.has(k))
}

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
    // The `{ message, description }` form: Chrome's shape reused for ICU text by
    // hand-rolled translators. Only a node whose other keys are all recognised
    // counts, so a catalog that genuinely nests a group called `message` still
    // reads as a group.
    if (child && typeof child === 'object' && typeof child.message === 'string' && isLeaf(child)) {
      out.set(path, { message: child.message, comment: child.description ?? child.comment ?? null })
      continue
    }
    if (child && typeof child === 'object') {
      flatten(child, path, out, findings, file)
      continue
    }
    findings.push({ code: 'IMPORT_UNREADABLE', detail: `"${path}" is ${typeof child}, not a string`, key: path, file })
  }
}

/**
 * The arguments a message uses, so the catalog can declare them.
 *
 * Without this every imported message with a placeholder fails `check` on its
 * first run, and the team meets the kit as 200 errors about its own correct
 * code. Tags are ignored for the parse: a project with its own tag convention
 * (`<LAN-IP>` as plain text) would otherwise lose every declaration in the
 * file to one unparseable message.
 */
function argumentsOf(message) {
  for (const options of [{ ignoreTag: true }, {}]) {
    try {
      return [...analyze(message, options).args.keys()]
    } catch {
      // Try the other grammar, then give up: `check` reports the parse error
      // with a position, which is a better place to learn about it than here.
    }
  }
  return []
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
    // Declared, but with no example: the format has nowhere to record what an
    // argument holds, so that part stays a real gap for `check` to report.
    const args = argumentsOf(value.message)
    if (args.length) {
      entry.placeholders = Object.fromEntries(args.map((name) => [name, {}]))
    }
    // The original path is the lookup key the app already calls with, so it has
    // to survive even when the catalog key had to be reshaped.
    entry.platformNames = { web: path }
    entries.push({ namespace, key, entry })
  }

  return { entries, findings }
}

export default { id: 'icu-json', extensions: ['.json'], importText: importIcuJson }
