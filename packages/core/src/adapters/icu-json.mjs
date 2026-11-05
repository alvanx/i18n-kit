/**
 * The adapter that writes back what the `icu-json` importer read.
 *
 * Every importer needs one, or sync mode cannot close its loop: a project whose
 * strings live in `locales/<locale>/<area>.json` could have its English read in
 * and its German translated, and then have nowhere to put the German. The
 * reference `web` adapter writes the kit's own layout, which is the right
 * default for a new project and the wrong one for a project that already ships.
 *
 * So this adapter's whole job is fidelity to a layout it did not choose: the
 * file name comes from the namespace, the key from `platformNames.web`, and the
 * shape from `options.shape`. Nothing here is prettier than what it replaces,
 * on purpose. A format change nobody asked for is a diff nobody can review.
 *
 * Capabilities are the `web` adapter's: this writes ICU through untouched, and
 * a project whose own formatter reads less than full ICU narrows them on the
 * target (`capabilities` in config).
 */

import { join } from 'node:path'
import { serializeJson, GENERATED_KEY, GENERATED_NOTICE, jsonIsOurs } from '../writer.mjs'
import web from './web.mjs'
import { messagesForTarget } from './index.mjs'

export default {
  id: 'icu-json',
  capabilities: web.capabilities,

  localeTag(locale) {
    return locale
  },

  isOurs: jsonIsOurs,

  emit({ project, config, target }) {
    const outDir = target.out ?? join(config.paths.out, target.name)
    const prefix = target.options.namespacePrefix ?? ''
    const shape = target.options.shape ?? 'message-object'
    const layout = target.options.layout ?? 'locale-dir'
    const writeSource = config.source.mode === 'adopt'

    // Only this target's own namespaces. A project with an extension and a
    // console has two sets of files with the same area names in both, so the
    // namespaces have to be prefixed to stay unique, and the prefix comes back
    // off here.
    const mine = messagesForTarget(project, target.name).filter(
      (m) => prefix === '' || m.namespace.startsWith(prefix),
    )

    const locales = writeSource
      ? [config.sourceLocale, ...config.targetLocales()]
      : config.targetLocales()

    const files = []

    for (const locale of locales) {
      const isSource = locale === config.sourceLocale
      /** @type {Map<string, Record<string, unknown>>} */
      const byFile = new Map()

      for (const { namespace, key, entry } of mine) {
        const area = prefix ? namespace.slice(prefix.length) : namespace
        const name = layout === 'flat' ? locale : area
        if (!byFile.has(name)) byFile.set(name, {})
        const body = byFile.get(name)

        // The key the app already calls with, not the one the catalog reshaped
        // it into. Renaming every lookup is not a translation change.
        const outKey = entry.platformNames?.web ?? key

        let text
        if (isSource) {
          text = entry.message
        } else {
          const translation = project.translationEntry(locale, namespace, key)
          // Omitted, never filled with English: a file that looks complete
          // while shipping the source language is the failure this refuses.
          if (typeof translation?.message !== 'string') continue
          text = translation.message
        }

        if (shape === 'plain') {
          body[outKey] = text
        } else {
          const value = { message: text }
          // The comment travels with the source only. A translator's own file
          // is not where the next translator reads the brief.
          if (isSource && entry.comment) value.description = entry.comment
          body[outKey] = value
        }
      }

      for (const [name, body] of byFile) {
        if (Object.keys(body).length === 0) continue
        files.push({
          path:
            layout === 'flat'
              ? join(outDir, `${locale}.json`)
              : join(outDir, locale, `${name}.json`),
          // The notice goes in the file, because a generated file that looks
          // hand-written gets hand-edited and the edit disappears on the next
          // export. `plain` has nowhere to put it without inventing a key the
          // app would then try to render.
          contents: serializeJson(shape === 'plain' ? body : { [GENERATED_KEY]: GENERATED_NOTICE, ...body }),
          generated: true,
          isOurs: jsonIsOurs,
        })
      }
    }

    return files
  },
}
