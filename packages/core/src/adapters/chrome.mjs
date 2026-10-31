/**
 * The Chrome extension adapter: `_locales/<tag>/messages.json`.
 *
 * The most limited of the four formats. It substitutes placeholders and nothing
 * else: no plurals, no select, no number formatting. An extension that needs a
 * plural has always written two keys and picked between them in code, so there
 * is no lossy conversion on offer here and the capability matrix says plainly
 * that a plural cannot be expressed. `check` then names the key before export
 * runs, instead of Chrome shipping the `other` branch to every count.
 *
 * `description` is written only into the default locale. Chrome reads it from
 * nowhere else, and repeating it into every translation file would be forty
 * copies of a sentence no translator will see.
 */

import { join } from 'node:path'
import { serializeJson, GENERATED_KEY, GENERATED_NOTICE, jsonIsOurs } from '../writer.mjs'
import { messagesForTarget } from './index.mjs'
import { renderMessage, argPositions, RenderError } from './render.mjs'

/** Chrome placeholder names are conventionally shouted and must be [A-Za-z0-9_]. */
const toPlaceholderName = (name) => name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()

function toChrome(text, project, { positions, placeholders, entry }) {
  const analysis = project.analysisOf(text)

  const message = renderMessage(analysis.ast, {
    // `$` introduces a placeholder, so a literal one has to be doubled.
    literal: (value) => value.replaceAll('$', '$$'),
    arg: (name, kind) => {
      const index = positions.get(name)
      if (index === undefined) {
        throw new RenderError(`{${name}} is not an argument of the source message, so it has no position`)
      }
      if (index > 9) {
        // Chrome's substitution syntax only reaches $9.
        throw new RenderError(`{${name}} is argument ${index}, and Chrome substitutions stop at $9`)
      }
      const placeholderName = toPlaceholderName(name)
      const spec = { content: `$${index}` }
      const example = entry.placeholders?.[name]?.example
      if (example !== undefined) spec.example = String(example)
      placeholders[placeholderName] = spec
      if (kind !== 'string') {
        // Chrome pastes the value in as given, so a number arrives with the
        // caller's digits and grouping, not the locale's.
        spec.content = `$${index}`
      }
      return `$${placeholderName}$`
    },
  })

  return message
}

export default {
  id: 'chrome',

  capabilities: {
    plurals: 'none',
    exactMatch: false,
    select: false,
    selectordinal: false,
    offset: false,
    nesting: 1,
    placeholders: 'named',
    repeatedPlaceholders: true,
    numberArgs: true,
    dateTimeArgs: false,
    numberDateSkeletons: false,
    richText: false,
    comments: 'default-locale-only',
    needsLocaleMap: true,
  },

  /**
   * Chrome's `_locales` directory names.
   *
   * It takes `de`, `pt_BR`, `zh_CN` and so on, with an underscore. It has no
   * spelling for a script subtag: Simplified Chinese is `zh_CN`, which is a
   * region standing in for a script. Deriving that would mean deciding that
   * every `zh-Hans` reader is in mainland China, so anything carrying a script
   * returns null and config demands an explicit mapping.
   */
  localeTag(locale) {
    const parts = locale.split('-')
    const hasScript = parts.some((part) => /^[A-Z][a-z]{3}$/.test(part))
    if (hasScript) return null
    return parts.length === 1 ? parts[0] : `${parts[0]}_${parts[1].toUpperCase()}`
  },

  isOurs: jsonIsOurs,

  emit({ project, config, target }) {
    const outDir = target.out ?? join(config.paths.out, target.name)
    const messages = messagesForTarget(project, target.name)
    const files = []

    const locales = config.source?.mode === 'adopt' ? [config.sourceLocale, ...config.targetLocales()] : config.targetLocales()

    for (const locale of locales) {
      const isSource = locale === config.sourceLocale
      const tag = target.localeMap?.[locale] ?? this.localeTag(locale)
      const body = {}

      for (const { namespace, key, entry } of messages) {
        const text = isSource ? entry.message : project.translationEntry(locale, namespace, key)?.message
        if (typeof text !== 'string') continue

        const sourceAnalysis = project.tryAnalysisOf(entry.message)
        if (!sourceAnalysis) continue

        const name = entry.platformNames?.chrome ?? key.replaceAll('.', '_')
        const placeholders = {}
        const message = toChrome(text, project, { positions: argPositions(sourceAnalysis), placeholders, entry })

        const record = { message }
        if (isSource && entry.comment) record.description = entry.comment
        if (Object.keys(placeholders).length) record.placeholders = placeholders
        body[name] = record
      }

      files.push({
        // The marker lives in a reserved key rather than a comment, because
        // messages.json is strict JSON and Chrome rejects a comment outright.
        path: join(outDir, '_locales', tag, 'messages.json'),
        contents: serializeJson({ [GENERATED_KEY]: { message: GENERATED_NOTICE }, ...body }),
        generated: true,
        isOurs: jsonIsOurs,
      })
    }

    return files
  },
}
