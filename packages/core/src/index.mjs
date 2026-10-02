/**
 * @i18n-kit/core public API.
 *
 * Nothing here touches the network. Validating, exporting, and managing a
 * catalog is entirely local work, which is what lets `check` run on a pull
 * request from a fork where no secret is available. Translation lives in
 * @i18n-kit/translate and depends on this package, never the other way round.
 */

export { loadConfig, resolveConfig, ConfigError, CONFIG_FILENAME } from './config.mjs'
export { loadProject, Project, CatalogError } from './catalog.mjs'
export { check } from './check.mjs'
export { planExport, runExport, checkDrift } from './export.mjs'
export { generatePseudoLocale, PSEUDO_LOCALES } from './pseudo.mjs'
export { RULES, severityOf, isKnownRule } from './rules.mjs'
export { analyze, contractOf, compareStructure, structuralFindings, IcuError } from './icu.mjs'
export { sourceHash, contextHash, contentHash, wasHumanEdited, stalenessOf } from './hash.mjs'
export { categoriesFor, isRtl, hasZeroCategory } from './plurals.mjs'
export { normalize, displayWidth, graphemeCount, measure, isolate } from './text.mjs'
export { loadGlossary, termsIn, checkGlossary } from './glossary.mjs'
export { ADAPTERS, getAdapter, capabilityFindings, resolveLocaleTag, messagesForTarget } from './adapters/index.mjs'
export { canonicalJson, serializeJson, writeIfChanged, GENERATED_KEY, GENERATED_NOTICE } from './writer.mjs'
