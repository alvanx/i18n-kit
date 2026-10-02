/**
 * Test helpers: build a throwaway project on disk.
 *
 * Catalogs are a filesystem layout, and mocking that away would test a
 * different thing than the one that ships. Each call gets its own temp
 * directory, so tests can write, reload, and assert on real bytes.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.mjs'
import { serializeJson } from '../src/writer.mjs'

/**
 * @param {{
 *   config?: object,
 *   source?: Record<string, Record<string, object>>,
 *   translations?: Record<string, Record<string, Record<string, object>>>,
 * }} spec
 */
export function makeProject(spec = {}) {
  const root = mkdtempSync(join(tmpdir(), 'i18n-kit-'))

  const configDoc = {
    schemaVersion: 1,
    sourceLocale: 'en',
    locales: { required: ['de'], optional: [] },
    ...(spec.config ?? {}),
  }

  mkdirSync(join(root, 'i18n', 'source'), { recursive: true })
  writeFileSync(join(root, 'i18n', 'config.json'), serializeJson(configDoc), 'utf8')

  for (const [namespace, messages] of Object.entries(spec.source ?? {})) {
    writeFileSync(
      join(root, 'i18n', 'source', `${namespace}.json`),
      serializeJson({ schemaVersion: 1, namespace, sourceLocale: configDoc.sourceLocale, messages }),
      'utf8',
    )
  }

  for (const [locale, namespaces] of Object.entries(spec.translations ?? {})) {
    mkdirSync(join(root, 'i18n', 'translations', locale), { recursive: true })
    for (const [namespace, messages] of Object.entries(namespaces)) {
      writeFileSync(
        join(root, 'i18n', 'translations', locale, `${namespace}.json`),
        serializeJson({ schemaVersion: 1, locale, namespace, messages }),
        'utf8',
      )
    }
  }

  return { root, config: resolveConfig(configDoc, { root, file: join(root, 'i18n/config.json') }) }
}

/** Read a translation file back as raw parsed JSON, to assert on what actually landed. */
export function readTranslation(root, locale, namespace) {
  return JSON.parse(readFileSync(join(root, 'i18n', 'translations', locale, `${namespace}.json`), 'utf8'))
}

export function readRaw(path) {
  return readFileSync(path, 'utf8')
}

/** Overwrite a translation's text the way a human editing the file by hand would. */
export function handEdit(root, locale, namespace, key, newText) {
  const file = join(root, 'i18n', 'translations', locale, `${namespace}.json`)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.messages[key].message = newText
  writeFileSync(file, serializeJson(doc), 'utf8')
}
