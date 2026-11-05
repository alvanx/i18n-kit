/**
 * @i18n-kit/translate public API.
 *
 * Separate from core so that core stays free of any network dependency, which
 * is what lets `i18n check` run on a pull request from a fork where no secret
 * is available. The dependency points one way only: this package imports core,
 * never the reverse.
 */

export { translateProject, SpendLimitReached, readStyleGuide } from './engine.mjs'
export { writeHandoff, ingestAnswers, PROMPT_VERSION, HANDOFF_DIR } from './handoff.mjs'
export { planLocale, batchItems, precedentFor } from './plan.mjs'
export { validateCandidate, correctionFor } from './validate.mjs'
export { systemPrompt, batchPrompt } from './prompt.mjs'
export { createAnthropicProvider, DEFAULT_MODEL } from './providers/anthropic.mjs'
export { createStubProvider } from './providers/stub.mjs'
export { PRICES, estimateCost, formatCost, formatUsage, emptyUsage, addUsage } from './cost.mjs'
