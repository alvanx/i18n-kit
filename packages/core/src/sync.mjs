/**
 * Importing the platform's string files into the catalog.
 *
 * In sync mode this runs every time, so it cannot be a one-way conversion: a
 * second run must not undo the first run's corrections. The merge rules below
 * decide, field by field, who owns what.
 *
 *   The TEXT belongs to the platform file. That is what sync mode means. A
 *   developer changing an English string in strings.xml is the normal way
 *   strings change, and the catalog follows.
 *
 *   ARGUMENT NAMES belong to the catalog, through `argRenames`. The platform
 *   format often cannot carry a name at all — `%2$s` says nothing — so the
 *   rename is recorded here and reapplied on every import. Without this the
 *   single most valuable manual improvement anyone makes to the catalog would
 *   be destroyed by the next sync.
 *
 *   The kit's own fields — maxLength, class, targets, a comment the platform
 *   file does not have — belong to the catalog. The platform has nowhere to put
 *   them.
 *
 *   A key that disappears from the platform file is DEPRECATED, not deleted.
 *   Deprecation is reversible and keeps the translations, so a string
 *   temporarily commented out during a refactor does not cost a round of
 *   retranslation when it comes back.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getImporter } from './importers/index.mjs'
import { serializeJson, writeIfChanged } from './writer.mjs'

/** Rename an ICU argument everywhere it appears, including as a plural selector. */
export function renameArgument(message, from, to) {
  return message.replace(new RegExp(`\\{(\\s*)${from}(\\s*[,}])`, 'g'), `{$1${to}$2`)
}

function applyRenames(message, renames) {
  let out = message
  for (const [from, to] of Object.entries(renames ?? {})) {
    out = renameArgument(out, from, to)
  }
  return out
}

/**
 * Merge one imported entry over whatever the catalog already had for that key.
 */
function mergeEntry(existing, imported) {
  if (!existing) return imported

  const renames = existing.argRenames ?? null
  const merged = {
    ...existing,
    message: applyRenames(imported.message, renames),
    platformNames: { ...existing.platformNames, ...imported.platformNames },
  }

  // A comment in the platform file is the developer's current intent, so it
  // wins. A comment only in the catalog is kept, because the platform format
  // may have nowhere to write one.
  if (imported.comment) merged.comment = imported.comment
  if (imported.group) merged.group = imported.group

  const placeholders = {}
  for (const [name, spec] of Object.entries(imported.placeholders ?? {})) {
    const renamed = renames?.[name] ?? name
    placeholders[renamed] = { ...(existing.placeholders?.[renamed] ?? {}), ...spec }
  }
  // A placeholder documented only in the catalog survives as long as the
  // message still uses it.
  for (const [name, spec] of Object.entries(existing.placeholders ?? {})) {
    if (!placeholders[name] && merged.message.includes(`{${name}`)) placeholders[name] = spec
  }
  if (Object.keys(placeholders).length) merged.placeholders = placeholders
  else delete merged.placeholders

  // It is back, so it is not deprecated any more.
  delete merged.deprecated
  delete merged.deprecatedReason
  delete merged.removeAfter

  return merged
}

/**
 * Read every declared source and write the catalog.
 *
 * @param {object} config
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{findings: Array<object>, added: Array<object>, updated: Array<object>, deprecated: Array<object>, unchanged: number, written: string[]}}
 */
export function runImport(config, { dryRun = false } = {}) {
  const findings = []
  const added = []
  const updated = []
  const deprecated = []
  const written = []
  let unchanged = 0

  if (config.source.from.length === 0) {
    return {
      findings: [
        {
          code: 'IMPORT_NOTHING_DECLARED',
          detail:
            'No source.from entries in the config, so there is nothing to import. ' +
            'This project authors its strings in the catalog directly (source.mode "adopt").',
        },
      ],
      added,
      updated,
      deprecated,
      unchanged,
      written,
    }
  }

  for (const origin of config.source.from) {
    if (!existsSync(origin.path)) {
      findings.push({
        code: 'IMPORT_MISSING_FILE',
        detail: `${origin.path} does not exist. Fix the path in source.from, or remove that entry.`,
        file: origin.path,
      })
      continue
    }

    const importer = getImporter(origin.importer)
    const result = importer.importText(readFileSync(origin.path, 'utf8'), {
      namespace: origin.namespace,
      file: origin.path,
      sourceLocale: config.sourceLocale,
    })

    const catalogPath = join(config.paths.source, `${origin.namespace}.json`)
    const previous = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : { messages: {} }
    const previousMessages = previous.messages ?? {}

    for (const finding of result.findings) {
      // An argument the catalog already renames is not un-named any more. Left
      // in, this would report the same ten arguments on every single import,
      // and a warning that never goes away is a warning nobody reads.
      if (finding.code === 'IMPORT_UNNAMED_ARG' && finding.arg) {
        const renames = previousMessages[finding.catalogKey]?.argRenames ?? {}
        if (renames[finding.arg]) continue
      }
      findings.push({ ...finding, file: finding.file ?? origin.path })
    }

    const messages = {}
    const seen = new Set()

    for (const { key, entry } of result.entries) {
      seen.add(key)
      if (messages[key]) {
        findings.push({
          code: 'IMPORT_DUPLICATE_KEY',
          detail: `two resources in ${origin.path} both map to the catalog key "${key}"; the second is ignored`,
          key,
          file: origin.path,
        })
        continue
      }
      const merged = mergeEntry(previousMessages[key], entry)
      messages[key] = merged

      if (!previousMessages[key]) added.push({ namespace: origin.namespace, key })
      else if (previousMessages[key].message !== merged.message) {
        updated.push({ namespace: origin.namespace, key, from: previousMessages[key].message, to: merged.message })
      } else unchanged += 1
    }

    for (const [key, entry] of Object.entries(previousMessages)) {
      if (seen.has(key)) continue
      if (entry.deprecated) {
        messages[key] = entry
        continue
      }
      messages[key] = {
        ...entry,
        deprecated: true,
        deprecatedReason: `No longer present in ${origin.path} as of this import.`,
      }
      deprecated.push({ namespace: origin.namespace, key })
      findings.push({
        code: 'IMPORT_KEY_GONE',
        detail:
          `"${key}" is no longer in ${origin.path}, so it is marked deprecated rather than deleted. ` +
          `Its translations are kept. Run \`i18n remove ${key}\` when you are sure.`,
        key,
        file: origin.path,
      })
    }

    const document = {
      $schema: previous.$schema ?? '../../node_modules/@i18n-kit/core/schemas/source.schema.json',
      schemaVersion: 1,
      namespace: origin.namespace,
      sourceLocale: config.sourceLocale,
      messages,
    }

    if (dryRun) continue
    if (writeIfChanged(catalogPath, serializeJson(document))) written.push(catalogPath)
  }

  return { findings, added, updated, deprecated, unchanged, written }
}
