/**
 * The translation loop.
 *
 * The shape of it: plan the work, batch it by screen, ask the provider, check
 * every answer, ask again about the ones that failed with the reason they
 * failed, and record a failure with no text for anything still wrong after the
 * last attempt.
 *
 * That last step is the whole design in one line. A machine translation that
 * cannot be validated is not written. The catalog holds a failure, the export
 * omits the key, the app falls back to the source language, and `check` reports
 * it. Every one of those is visible. Writing the unvalidated string instead
 * would produce a locale file that looks complete and is wrong in a language
 * nobody on the team reads, which is the exact failure this toolkit exists to
 * prevent.
 *
 * The spend ceiling is checked before each request, not after. Checking
 * afterwards tells you how much you overspent.
 */

import { loadGlossary } from '@i18n-kit/core'
import { existsSync, readFileSync } from 'node:fs'
import { systemPrompt, batchPrompt } from './prompt.mjs'
import { planLocale, batchItems, precedentFor } from './plan.mjs'
import { validateCandidate, correctionFor } from './validate.mjs'
import { emptyUsage, addUsage, estimateCost, formatCost } from './cost.mjs'

export class SpendLimitReached extends Error {
  constructor(spent, limit) {
    super(`Stopped: the run would pass the ${formatCost(limit)} ceiling (${formatCost(spent)} spent so far).`)
    this.name = 'SpendLimitReached'
    this.spent = spent
    this.limit = limit
  }
}

/**
 * The style guide, with any `## <locale>` section promoted for this language.
 *
 * Exported because the handoff path builds the same brief without the engine:
 * two readers would drift, and the one that drifted would silently drop the
 * formality ruling, which is the single most noticeable thing in the file.
 */
export function readStyleGuide(config, locale) {
  const path = config.paths.style
  if (!path || !existsSync(path)) return null
  const text = readFileSync(path, 'utf8')

  // A `## <locale>` heading scopes advice to one language. Formality is the
  // obvious case: whether German addresses the user as du or Sie is a project
  // decision, it is not derivable from anything, and getting it wrong is
  // noticed by every reader.
  const scoped = new RegExp(`^##\\s+${locale}\\b([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm').exec(text)
  const general = text.split(/^##\s+/m)[0]

  return scoped ? `${general.trim()}\n\n### Specific to ${locale}\n${scoped[1].trim()}` : text
}

/**
 * Translate one project.
 *
 * @param {object} args
 * @param {import('@i18n-kit/core').Project} args.project
 * @param {object} args.provider
 * @param {object} [args.options]
 * @param {string[]} [args.options.locales]        default: every target locale
 * @param {string[]} [args.options.keys]
 * @param {number}  [args.options.batchSize]
 * @param {number}  [args.options.maxAttempts]     total tries per string
 * @param {number}  [args.options.maxSpend]        dollars
 * @param {boolean} [args.options.dryRun]
 * @param {boolean} [args.options.onlyWithFindings]  review mode
 * @param {Map<string, Array<object>>} [args.options.findingsByKey]
 * @param {(event: object) => void} [args.onEvent]
 */
export async function translateProject({ project, provider, options = {}, onEvent = () => {} }) {
  const config = project.config
  const {
    locales = config.targetLocales(),
    keys = null,
    batchSize = 20,
    maxAttempts = 3,
    maxSpend = null,
    dryRun = false,
    onlyWithFindings = false,
    findingsByKey = new Map(),
  } = options

  const glossary = loadGlossary(config.paths.glossary)
  const usage = emptyUsage()
  const report = {
    translated: [],
    failed: [],
    reused: [],
    skipped: [],
    notes: [],
    usage,
    model: provider.model,
    dryRun,
    estimate: null,
  }

  const guardSpend = () => {
    if (maxSpend === null) return
    const spent = estimateCost(usage, provider.model)
    // An unpriced model cannot be checked against a dollar ceiling. Refusing
    // to run is the safe direction: the alternative is ignoring a limit the
    // user explicitly set.
    if (spent === null) {
      throw new SpendLimitReached(null, maxSpend)
    }
    if (spent >= maxSpend) throw new SpendLimitReached(spent, maxSpend)
  }

  let estimatedInputTokens = 0
  let estimateIsApproximate = false

  for (const locale of locales) {
    const plan = planLocale({ project, locale, findingsByKey, onlyWithFindings, keys })
    report.reused.push(...plan.reused)
    report.skipped.push(...plan.skipped)

    // Reuse is free and needs no provider, so apply it even on a dry run: it
    // changes what the run would cost, which is the point of the estimate.
    for (const hit of plan.reused) {
      if (!dryRun) {
        project.setTranslation(locale, hit.namespace, hit.key, {
          message: hit.message,
          origin: 'machine',
          provenance: { kind: 'memory', from: hit.from },
          note: `Reused from ${hit.from}, which has the same source text and argument contract.`,
        })
      }
      onEvent({ type: 'reused', locale, key: hit.key, from: hit.from })
    }

    if (plan.items.length === 0) continue

    const system = systemPrompt({ locale, config, glossary, styleGuide: readStyleGuide(config, locale) })
    const batches = batchItems(plan.items, { batchSize })

    report.pending = (report.pending ?? 0) + plan.items.length
    onEvent({ type: 'locale-start', locale, items: plan.items.length, batches: batches.length })

    for (const batch of batches) {
      let pending = batch.items
      let attempt = 0
      const corrections = []

      while (pending.length > 0 && attempt < maxAttempts) {
        attempt += 1

        const precedent = precedentFor({
          project,
          locale,
          group: batch.group,
          exclude: batch.items.map((i) => i.key),
        })

        let user = batchPrompt({ items: pending, precedent, locale, glossary, config })
        if (corrections.length) {
          user += `\n\n## Corrections required\n\n${corrections.join('\n')}\n\nReturn the full entry for each key above, corrected.`
        }

        if (dryRun) {
          const { inputTokens, approximate } = await provider.estimate({ system, user })
          estimatedInputTokens += inputTokens
          if (approximate) estimateIsApproximate = true
          // One attempt is enough to price: estimating the retries would mean
          // predicting which strings fail validation.
          break
        }

        guardSpend()

        const response = await provider.translateBatch({ system, user, items: pending, locale })
        addUsage(usage, response.usage ?? {})

        if (response.error) {
          onEvent({ type: 'batch-error', locale, group: batch.group, ...response.error })
          for (const item of pending) {
            report.failed.push({ ...locationOf(item), locale, reason: `${response.error.code}: ${response.error.detail}` })
            project.setFailure(locale, item.namespace, item.key, {
              reason: `${response.error.code}: ${response.error.detail}`,
              at: new Date().toISOString().slice(0, 10),
            })
          }
          pending = []
          break
        }

        corrections.length = 0
        const stillPending = []

        for (const item of pending) {
          const answer = response.results.get(item.key)

          if (!answer) {
            corrections.push(`Key ${item.key}: you did not return an entry for this key. Return one.`)
            stillPending.push(item)
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
            onEvent({
              type: 'rejected',
              locale,
              key: item.key,
              attempt,
              codes: verdict.blocking.map((f) => f.code),
            })
            corrections.push(correctionFor(item, verdict))
            stillPending.push(item)
            continue
          }

          project.setTranslation(locale, item.namespace, item.key, {
            message: answer.message,
            origin: 'machine',
            provenance: {
              kind: 'provider',
              provider: provider.id,
              model: provider.model,
              attempt,
              at: new Date().toISOString().slice(0, 10),
            },
            note: answer.note,
          })

          report.translated.push({
            ...locationOf(item),
            locale,
            attempt,
            advisory: verdict.advisory,
            note: answer.note,
          })
          if (answer.note) report.notes.push({ ...locationOf(item), locale, note: answer.note })
          for (const finding of verdict.advisory) {
            onEvent({ type: 'advisory', locale, key: item.key, code: finding.code, detail: finding.detail })
          }
          onEvent({ type: 'translated', locale, key: item.key, attempt })
        }

        pending = stillPending
      }

      // A dry run breaks out of the loop after pricing one attempt, so its
      // pending list is the whole batch and means nothing. Only a real run can
      // have exhausted anything.
      if (dryRun) continue

      // Anything left has used up its attempts. Recorded as a failure with no
      // message, which is an honest empty slot rather than a wrong string.
      for (const item of pending) {
        const reason = corrections.find((c) => c.startsWith(`Key ${item.key}:`)) ?? 'validation failed'
        report.failed.push({ ...locationOf(item), locale, reason, attempts: attempt })
        project.setFailure(locale, item.namespace, item.key, {
          reason: reason.replace(/\s+/g, ' ').slice(0, 500),
          at: new Date().toISOString().slice(0, 10),
        })
        onEvent({ type: 'failed', locale, key: item.key, attempts: attempt })
      }
    }
  }

  if (dryRun) {
    // Output is the smaller half of a translation request and roughly tracks
    // the input, so a third is a serviceable guess. Reported as an estimate
    // because it is one.
    const projected = {
      ...emptyUsage(),
      inputTokens: estimatedInputTokens,
      outputTokens: Math.round(estimatedInputTokens / 3),
      requests: 0,
    }
    report.estimate = {
      inputTokens: estimatedInputTokens,
      outputTokens: projected.outputTokens,
      cost: estimateCost(projected, provider.model),
      approximate: estimateIsApproximate,
      items: report.pending ?? 0,
    }
  }

  return report
}

function locationOf(item) {
  return { namespace: item.namespace, key: item.key }
}
