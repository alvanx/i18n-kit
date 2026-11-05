/**
 * Translating with an agent in the middle, and no API key.
 *
 * The engine calls a provider and pays per token. That is right for a CI job
 * that fills a thousand strings unattended, and wrong for the common case: a
 * developer already sitting in a coding agent that can translate, whose tokens
 * are already paid for by a subscription. Asking them to provision a second,
 * separately billed credential to reach the same model is a cost with nothing
 * on the other side of it.
 *
 * So this is the same pipeline with the network call removed and a person's
 * agent standing where the provider stood:
 *
 *   handoff  writes the exact brief the provider would have received
 *   <agent>  reads it and fills in the answer files
 *   ingest   validates every answer and writes the ones that pass
 *
 * What matters is that nothing about the *checking* changes. `ingest` calls the
 * same `validateCandidate` the engine calls, so an agent gets no easier ride
 * than a paid provider: a Russian plural with two branches is rejected either
 * way. The retry loop still exists, it is just driven by the agent reading the
 * rejection and editing the file instead of by a second request.
 *
 * The brief is built by the same `systemPrompt` and `batchPrompt` the engine
 * uses, deliberately. A second prompt builder would drift, and the first thing
 * it would drop is the style guide's formality ruling, which is the most
 * noticeable thing in the whole file.
 */

import { loadGlossary } from '@i18n-kit/core'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { batchPrompt, systemPrompt } from './prompt.mjs'
import { batchItems, planLocale, precedentFor } from './plan.mjs'
import { correctionFor, validateCandidate } from './validate.mjs'
import { readStyleGuide } from './engine.mjs'

/** Bumped when the brief's structure changes, so provenance records which one produced a string. */
export const PROMPT_VERSION = 1

/** The default place briefs live. Inside i18n/ so it sits with the catalog it is about. */
export const HANDOFF_DIR = 'handoff'

/**
 * Whether this command wrote a given file.
 *
 * `handoff` clears stale briefs so a second run cannot leave a batch from a
 * previous one for `ingest` to find. It only ever removes files matching this,
 * because the directory is somewhere a person may reasonably have put notes.
 */
function ours(name) {
  if (name === 'README.md') return true
  return name.startsWith('batch-') && (name.endsWith('.md') || name.endsWith('.answers.json'))
}

/** The note kinds the catalog schema allows. A note is a reviewer's warning, not free text. */
const NOTE_KINDS = new Set(['ambiguous', 'idiom', 'cultural', 'untranslatable-wordplay'])

/**
 * A note, if it is one, or the reason it was dropped.
 *
 * A malformed note never blocks an otherwise valid translation: the string is
 * the deliverable and the note is commentary. But it is not guessed into shape
 * either, because inventing a `kind` would put a category on the entry that no
 * translator chose.
 */
function checkNote(note) {
  if (note === null || note === undefined) return { note: null }
  if (typeof note !== 'object' || Array.isArray(note)) {
    return {
      note: null,
      dropped: `note must be an object {"kind": ..., "text": ...}, got ${typeof note}. The translation was kept.`,
    }
  }
  if (!NOTE_KINDS.has(note.kind) || typeof note.text !== 'string' || note.text.trim() === '') {
    return {
      note: null,
      dropped:
        `note needs a "kind" of ${[...NOTE_KINDS].join(', ')} and a non-empty "text". ` +
        `The translation was kept. Re-add the note in that shape if it matters.`,
    }
  }
  return { note: { kind: note.kind, text: note.text } }
}

function slug(text) {
  const out = String(text).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return out || 'strings'
}

/**
 * Write the briefs for every locale that needs work.
 *
 * Applies translation memory first, exactly as the engine does. A string whose
 * source text and argument contract already have a settled translation in this
 * locale is free and needs no agent, so handing it to one would be asking for
 * a second opinion nobody wants.
 *
 * @returns {{locales: Array<object>, reused: Array<object>, skipped: Array<object>, dir: string}}
 */
export function writeHandoff({ project, config, dir, options = {} }) {
  const {
    locales = config.targetLocales(),
    keys = null,
    batchSize = 20,
    onlyWithFindings = false,
    findingsByKey = new Map(),
  } = options

  const glossary = loadGlossary(config.paths.glossary)
  const result = { locales: [], reused: [], skipped: [], dir }

  mkdirSync(dir, { recursive: true })

  for (const locale of locales) {
    const plan = planLocale({ project, locale, findingsByKey, onlyWithFindings, keys })
    result.reused.push(...plan.reused)
    result.skipped.push(...plan.skipped)

    for (const hit of plan.reused) {
      project.setTranslation(locale, hit.namespace, hit.key, {
        message: hit.message,
        origin: 'machine',
        provenance: { kind: 'memory', from: hit.from },
        note: `Reused from ${hit.from}, which has the same source text and argument contract.`,
      })
    }

    const localeDir = join(dir, locale)
    mkdirSync(localeDir, { recursive: true })
    for (const name of readdirSync(localeDir)) {
      if (ours(name)) rmSync(join(localeDir, name))
    }

    if (plan.items.length === 0) {
      result.locales.push({ locale, items: 0, batches: [], dir: localeDir })
      continue
    }

    const batches = batchItems(plan.items, { batchSize })
    const written = []

    batches.forEach((batch, index) => {
      const n = String(index + 1).padStart(2, '0')
      const stem = `batch-${n}-${slug(batch.group)}`
      const precedent = precedentFor({
        project,
        locale,
        group: batch.group,
        exclude: batch.items.map((i) => i.key),
      })

      const brief = batchPrompt({ items: batch.items, precedent, locale, glossary, config })
      const answersPath = join(localeDir, `${stem}.answers.json`)

      writeFileSync(
        join(localeDir, `${stem}.md`),
        `<!-- Written by \`i18n handoff\`. Edits here are discarded on the next run. -->\n\n` +
          `# ${locale} · ${batch.group} · batch ${index + 1} of ${batches.length}\n\n` +
          `Read the standing rules in \`../README.md\` first, then translate every string below ` +
          `into \`${stem}.answers.json\`.\n\n---\n\n${brief}\n`,
        'utf8',
      )

      writeFileSync(
        answersPath,
        `${JSON.stringify(
          {
            locale,
            group: batch.group,
            batch: index + 1,
            promptVersion: PROMPT_VERSION,
            answers: Object.fromEntries(batch.items.map((item) => [item.key, { message: null, note: null }])),
            noteShape: '{"kind": "ambiguous" | "idiom" | "cultural" | "untranslatable-wordplay", "text": "..."} or null',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      written.push({ group: batch.group, index: index + 1, items: batch.items.length, stem })
    })

    writeFileSync(
      join(localeDir, 'README.md'),
      `<!-- Written by \`i18n handoff\`. Edits here are discarded on the next run. -->\n\n` +
        `# Translating into ${locale}\n\n` +
        `${plan.items.length} string(s) in ${batches.length} batch(es). For each \`batch-*.md\`, ` +
        `fill in the matching \`.answers.json\`: replace every \`"message": null\` with the translation.\n\n` +
        `\`note\` stays \`null\` unless the source itself is a problem worth a reviewer's time, in which ` +
        `case it takes the shape \`{"kind": "...", "text": "..."}\` where kind is one of \`ambiguous\`, ` +
        `\`idiom\`, \`cultural\`, or \`untranslatable-wordplay\`. It is for flagging a source string that ` +
        `does not travel, not for explaining your own choices. A note in any other shape is dropped, and ` +
        `the translation is still kept.\n\n` +
        `Leave \`message\` as \`null\` for a string you cannot translate confidently. A null is skipped ` +
        `and reported, which is the honest outcome. A guess that passes validation is worse than a gap, ` +
        `because nothing downstream will ever question it.\n\n` +
        `Then run \`i18n ingest --locale ${locale}\`. It validates every answer and writes only the ones ` +
        `that pass. Anything rejected comes back with the specific reason: fix those entries in place and ` +
        `run it again.\n\n---\n\n## Standing rules\n\n` +
        `${systemPrompt({ locale, config, glossary, styleGuide: readStyleGuide(config, locale) })}\n`,
      'utf8',
    )

    result.locales.push({ locale, items: plan.items.length, batches: written, dir: localeDir })
  }

  return result
}

/**
 * Read one locale's answer files back, validate, and write what passes.
 *
 * Re-plans the locale rather than trusting the brief. A brief can be hours old
 * and the source may have changed under it, so the entry validated against is
 * always the one in the catalog now. An answer for a key that is no longer
 * queued is reported rather than written, because it was translated from text
 * that is gone.
 *
 * Unlike the provider loop there is no attempt budget: a rejection is left for
 * the agent to correct and re-ingest, and nothing is recorded as a hard failure
 * on the strength of one bad answer. A string that is simply never fixed stays
 * missing, which `check` already reports.
 *
 * @returns {{accepted: Array<object>, rejected: Array<object>, blank: Array<object>, stale: Array<object>, notes: Array<object>}}
 */
export function ingestAnswers({ project, config, locale, dir, model = 'agent', options = {} }) {
  const glossary = loadGlossary(config.paths.glossary)
  const localeDir = join(dir, locale)

  const out = { accepted: [], rejected: [], blank: [], stale: [], done: [], notes: [], dropped: [], files: 0 }

  if (!existsSync(localeDir)) {
    out.error = `No handoff for ${locale} at ${localeDir}. Run \`i18n handoff --locales ${locale}\` first.`
    return out
  }

  const answers = new Map()
  for (const name of readdirSync(localeDir).sort()) {
    if (!name.endsWith('.answers.json')) continue
    out.files += 1
    let doc
    const path = join(localeDir, name)
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      out.rejected.push({ key: name, file: path, correction: `${name} is not valid JSON: ${err.message}` })
      continue
    }
    for (const [key, value] of Object.entries(doc?.answers ?? {})) {
      answers.set(key, { ...value, file: path })
    }
  }

  if (answers.size === 0) {
    out.error = `No answers found in ${localeDir}. The brief is there; the \`.answers.json\` files are still empty.`
    return out
  }

  // The current queue, which is the authority on what each key's source says.
  const plan = planLocale({
    project,
    locale,
    findingsByKey: options.findingsByKey ?? new Map(),
    onlyWithFindings: Boolean(options.onlyWithFindings),
    keys: null,
  })
  const queued = new Map(plan.items.map((item) => [item.key, item]))
  // Every key the source defines, so an answer for a key that is no longer
  // queued can still be looked up to see whether it is already translated.
  const namespaceOf = new Map()
  for (const { namespace, key } of project.entries()) namespaceOf.set(key, namespace)

  for (const [key, answer] of answers) {
    const item = queued.get(key)

    if (!item) {
      // Re-ingesting after a correction is the normal case: every answer that
      // passed the first time is no longer queued. Calling that "stale" and
      // telling the user their source may have changed is alarming and wrong,
      // so the two are distinguished by what the catalog actually holds.
      const namespace = namespaceOf.get(key)
      const current = namespace ? project.statusOf(locale, namespace, key)?.translation?.message : undefined
      if (typeof answer.message === 'string' && current === answer.message) {
        out.done.push({ key })
      } else {
        out.stale.push({
          key,
          file: answer.file,
          reason:
            `not queued for ${locale} any more, and the catalog holds different text. Its source probably ` +
            `changed after the brief was written. Re-run handoff for this locale.`,
        })
      }
      continue
    }

    if (typeof answer.message !== 'string' || answer.message.trim() === '') {
      out.blank.push({ key, namespace: item.namespace, file: answer.file })
      continue
    }

    const verdict = validateCandidate({
      candidate: answer.message,
      sourceText: item.sourceText,
      locale,
      entry: item.entry,
      glossary,
      config,
    })

    if (verdict.blocking.length > 0) {
      out.rejected.push({
        key,
        namespace: item.namespace,
        file: answer.file,
        codes: verdict.blocking.map((f) => f.code),
        correction: correctionFor(item, verdict),
      })
      continue
    }

    const { note, dropped } = checkNote(answer.note)

    project.setTranslation(locale, item.namespace, key, {
      message: answer.message,
      origin: 'machine',
      provenance: {
        kind: 'agent',
        model,
        promptVersion: answer.promptVersion ?? PROMPT_VERSION,
        at: new Date().toISOString().slice(0, 10),
      },
      note,
    })

    out.accepted.push({ key, namespace: item.namespace, advisory: verdict.advisory, note })
    if (note) out.notes.push({ key, note })
    if (dropped) out.dropped.push({ key, reason: dropped })
  }

  return out
}
