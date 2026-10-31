/**
 * Key lifecycle.
 *
 * Keys are immutable once shipped, so every change to one goes through a
 * command rather than a text editor. The reason is narrow and concrete: hand
 * editing a key in the source file orphans every translation of it, silently,
 * and the loss only shows up as a wall of MISSING_KEY findings that look like
 * work rather than like a mistake.
 *
 * The subtle one is key REUSE. Deleting `nav.save` and later adding it back for
 * a different button would silently inherit the old translations, which are now
 * wrong in fifteen languages and carry hashes claiming they are current. The
 * checkable form of that danger is an orphaned translation: a translation whose
 * key the source no longer defines. `add` refuses in that case unless told
 * explicitly to drop them.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { contentHash } from './hash.mjs'
import { analyze } from './icu.mjs'

export class KeyError extends Error {
  constructor(message, { hint } = {}) {
    super(hint ? `${message}\n  ${hint}` : message)
    this.name = 'KeyError'
  }
}

const KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/

function assertKeyShape(key) {
  if (!KEY_RE.test(key)) {
    throw new KeyError(`"${key}" is not a valid key`, {
      hint:
        'Use two or more dot-separated segments of lowercase letters, digits, and underscores, ' +
        'for example transfer.confirm_title. The grammar exists so keys convert to Android and ' +
        'Chrome resource names without collision.',
    })
  }
}

/** Translations that exist for a key the source does not define, across every locale. */
function orphanedTranslations(project, namespace, key) {
  const found = []
  for (const [locale, byNamespace] of project.translations) {
    if (byNamespace.get(namespace)?.messages.has(key)) found.push(locale)
  }
  return found
}

/**
 * Create a source entry.
 *
 * Refuses without a comment. This is the one place the comment requirement is
 * absolute rather than ratcheted: a backlog of undocumented keys is a fact of
 * life in an existing project, but there is no excuse for adding to it.
 */
export function addKey(project, { namespace, key, message, comment, reuseKey = false, ...rest }) {
  assertKeyShape(key)

  const file = project.source.get(namespace)
  if (!file) {
    throw new KeyError(`No namespace "${namespace}"`, {
      hint: `Known namespaces: ${project.namespaces().join(', ') || '(none)'}.`,
    })
  }
  if (file.messages.has(key)) {
    throw new KeyError(`"${key}" already exists in ${namespace}`)
  }
  if (!comment) {
    throw new KeyError(`"${key}" needs a comment`, {
      hint:
        'Say what the string is for, where it appears, and who is speaking. ' +
        'It affects translation quality more than model choice does.',
    })
  }

  // The reuse trap.
  const orphans = orphanedTranslations(project, namespace, key)
  if (orphans.length && !reuseKey) {
    throw new KeyError(
      `"${key}" still has translations in ${orphans.join(', ')} from a previous life`,
      {
        hint:
          'Adding it back would silently inherit translations written for the old meaning. ' +
          'Pass --reuse-key to drop them, or pick a different key.',
      },
    )
  }
  if (orphans.length && reuseKey) {
    for (const locale of orphans) {
      project.translations.get(locale)?.get(namespace)?.messages.delete(key)
    }
  }

  analyze(message) // throws if the ICU is invalid, before anything is written

  file.messages.set(key, { message, comment, ...rest })
  return { namespace, key, droppedTranslations: reuseKey ? orphans : [] }
}

/**
 * Move a key, carrying every translation with its origin, review state, and
 * hashes intact. A rename does not change the source text or its contract, so
 * nothing becomes stale.
 */
export function renameKey(project, { namespace, from, to }) {
  assertKeyShape(to)

  const file = project.source.get(namespace)
  const entry = file?.messages.get(from)
  if (!entry) throw new KeyError(`"${from}" does not exist in ${namespace}`)
  if (file.messages.has(to)) throw new KeyError(`"${to}" already exists in ${namespace}`)

  const collision = orphanedTranslations(project, namespace, to)
  if (collision.length) {
    throw new KeyError(`"${to}" already has translations in ${collision.join(', ')}`, {
      hint: 'Remove them first, or rename to a key with no history.',
    })
  }

  file.messages.delete(from)
  file.messages.set(to, entry)

  const moved = []
  for (const [locale, byNamespace] of project.translations) {
    const translationFile = byNamespace.get(namespace)
    const translation = translationFile?.messages.get(from)
    if (!translation) continue
    translationFile.messages.delete(from)
    translationFile.messages.set(to, translation)
    moved.push(locale)
  }

  return { from, to, movedLocales: moved }
}

/**
 * Mark a key for removal without deleting anything yet.
 *
 * Export skips it immediately, so it stops reaching users, while translations
 * are retained in case the removal is reverted.
 */
export function deprecateKey(project, { namespace, key, since, removeAfter = null, reason = null }) {
  const entry = project.source.get(namespace)?.messages.get(key)
  if (!entry) throw new KeyError(`"${key}" does not exist in ${namespace}`)
  if (entry.deprecated) throw new KeyError(`"${key}" is already deprecated since ${entry.deprecated.since}`)

  entry.deprecated = { since, ...(removeAfter ? { removeAfter } : {}), ...(reason ? { reason } : {}) }
  return { namespace, key, deprecated: entry.deprecated }
}

/**
 * Delete a key and every translation of it.
 *
 * Guarded on the deprecation window, because deleting a key that is still in a
 * shipped binary means that binary renders the key name to users.
 */
export function removeKey(project, { namespace, key, force = false, today }) {
  const file = project.source.get(namespace)
  const entry = file?.messages.get(key)
  if (!entry) throw new KeyError(`"${key}" does not exist in ${namespace}`)

  if (!force) {
    if (!entry.deprecated) {
      throw new KeyError(`"${key}" is not deprecated`, {
        hint:
          'Deprecate it first so it stops being exported while shipped clients still reference it, ' +
          'then remove it once they have rolled over. Pass --force to skip that.',
      })
    }
    const removeAfter = entry.deprecated.removeAfter
    if (removeAfter && today < removeAfter) {
      throw new KeyError(`"${key}" is not removable until ${removeAfter} (today is ${today})`, {
        hint: 'Pass --force to remove it now.',
      })
    }
  }

  file.messages.delete(key)

  const cleared = []
  for (const [locale, byNamespace] of project.translations) {
    if (byNamespace.get(namespace)?.messages.delete(key)) cleared.push(locale)
  }

  return { namespace, key, clearedLocales: cleared }
}

/**
 * Declare a source edit cosmetic for one translation, restamping its hashes
 * without retranslating.
 *
 * A human asserts this; the tool never infers it. The whole staleness model
 * rests on the source hash meaning "the text this was translated from", so
 * there has to be a way to say "yes, I changed the source, and no, the
 * translation does not need to change" without paying for a round trip.
 */
export function touchKey(project, { namespace, key, locale, reason = null }) {
  const entry = project.translationEntry(locale, namespace, key)
  if (!entry) throw new KeyError(`${locale} has no translation for "${key}"`)
  if (typeof entry.message !== 'string') {
    throw new KeyError(`${locale} has no text for "${key}", so there is nothing to bless`, {
      hint: 'The last attempt failed. Run translate instead.',
    })
  }

  const hashes = project.expectedHashes(namespace, key)
  const before = { sourceHash: entry.sourceHash, contextHash: entry.contextHash }

  entry.sourceHash = hashes.sourceHash
  entry.contextHash = hashes.contextHash
  entry.contentHash = contentHash(entry.message)

  return { namespace, key, locale, before, after: hashes, reason }
}

/**
 * Ask for a human translation to be replaced by a machine one.
 *
 * The escape hatch that `setTranslation`'s refusal points at, and the only way
 * past it. It exists because "never overwrite a human" has to have a door, and
 * the door has to be narrow enough that nobody walks through it by accident:
 *
 *   A reason is required. Not for ceremony — it is what a reviewer reads in six
 *   months when the German wording changed and nobody remembers why.
 *
 *   The previous text is written down first, in the entry and in the audit log,
 *   so the decision is reversible by copy and paste rather than by archaeology.
 *
 *   The request is recorded in the catalog rather than acted on here. This
 *   command does not call a provider; `translate` sees the flag and picks the
 *   key up. So the diff that authorizes losing a human translation is reviewable
 *   on its own, before any money is spent or any text is replaced.
 */
export function retranslateKey(project, { namespace, key, locale, reason, at }) {
  if (!reason || !reason.trim()) {
    throw new KeyError('retranslate needs --reason', {
      hint: 'It is recorded next to the text being replaced. "Legal asked for different wording" is enough; "fix" is not.',
    })
  }

  const entry = project.translationEntry(locale, namespace, key)
  if (!entry) throw new KeyError(`${locale} has no translation for "${key}", so there is nothing to replace`)

  const previous = typeof entry.message === 'string' ? entry.message : null
  entry.history = [
    ...(entry.history ?? []).slice(-9),
    { at, reason: reason.trim(), origin: entry.origin ?? 'machine', message: previous },
  ]
  entry.origin = 'machine'
  entry.retranslateRequested = { at, reason: reason.trim() }

  return { namespace, key, locale, previous, reason: reason.trim() }
}

/**
 * Re-derive everything derivable and rewrite every file canonically.
 *
 * The command to run after resolving a merge conflict by hand: it restamps
 * content hashes so a hand-merged translation is correctly recorded as
 * human-owned, and re-sorts and reformats so the next diff is clean.
 */
export function normalizeProject(project) {
  // Loading already detected and applied every promotion in memory, so this
  // command's real work is PERSISTING them. Start from what the load found,
  // then sweep for anything it could not have seen.
  const promoted = [...project.promotions]
  const seen = new Set(promoted.map((p) => `${p.locale}/${p.namespace}/${p.key}`))

  for (const [locale, byNamespace] of project.translations) {
    for (const [namespace, file] of byNamespace) {
      for (const [key, entry] of file.messages) {
        if (typeof entry.message !== 'string') continue
        const current = contentHash(entry.message)
        if (entry.contentHash === current) continue

        // Reached when an entry was changed in memory after loading, or when a
        // translation predates content hashing entirely.
        entry.origin = 'human'
        entry.contentHash = current
        const id = `${locale}/${namespace}/${key}`
        if (!seen.has(id)) {
          seen.add(id)
          promoted.push({ locale, namespace, key })
        }
      }
    }
  }

  return { promoted, written: project.save() }
}

/**
 * Append to the audit log.
 *
 * Used by `retranslate` before it replaces human text, so the previous wording
 * and the stated reason survive even though the entry itself is overwritten.
 * Append-only and committed: an audit trail nobody can quietly edit is the
 * point.
 */
export function appendAudit(config, record) {
  const line = JSON.stringify(record)
  mkdirSync(dirname(config.paths.audit), { recursive: true })
  appendFileSync(config.paths.audit, `${line}\n`, 'utf8')
}
