/**
 * The Apple adapter: one `.xcstrings` String Catalog holding every locale.
 *
 * Unlike the others this emits a single file. Xcode keeps all languages in one
 * JSON document keyed by string, so the unit of output cannot be one file per
 * locale; this is the case the adapter contract's file-plan shape exists for.
 *
 * Plurals go out in Xcode's substitution form: the unit holds `%#@count@` and a
 * sibling `substitutions` block carries the per-category text, with `%arg`
 * standing for the number. That is what Xcode itself writes, so the file opens
 * in the String Catalog editor as a normal plural rather than as a string
 * containing a strange token.
 *
 * Every generated entry is marked `state: "translated"`, with one exception:
 * nothing is written at all for a locale that has no translation. A `needs_review`
 * placeholder would show up in Xcode as work in progress, and an empty value
 * would ship an empty string to a user. Absence lets Apple's own fallback to the
 * source language do its job.
 */

import { join } from 'node:path'
import { serializeJson, GENERATED_KEY, GENERATED_NOTICE, jsonIsOurs } from '../writer.mjs'
import { messagesForTarget } from './index.mjs'
import { renderMessage, argPositions, RenderError } from './render.mjs'
import { categoriesFor } from '../plurals.mjs'

const CATEGORY_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']

/** Apple's conversion letters. `%@` takes any object; `%lld` is the 64-bit integer Swift's Int becomes. */
const CONVERSION = { number: 'lld', string: '@', date: '@', time: '@' }

function unit(value) {
  return { state: 'translated', value }
}

/**
 * Render one message, pulling any plural out into a substitution.
 *
 * @returns {{value: string, substitutions: Record<string, object>}}
 */
function toApple(text, project, { positions, categories }) {
  const analysis = project.analysisOf(text)
  const substitutions = {}

  const value = renderMessage(analysis.ast, {
    // `%` introduces a conversion, so a literal one is doubled.
    literal: (literal) => literal.replaceAll('%', '%%'),
    arg: (name, kind) => {
      const index = positions.get(name)
      if (index === undefined) {
        throw new RenderError(`{${name}} is not an argument of the source message, so it has no position`)
      }
      return `%${index}$${CONVERSION[kind] ?? '@'}`
    },
    plural: (node, render) => {
      const index = positions.get(node.value)
      if (index === undefined) {
        throw new RenderError(`the plural argument {${node.value}} is not an argument of the source message`)
      }
      const variations = {}
      for (const category of CATEGORY_ORDER) {
        if (!categories.includes(category)) continue
        const option = node.options?.[category] ?? node.options?.other
        if (!option) continue
        // Inside a substitution branch the number is `%arg`, not a positional
        // conversion: Xcode binds it to the substitution's own argNum.
        const branch = renderMessage(option.value ?? [], {
          literal: (literal) => literal.replaceAll('%', '%%'),
          arg: (name, kind) => {
            const argIndex = positions.get(name)
            if (argIndex === undefined) {
              throw new RenderError(`{${name}} is not an argument of the source message, so it has no position`)
            }
            return `%${argIndex}$${CONVERSION[kind] ?? '@'}`
          },
          pound: () => '%arg',
        })
        variations[category] = { stringUnit: unit(branch) }
      }
      substitutions[node.value] = {
        argNum: index,
        formatSpecifier: 'lld',
        variations: { plural: variations },
      }
      return `%#@${node.value}@`
    },
  })

  return { value, substitutions }
}

export default {
  id: 'apple',

  capabilities: {
    plurals: 'variations',
    exactMatch: false,
    select: false,
    selectordinal: false,
    offset: false,
    nesting: 2,
    placeholders: 'positional',
    repeatedPlaceholders: true,
    numberArgs: true,
    dateTimeArgs: false,
    numberDateSkeletons: false,
    richText: false,
    comments: 'full',
    needsLocaleMap: false,
  },

  /** Apple uses BCP 47, script subtags included: `zh-Hans`, `pt-BR`. */
  localeTag(locale) {
    return locale
  },

  isOurs: jsonIsOurs,

  emit({ project, config, target }) {
    const outDir = target.out ?? join(config.paths.out, target.name)
    const messages = messagesForTarget(project, target.name)
    const strings = {}

    // Apple's own fallback covers the source language, so in sync mode the
    // source localization is left out and Xcode uses the key's own value.
    const includeSource = config.source?.mode === 'adopt'

    for (const { namespace, key, entry } of messages) {
      const sourceAnalysis = project.tryAnalysisOf(entry.message)
      if (!sourceAnalysis) continue
      const positions = argPositions(sourceAnalysis)
      const name = entry.platformNames?.apple ?? key
      const localizations = {}

      const add = (locale, text) => {
        if (typeof text !== 'string') return
        const { value, substitutions } = toApple(text, project, {
          positions,
          categories: categoriesFor(locale),
        })
        const record = { stringUnit: unit(value) }
        if (Object.keys(substitutions).length) {
          // With substitutions the unit itself is the frame, and Xcode wants
          // the frame marked as not needing translation of its own.
          record.substitutions = substitutions
        }
        localizations[locale] = record
      }

      if (includeSource) add(config.sourceLocale, entry.message)
      for (const locale of config.targetLocales()) {
        add(locale, project.translationEntry(locale, namespace, key)?.message)
      }

      const record = { extractionState: 'manual' }
      if (entry.comment) record.comment = entry.comment
      record.localizations = localizations
      strings[name] = record
    }

    return [
      {
        path: join(outDir, `${target.options?.catalogName ?? 'Localizable'}.xcstrings`),
        contents: serializeJson({
          [GENERATED_KEY]: GENERATED_NOTICE,
          sourceLanguage: config.sourceLocale,
          strings,
          version: '1.0',
        }),
        generated: true,
        isOurs: jsonIsOurs,
      },
    ]
  },
}
