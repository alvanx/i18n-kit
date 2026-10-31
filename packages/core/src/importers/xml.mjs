/**
 * A deliberately small XML reader for Android resource files.
 *
 * Not a general XML parser, and it should not grow into one. It understands
 * exactly the subset `res/values/strings.xml` uses: a declaration, comments,
 * elements with attributes, CDATA, character entities, and nested inline
 * markup. Anything outside that subset throws rather than being guessed at.
 *
 * Throwing is the point. A parser that quietly mishandles an unfamiliar
 * construct produces a catalog that looks fine and ships the wrong text, and
 * the mistake surfaces in a language nobody on the team reads. A thrown error
 * naming a line number surfaces now.
 *
 * Inline markup is kept as RAW TEXT, not parsed into children. Android allows a
 * small HTML subset inside a string (`<b>`, `<i>`, `<a href>`), and ICU uses
 * the same angle-bracket syntax for rich text, so the bytes pass straight
 * through. Only `xliff:g` is pulled apart, because it carries the placeholder
 * documentation that makes a translation reviewable.
 */

export class XmlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message)
    this.name = 'XmlError'
    this.line = line ?? null
  }
}

const NAME_RE = /[A-Za-z_][\w.:-]*/y

/** Resolve the five predefined entities plus numeric references. Anything else is an error. */
export function decodeEntities(text, lineOf = () => null) {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z][\w.-]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code)) throw new XmlError(`Bad numeric entity ${match}`, lineOf(match))
      return String.fromCodePoint(code)
    }
    switch (body) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default:
        // A named entity we do not know would need a DTD to resolve. Android
        // resources do not use one, so this is a genuine surprise.
        throw new XmlError(`Unknown entity ${match}. Only &amp; &lt; &gt; &quot; &apos; and numeric references are supported.`, lineOf(match))
    }
  })
}

/**
 * Parse into a shallow tree.
 *
 * A node is `{ name, attrs, children, raw, line }` where `children` holds child
 * elements and `raw` holds the element's inner source text verbatim, entities
 * and all. Callers that want the text decode `raw` themselves, which keeps the
 * decision about inline markup with the importer rather than here.
 *
 * Comments are attached as `{ comment, line }` entries in the parent's
 * `children`, in document order, because in `strings.xml` the comment above a
 * string is the only developer context there is.
 */
export function parseXml(text) {
  let i = 0
  const lineAt = (offset) => text.slice(0, offset).split('\n').length
  const root = { name: '#document', attrs: {}, children: [], raw: text, line: 1 }
  const stack = [root]

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1
  }

  const readName = () => {
    NAME_RE.lastIndex = i
    const match = NAME_RE.exec(text)
    if (!match) throw new XmlError('Expected an element or attribute name', lineAt(i))
    i = NAME_RE.lastIndex
    return match[0]
  }

  while (i < text.length) {
    const next = text.indexOf('<', i)

    if (next === -1) {
      if (text.slice(i).trim()) throw new XmlError('Trailing text outside any element', lineAt(i))
      break
    }

    // Character data before this tag belongs to the open element. Only the
    // document level is required to be blank.
    if (next > i && stack.length === 1 && text.slice(i, next).trim()) {
      throw new XmlError('Text outside the root element', lineAt(i))
    }
    i = next

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i)
      if (end === -1) throw new XmlError('Unterminated comment', lineAt(i))
      stack.at(-1).children.push({ comment: text.slice(i + 4, end).trim(), line: lineAt(i) })
      i = end + 3
      continue
    }

    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i)
      if (end === -1) throw new XmlError('Unterminated CDATA section', lineAt(i))
      i = end + 3
      continue
    }

    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i)
      if (end === -1) throw new XmlError('Unterminated processing instruction', lineAt(i))
      i = end + 2
      continue
    }

    if (text.startsWith('<!DOCTYPE', i)) {
      throw new XmlError('A DOCTYPE is not supported. Android resource files do not need one, and resolving its entities would mean implementing a DTD parser.', lineAt(i))
    }

    if (text.startsWith('</', i)) {
      i += 2
      const line = lineAt(i)
      const name = readName()
      skipSpace()
      if (text[i] !== '>') throw new XmlError(`Malformed closing tag for <${name}>`, line)
      i += 1
      const open = stack.pop()
      if (!open || open.name !== name) {
        throw new XmlError(`Closing </${name}> does not match <${open?.name ?? 'nothing'}>`, line)
      }
      open.raw = text.slice(open.contentStart, next)
      delete open.contentStart
      continue
    }

    // An opening tag.
    i += 1
    const line = lineAt(i)
    const name = readName()
    const attrs = {}

    for (;;) {
      skipSpace()
      if (text[i] === '>' || text.startsWith('/>', i)) break
      const attrName = readName()
      skipSpace()
      if (text[i] !== '=') throw new XmlError(`Attribute ${attrName} on <${name}> has no value`, line)
      i += 1
      skipSpace()
      const quote = text[i]
      if (quote !== '"' && quote !== "'") throw new XmlError(`Attribute ${attrName} on <${name}> must be quoted`, line)
      i += 1
      const end = text.indexOf(quote, i)
      if (end === -1) throw new XmlError(`Unterminated value for ${attrName} on <${name}>`, line)
      attrs[attrName] = decodeEntities(text.slice(i, end), () => line)
      i = end + 1
    }

    const selfClosing = text.startsWith('/>', i)
    i += selfClosing ? 2 : 1

    const node = { name, attrs, children: [], raw: '', line }
    stack.at(-1).children.push(node)
    if (!selfClosing) {
      node.contentStart = i
      stack.push(node)
    }
  }

  if (stack.length !== 1) {
    const open = stack.at(-1)
    throw new XmlError(`<${open.name}> is never closed`, open.line)
  }

  return root
}

/** Child elements with a given name. */
export function childrenNamed(node, name) {
  return node.children.filter((c) => c.name === name)
}

/** The comment immediately above a node, which is where Android keeps its context. */
export function commentBefore(parent, node) {
  const index = parent.children.indexOf(node)
  const lines = []
  for (let n = index - 1; n >= 0; n -= 1) {
    const sibling = parent.children[n]
    if (sibling.comment === undefined) break
    lines.unshift(sibling.comment)
  }
  if (lines.length === 0) return null
  // A wrapped comment is one thought across several lines, so join it back up.
  return lines.join(' ').replace(/\s+/g, ' ').trim() || null
}
