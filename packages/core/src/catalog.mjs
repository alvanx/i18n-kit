/**
 * Loading, holding, and saving catalogs.
 *
 * Two design points carry most of the weight here.
 *
 * Loading is TOLERANT. A malformed key, a missing comment, or a message that
 * does not parse produces a finding, not a throw. The checker's job is to
 * report every problem in one pass, and a loader that throws on the first bad
 * entry turns that into a fix-one-rerun loop. Only a document that cannot be
 * interpreted at all, a file that is not JSON or has no messages object, stops
 * the load.
 *
 * Human-edit promotion is DERIVED, not stored-and-trusted. Every load re-checks
 * each machine-origin entry against its content hash, so the protection holds
 * even on a fresh clone and even if the promotion was never written back. That
 * is why `check` can be read-only in CI while still refusing to let `translate`
 * overwrite a hand edit: both derive the same fact from the same bytes.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { analyze, contractOf, compareStructure } from './icu.mjs'
import { sourceHash, contextHash, contentHash, wasHumanEdited, stalenessOf } from './hash.mjs'
import { serializeJson, writeIfChanged } from './writer.mjs'

const KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/
const NAMESPACE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

export class CatalogError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CatalogError'
  }
}

function readJson(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new CatalogError(`Cannot read ${file}: ${err.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new CatalogError(`${file} is not valid JSON: ${err.message}`)
  }
}

function listCatalogFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f))
}

/**
 * A single source-language catalog file.
 */
class SourceFile {
  constructor(file, doc) {
    this.file = file
    this.doc = doc
    this.namespace = doc.namespace
    this.messages = new Map(Object.entries(doc.messages ?? {}))
  }

  toDocument() {
    return {
      $schema: this.doc.$schema,
      schemaVersion: 1,
      namespace: this.namespace,
      sourceLocale: this.doc.sourceLocale,
      messages: Object.fromEntries(this.messages),
    }
  }
}

/**
 * A single locale's catalog for one namespace.
 */
class TranslationFile {
  constructor(file, doc, { locale, namespace }) {
    this.file = file
    this.doc = doc
    this.locale = locale
    this.namespace = namespace
    this.messages = new Map(Object.entries(doc.messages ?? {}))
  }

  toDocument() {
    return {
      $schema: this.doc.$schema,
      schemaVersion: 1,
      locale: this.locale,
      namespace: this.namespace,
      messages: Object.fromEntries(this.messages),
    }
  }
}

export class Project {
  constructor(config) {
    this.config = config
    /** @type {Map<string, SourceFile>} */
    this.source = new Map()
    /** @type {Map<string, Map<string, TranslationFile>>} locale -> namespace -> file */
    this.translations = new Map()
    /** Entries promoted to human origin during this load. */
    this.promotions = []
    this._analysisCache = new Map()
    this._hashCache = new Map()
  }

  // --- reading ------------------------------------------------------------

  namespaces() {
    return [...this.source.keys()].sort()
  }

  /** Every source message, in a stable order. */
  *entries() {
    for (const ns of this.namespaces()) {
      const file = this.source.get(ns)
      for (const key of [...file.messages.keys()].sort()) {
        yield { namespace: ns, key, entry: file.messages.get(key) }
      }
    }
  }

  sourceEntry(namespace, key) {
    return this.source.get(namespace)?.messages.get(key)
  }

  translationFile(locale, namespace) {
    return this.translations.get(locale)?.get(namespace)
  }

  translationEntry(locale, namespace, key) {
    return this.translationFile(locale, namespace)?.messages.get(key)
  }

  /** Parse once per distinct message text. Adapters and the checker both ask repeatedly. */
  analysisOf(text) {
    const cached = this._analysisCache.get(text)
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached
      return cached
    }
    try {
      const result = analyze(text)
      this._analysisCache.set(text, result)
      return result
    } catch (err) {
      this._analysisCache.set(text, err)
      throw err
    }
  }

  /** Analysis, or null when the message does not parse. Callers that already reported the parse error use this. */
  tryAnalysisOf(text) {
    try {
      return this.analysisOf(text)
    } catch {
      return null
    }
  }

  /**
   * The hashes a translation of this key should be carrying if it is current.
   * Cached because every locale asks the same question about the same key.
   */
  expectedHashes(namespace, key) {
    const cacheKey = `${namespace}/${key}`
    const cached = this._hashCache.get(cacheKey)
    if (cached) return cached

    const entry = this.sourceEntry(namespace, key)
    if (!entry) return null

    const analysis = this.tryAnalysisOf(entry.message)
    const hashes = {
      sourceHash: sourceHash(entry.message, analysis ? contractOf(analysis) : 'unparseable'),
      contextHash: contextHash({ ...entry, class: this.classOf(entry) }),
    }
    this._hashCache.set(cacheKey, hashes)
    return hashes
  }

  classOf(entry) {
    return entry.class ?? this.config.policy.defaultClass
  }

  /**
   * How a translation stands relative to its source right now.
   *
   * Structural staleness is decided by comparing the CURRENT source against the
   * EXISTING translation, not by asking whether the source contract changed.
   * That is a stronger test: it also catches a translation that never matched.
   */
  statusOf(locale, namespace, key) {
    const source = this.sourceEntry(namespace, key)
    const translation = this.translationEntry(locale, namespace, key)

    if (!source) return { state: 'orphan', translation }
    if (!translation) return { state: 'missing', translation: null }
    if (translation.attempt?.status === 'failed') return { state: 'failed', translation }
    if (typeof translation.message !== 'string') return { state: 'missing', translation }

    const sourceAnalysis = this.tryAnalysisOf(source.message)
    const transAnalysis = this.tryAnalysisOf(translation.message)
    const structurallyBroken =
      sourceAnalysis && transAnalysis
        ? compareStructure(sourceAnalysis, transAnalysis).length > 0
        : false

    const staleness = stalenessOf(translation, {
      ...this.expectedHashes(namespace, key),
      structurallyBroken,
    })

    return { state: staleness, translation, structurallyBroken }
  }

  // --- writing ------------------------------------------------------------

  /**
   * Record a translation, stamping the hashes that make it verifiable later.
   * Refuses to touch a human-owned entry: that path is `retranslate`, which is
   * audited.
   */
  setTranslation(locale, namespace, key, { message, origin = 'machine', provenance = null, note = null }) {
    const existing = this.translationEntry(locale, namespace, key)
    if (existing?.origin === 'human' && origin === 'machine') {
      throw new CatalogError(
        `Refusing to overwrite the human translation of ${namespace}.${key} in ${locale}. ` +
          `Use \`i18n retranslate --key ${key} --locale ${locale} --reason "..."\`, which records the previous text first.`,
      )
    }

    const file = this._ensureTranslationFile(locale, namespace)
    const hashes = this.expectedHashes(namespace, key)

    file.messages.set(key, {
      message,
      origin,
      review: existing?.review === 'approved' ? 'approved' : (existing?.review ?? 'none'),
      sourceHash: hashes.sourceHash,
      contextHash: hashes.contextHash,
      contentHash: contentHash(message),
      provenance,
      attempt: null,
      note,
      qa: null,
    })
  }

  /** Record a failed attempt. Deliberately writes no message: absence is the honest state. */
  setFailure(locale, namespace, key, { reason, at }) {
    const file = this._ensureTranslationFile(locale, namespace)
    const hashes = this.expectedHashes(namespace, key)
    const existing = file.messages.get(key)

    file.messages.set(key, {
      ...(existing ?? {}),
      message: undefined,
      contentHash: undefined,
      origin: existing?.origin ?? 'machine',
      review: existing?.review ?? 'none',
      sourceHash: hashes.sourceHash,
      contextHash: hashes.contextHash,
      attempt: { status: 'failed', reason, at },
    })
  }

  _ensureTranslationFile(locale, namespace) {
    let byNamespace = this.translations.get(locale)
    if (!byNamespace) {
      byNamespace = new Map()
      this.translations.set(locale, byNamespace)
    }
    let file = byNamespace.get(namespace)
    if (!file) {
      file = new TranslationFile(
        join(this.config.paths.translations, locale, `${namespace}.json`),
        { $schema: undefined, messages: {} },
        { locale, namespace },
      )
      byNamespace.set(namespace, file)
    }
    return file
  }

  /**
   * Persist every catalog whose bytes changed.
   * @returns {string[]} files actually written
   */
  save() {
    const written = []
    for (const file of this.source.values()) {
      if (writeIfChanged(file.file, serializeJson(file.toDocument()))) written.push(file.file)
    }
    for (const byNamespace of this.translations.values()) {
      for (const file of byNamespace.values()) {
        if (writeIfChanged(file.file, serializeJson(file.toDocument()))) written.push(file.file)
      }
    }
    return written
  }
}

/**
 * Load every catalog for a project.
 *
 * @returns {{ project: Project, findings: Array<{code: string, detail: string, file?: string, key?: string, locale?: string}> }}
 */
export function loadProject(config) {
  const project = new Project(config)
  const findings = []

  loadSource(project, config, findings)
  loadTranslations(project, config, findings)

  return { project, findings }
}

function loadSource(project, config, findings) {
  const files = listCatalogFiles(config.paths.source)
  if (files.length === 0) {
    throw new CatalogError(
      `No source catalogs found in ${config.paths.source}. Run \`i18n init\` or check paths.source.`,
    )
  }

  for (const file of files) {
    const doc = readJson(file)
    const expectedNamespace = basename(file, '.json')

    if (typeof doc !== 'object' || doc === null || typeof doc.messages !== 'object') {
      throw new CatalogError(`${file}: expected an object with a "messages" object`)
    }
    if (doc.schemaVersion !== 1) {
      findings.push({ code: 'SCHEMA_INVALID', file, detail: `schemaVersion must be 1, got ${JSON.stringify(doc.schemaVersion)}` })
    }
    if (doc.namespace !== expectedNamespace) {
      findings.push({
        code: 'SCHEMA_INVALID',
        file,
        detail: `namespace is "${doc.namespace}" but the filename says "${expectedNamespace}". They must agree, because keys are addressed by namespace.`,
      })
    }
    if (!NAMESPACE_RE.test(expectedNamespace)) {
      findings.push({ code: 'SCHEMA_INVALID', file, detail: `"${expectedNamespace}" is not a valid namespace name` })
    }
    if (doc.sourceLocale && doc.sourceLocale !== config.sourceLocale) {
      findings.push({
        code: 'SCHEMA_INVALID',
        file,
        detail: `sourceLocale is "${doc.sourceLocale}" but config says "${config.sourceLocale}"`,
      })
    }

    const sourceFile = new SourceFile(file, { ...doc, namespace: expectedNamespace })

    for (const [key, entry] of sourceFile.messages) {
      if (!KEY_RE.test(key)) {
        findings.push({
          code: 'KEY_SHAPE',
          file,
          key,
          detail:
            `"${key}" must be two or more dot-separated segments of lowercase letters, digits, and underscores. ` +
            `The grammar exists so keys convert to Android and Chrome resource names without collision.`,
        })
      }
      if (typeof entry?.message !== 'string' || entry.message.length === 0) {
        findings.push({ code: 'SCHEMA_INVALID', file, key, detail: 'message must be a non-empty string' })
      }
    }

    if (project.source.has(expectedNamespace)) {
      throw new CatalogError(`Duplicate namespace "${expectedNamespace}" in ${file}`)
    }
    project.source.set(expectedNamespace, sourceFile)
  }
}

function loadTranslations(project, config, findings) {
  for (const locale of config.targetLocales()) {
    const dir = join(config.paths.translations, locale)
    const byNamespace = new Map()
    project.translations.set(locale, byNamespace)

    for (const file of listCatalogFiles(dir)) {
      const doc = readJson(file)
      const namespace = basename(file, '.json')

      if (typeof doc !== 'object' || doc === null || typeof doc.messages !== 'object') {
        throw new CatalogError(`${file}: expected an object with a "messages" object`)
      }
      if (doc.locale && doc.locale !== locale) {
        findings.push({
          code: 'SCHEMA_INVALID',
          file,
          detail: `locale is "${doc.locale}" but the file sits in the "${locale}" directory`,
        })
      }

      const translationFile = new TranslationFile(file, doc, { locale, namespace })

      for (const [key, entry] of translationFile.messages) {
        // The safety mechanism. Re-derived on every load, so it holds on a
        // fresh clone regardless of whether a previous run wrote it back.
        if (wasHumanEdited(entry)) {
          entry.origin = 'human'
          entry.contentHash = contentHash(entry.message)
          project.promotions.push({ locale, namespace, key })
          findings.push({
            code: 'HUMAN_EDITED',
            file,
            key,
            locale,
            detail:
              `${key} was recorded as machine-written but its text no longer matches its content hash, ` +
              `so it is now human-owned and translate will not overwrite it.`,
          })
        }
      }

      byNamespace.set(namespace, translationFile)
    }
  }
}
