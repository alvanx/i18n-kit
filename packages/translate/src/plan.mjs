/**
 * Deciding what to translate, and in what order.
 *
 * The selection rules matter more than they look, because the expensive mistake
 * is not translating too little. It is re-translating things that were already
 * right, which costs money, churns the diff, and above all risks replacing a
 * human's wording with a machine's.
 *
 * So:
 *
 *   A human-owned translation is never queued, whatever its state. A stale one
 *   is `check`'s problem to report, and the only way to replace it is the
 *   audited `retranslate` path which records the old text first.
 *
 *   An exact source text that already has an approved translation in this
 *   locale is reused rather than sent. The same sentence must not come back
 *   worded two ways, and a reused string is free.
 *
 *   Batches are grouped by screen. Strings that appear together are translated
 *   together, with the group's settled wording as precedent, which is what
 *   keeps one screen from using two words for the same thing.
 */

import { contractOf } from '@i18n-kit/core'

/** Why an entry is in the queue, in words a prompt can use. */
const REASONS = {
  missing: 'it has never been translated',
  'stale-text': 'the source wording changed',
  'stale-structural': 'the source changed in a way that breaks this translation',
  'stale-context': 'the description or the constraints around it changed, though the source text did not',
  failed: 'the last attempt failed validation',
  review: 'a check found problems in it',
}

/**
 * @param {object} args
 * @param {import('@i18n-kit/core').Project} args.project
 * @param {string} args.locale
 * @param {Map<string, Array<object>>} [args.findingsByKey]  for review mode, keyed `locale/namespace/key`
 * @param {boolean} [args.onlyWithFindings]                  review mode
 * @param {string[]} [args.keys]                             restrict to these keys
 * @returns {{items: Array<object>, reused: Array<object>, skipped: Array<object>}}
 */
export function planLocale({ project, locale, findingsByKey = new Map(), onlyWithFindings = false, keys = null }) {
  const items = []
  const reused = []
  const skipped = []

  // Source text to an already-settled translation, for the memory below. Only
  // entries that are current and either human-written or approved qualify: a
  // machine translation nobody has looked at is not precedent for anything.
  const memory = new Map()
  for (const { namespace, key, entry } of project.entries()) {
    const status = project.statusOf(locale, namespace, key)
    if (status.state !== 'current') continue
    const translation = status.translation
    if (!translation || typeof translation.message !== 'string') continue
    if (translation.origin !== 'human' && translation.review !== 'approved') continue
    const analysis = project.tryAnalysisOf(entry.message)
    memory.set(`${entry.message}\u0000${analysis ? contractOf(analysis) : ''}`, {
      key,
      namespace,
      message: translation.message,
      origin: translation.origin,
    })
  }

  for (const { namespace, key, entry } of project.entries()) {
    if (entry.deprecated) continue
    if (keys && !keys.includes(key) && !keys.includes(`${namespace}.${key}`)) continue

    const status = project.statusOf(locale, namespace, key)
    const findings = findingsByKey.get(`${locale}/${namespace}/${key}`) ?? []

    const existing = status.translation

    if (onlyWithFindings) {
      if (findings.length === 0 && !existing?.retranslateRequested) continue
    } else if (status.state === 'current' && findings.length === 0 && !existing?.retranslateRequested) {
      continue
    }

    // An explicit, reasoned request to replace a human translation. The
    // reason is already recorded in the catalog and the audit log, so the
    // decision has been made and reviewed by the time it reaches here.
    const requested = Boolean(existing?.retranslateRequested)

    if (existing?.origin === 'human' && !requested) {
      skipped.push({
        namespace,
        key,
        locale,
        reason:
          `a person wrote this translation, so it is not queued. ` +
          `To replace it: i18n retranslate --key ${key} --locale ${locale} --reason "..."`,
        state: status.state,
        findings,
      })
      continue
    }

    const analysis = project.tryAnalysisOf(entry.message)
    if (!analysis) {
      skipped.push({ namespace, key, locale, reason: 'the source message does not parse, so check must be fixed first', state: status.state })
      continue
    }

    // Translation memory. Same words and the same argument contract, so the
    // settled translation is valid here too.
    const remembered = memory.get(`${entry.message}\u0000${contractOf(analysis)}`)
    if (remembered && remembered.key !== key && findings.length === 0) {
      reused.push({ namespace, key, locale, from: remembered.key, message: remembered.message })
      continue
    }

    items.push({
      namespace,
      key,
      locale,
      entry,
      sourceText: entry.message,
      plurals: analysis.plurals,
      group: entry.group ?? namespace,
      existing:
        existing && typeof existing.message === 'string'
          ? {
              message: existing.message,
              reason: existing.retranslateRequested
                ? `a person asked for it to be redone: ${existing.retranslateRequested.reason}`
                : onlyWithFindings
                  ? REASONS.review
                  : (REASONS[status.state] ?? status.state),
              findings,
            }
          : null,
    })
  }

  return { items, reused, skipped }
}

/**
 * Group into batches by screen, each no larger than `batchSize`.
 *
 * Ordered so the groups with the most strings go first. Those are the screens
 * where consistency matters most, and translating them early means the rest of
 * the run has their wording available as precedent.
 */
export function batchItems(items, { batchSize = 20 } = {}) {
  const byGroup = new Map()
  for (const item of items) {
    const list = byGroup.get(item.group) ?? []
    list.push(item)
    byGroup.set(item.group, list)
  }

  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const batches = []

  for (const [group, list] of groups) {
    for (let start = 0; start < list.length; start += batchSize) {
      batches.push({ group, items: list.slice(start, start + batchSize) })
    }
  }

  return batches
}

/**
 * Already-settled translations from the same group, as binding precedent.
 *
 * Capped, because the point is to pin terminology rather than to resend the
 * whole screen on every request. The cap also keeps the user turn small enough
 * that the cached system prompt stays the bulk of the input.
 */
export function precedentFor({ project, locale, group, exclude, limit = 12 }) {
  const out = []
  const seen = new Set(exclude)

  for (const { namespace, key, entry } of project.entries()) {
    if (out.length >= limit) break
    if (seen.has(key)) continue
    if ((entry.group ?? namespace) !== group) continue

    const status = project.statusOf(locale, namespace, key)
    if (status.state !== 'current') continue
    const message = status.translation?.message
    if (typeof message !== 'string') continue

    out.push({ key, sourceText: entry.message, message })
  }

  return out
}
