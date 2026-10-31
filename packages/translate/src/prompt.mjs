/**
 * Assembling what the model is told.
 *
 * Everything here exists because of a specific way machine translation of UI
 * strings goes wrong, and the fix for almost all of them is context rather than
 * a better model.
 *
 *   "Open" alone is a verb or an adjective, a button or a status. The developer
 *   comment resolves it, which is why `check` refuses a new key without one.
 *
 *   A placeholder's example turns {device} from an unknown into "Phone", and
 *   the surrounding grammar depends on that: German needs to know whether the
 *   thing being named is a device or a person.
 *
 *   Strings on one screen have to agree with each other. Translated one at a
 *   time, "Senden" and "Abschicken" both appear. So each batch carries the
 *   already-settled translations from the same group as binding precedent.
 *
 *   Plural categories are a property of the target language, not the source. A
 *   model mirroring English's two branches produces a Russian string that is
 *   wrong for 2, 3, 4, 22 and so on. The required list is stated outright.
 *
 * The style guide and glossary go in the system prompt, unchanged across every
 * batch for a locale, so they cache. The per-batch items go in the user turn.
 */

import { termsIn, categoriesFor, isRtl, measure } from '@i18n-kit/core'

function languageName(locale) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale
  } catch {
    return locale
  }
}

/**
 * The system prompt for one locale. Stable across batches, which is what makes
 * it worth caching.
 *
 * @param {{locale: string, config: object, glossary: object, styleGuide: string|null}} args
 */
export function systemPrompt({ locale, config, glossary, styleGuide }) {
  const name = languageName(locale)
  const categories = categoriesFor(locale)
  const ordinals = categoriesFor(locale, 'ordinal')

  const sections = [
    `You translate user interface strings from ${languageName(config.sourceLocale)} into ${name} (${locale}).`,
    '',
    'You are translating software, not prose. The strings appear on buttons, in dialogs, and in notifications, where they are read in a hurry by someone trying to finish a task. Match the register of good native software in this language, not the literal wording of the source.',
    '',
    '## Format rules, which are not negotiable',
    '',
    'Each message is ICU MessageFormat. Return the same structure with only the words translated.',
    '',
    '- Anything inside curly braces is a machine identifier. `{device}` stays `{device}`. Never translate, rename, reorder away, add, or drop one.',
    '- Keep every `<tag>` and `</tag>` exactly as written, around the equivalent words.',
    '- `#` inside a plural branch is the number itself. Keep it.',
    `- A plural must have a branch for every category this language selects: ${categories.join(', ')}. Write all of them even when several share the same wording, and even when the source has fewer. ${
      categories.length > 2
        ? `This language has ${categories.length} categories where the source has two, so you are adding branches, not copying them.`
        : ''
    }`,
    ordinals.join(',') !== categories.join(',')
      ? `- A \`selectordinal\` uses this language's ordinal categories instead: ${ordinals.join(', ')}.`
      : null,
    '- An apostrophe immediately before a brace, as in `l\'{name}`, makes ICU swallow the placeholder. Write `l\'\'{name}` instead.',
    "- Use this language's own punctuation: its quotation marks, its spacing before punctuation, its decimal separator.",
    isRtl(locale)
      ? '- This is a right-to-left language. Write the text right-to-left and leave the placeholders where the sentence needs them; do not add direction marks, the renderer handles isolation.'
      : null,
    '',
    '## Length',
    '',
    'Screen space is limited. Where a string has a stated maximum, stay under it, using an abbreviation this language genuinely uses rather than a truncation. Where none is stated, prefer the shorter of two good options.',
  ]

  const dnt = glossary.terms.filter((t) => t.doNotTranslate)
  const preferred = glossary.terms.filter((t) => !t.doNotTranslate && t.translations?.[locale])

  if (dnt.length || preferred.length) {
    sections.push('', '## Glossary', '')
    if (dnt.length) {
      sections.push('Leave these exactly as written, in every language:')
      for (const term of dnt) {
        sections.push(`- ${term.term}${term.notes ? ` — ${term.notes}` : ''}`)
      }
    }
    if (preferred.length) {
      sections.push('', `Preferred ${name} wording. Inflect it as the grammar requires, but do not substitute a synonym:`)
      for (const term of preferred) {
        sections.push(`- ${term.term} → ${term.translations[locale]}${term.notes ? ` (${term.notes})` : ''}`)
      }
    }
  }

  if (styleGuide) {
    sections.push('', '## Project style guide', '', styleGuide.trim())
  }

  sections.push(
    '',
    '## What to do when you are unsure',
    '',
    'Translate it anyway and say what you were unsure about in the note for that key. A note costs a reviewer ten seconds. A confident wrong translation costs a user.',
    '',
    'Do not ask questions, do not explain your choices outside the note field, and do not return anything but the requested structure.',
  )

  return sections.filter((line) => line !== null).join('\n')
}

/**
 * One item's context block.
 *
 * Written as readable text rather than JSON because it is read, not parsed, and
 * a model follows a labelled paragraph more reliably than a nested object.
 */
function itemBlock(item, { locale, glossary, config, index }) {
  const lines = [`### ${index}. ${item.key}`, '', `Source: ${JSON.stringify(item.sourceText)}`]

  if (item.entry.comment) lines.push(`What it is: ${item.entry.comment}`)
  if (item.entry.group) lines.push(`Where it appears: ${item.entry.group}`)

  const contentClass = item.entry.class ?? config.policy?.defaultClass ?? 'ui'
  if (contentClass !== 'ui') {
    lines.push(
      `Content type: ${contentClass}.` +
        (contentClass === 'marketing'
          ? ' Rewrite freely for persuasion in this language rather than translating word for word.'
          : contentClass === 'legal'
            ? ' Stay literal. Do not soften or summarize.'
            : contentClass === 'seo'
              ? ' Use the words people in this market actually search for.'
              : ''),
    )
  }

  const placeholders = Object.entries(item.entry.placeholders ?? {})
  if (placeholders.length) {
    lines.push('Placeholders:')
    for (const [name, spec] of placeholders) {
      const parts = []
      if (spec.example !== undefined) parts.push(`for example "${spec.example}"`)
      if (spec.description) parts.push(spec.description)
      if (spec.doNotTranslate) parts.push('a literal value, never translated')
      lines.push(`  - {${name}}${parts.length ? `: ${parts.join('; ')}` : ': no description given'}`)
    }
  }

  if (item.plurals?.length) {
    for (const plural of item.plurals) {
      const required = categoriesFor(locale, plural.pluralType === 'ordinal' ? 'ordinal' : 'cardinal')
      lines.push(
        `Plural on {${plural.arg}}: the source has ${plural.categories.join(', ')}; ` +
          `${locale} needs ${required.join(', ')}.`,
      )
    }
  }

  if (typeof item.entry.maxLength === 'number') {
    lines.push(`Hard limit: ${item.entry.maxLength} characters (the source is ${measure(item.sourceText, 'display-width')}).`)
  }

  const terms = termsIn(glossary, item.sourceText)
  if (terms.length) {
    lines.push(`Glossary terms present: ${terms.map((t) => t.term).join(', ')}.`)
  }

  if (item.existing) {
    lines.push(
      '',
      `There is already a translation, and it is being redone: ${JSON.stringify(item.existing.message)}`,
      `Why: ${item.existing.reason}`,
    )
    if (item.existing.findings?.length) {
      lines.push('Problems found in it:')
      for (const finding of item.existing.findings) lines.push(`  - ${finding.code}: ${finding.detail}`)
      lines.push('Fix those. Keep the rest of the wording, which a person may have chosen deliberately.')
    }
  }

  return lines.join('\n')
}

/**
 * The user turn for one batch.
 *
 * @param {object} args
 * @param {Array<object>} args.items
 * @param {Array<{key: string, sourceText: string, message: string}>} args.precedent
 */
export function batchPrompt({ items, precedent, locale, glossary, config }) {
  const sections = [
    `Translate ${items.length} ${items.length === 1 ? 'string' : 'strings'} into ${languageName(locale)}.`,
  ]

  if (precedent.length) {
    sections.push(
      '',
      '## Wording already settled on this screen',
      '',
      'These are approved. Match their terminology and register exactly; a different word for the same thing on one screen reads as a bug.',
      '',
      ...precedent.map((p) => `- ${JSON.stringify(p.sourceText)} → ${JSON.stringify(p.message)}`),
    )
  }

  sections.push('', '## Strings', '')
  items.forEach((item, index) => {
    sections.push(itemBlock(item, { locale, glossary, config, index: index + 1 }), '')
  })

  sections.push(
    'Return one entry per key, using the exact key strings above. The note field is for anything a reviewer should know: an ambiguity in the source, a term you were unsure of, a place where the language forced a choice the source did not make. Leave it null when there is nothing to say.',
  )

  return sections.join('\n')
}
