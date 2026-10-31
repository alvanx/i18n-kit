/**
 * The importer registry.
 *
 * An importer turns a platform's own string file into catalog entries. It is
 * the half of the toolkit that makes it usable on a codebase that already
 * exists, rather than only on one started from scratch.
 *
 * Every importer returns `{ entries, findings }` and never throws on bad
 * content. A file full of surprises should produce a list of them, not stop at
 * the first.
 *
 * What an importer must never do is guess silently. An argument it cannot name
 * becomes `arg2` WITH a finding, a plural shape it does not recognize is
 * reported rather than flattened, and a construct with no catalog equivalent is
 * skipped by name. The reason is that this runs once on a codebase someone
 * already shipped: a quiet mistake here is baked into every later translation.
 */

import android from './android.mjs'
import chrome from './chrome.mjs'
import apple, { importStrings } from './apple.mjs'
import icuJson from './icu-json.mjs'

export const IMPORTERS = {
  android,
  chrome,
  apple,
  'apple-strings': { id: 'apple-strings', extensions: ['.strings'], importText: importStrings },
  'icu-json': icuJson,
}

export function getImporter(id) {
  const importer = IMPORTERS[id]
  if (!importer) {
    throw new Error(`Unknown importer "${id}". Available: ${Object.keys(IMPORTERS).join(', ')}.`)
  }
  return importer
}

/**
 * Guess the importer for a path. Used only to suggest one in an error message:
 * the config always states it, because `.json` could be Chrome or plain ICU and
 * picking wrong produces a catalog of nonsense.
 */
export function suggestImporter(path) {
  if (path.endsWith('.xcstrings')) return 'apple'
  if (path.endsWith('.strings')) return 'apple-strings'
  if (/res\/values[^/]*\/.*\.xml$/.test(path)) return 'android'
  if (/_locales\/[^/]+\/messages\.json$/.test(path)) return 'chrome'
  if (path.endsWith('.json')) return 'icu-json'
  return null
}

export { importAndroid } from './android.mjs'
export { importChrome } from './chrome.mjs'
export { importXcstrings, importStrings } from './apple.mjs'
export { importIcuJson } from './icu-json.mjs'
