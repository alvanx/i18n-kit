/**
 * Token accounting, so a run can be stopped before it spends money rather than
 * after.
 *
 * Prices move, and a stale table that quietly under-reports is worse than no
 * table, so a model that is not listed makes `estimateCost` return null and
 * every caller says "unknown" instead of inventing a number. A ceiling the user
 * set is still enforced on token counts in that case; only the dollar figure is
 * withheld.
 *
 * Prices are US dollars per million tokens, as published for the first-party
 * API. A run through Bedrock or Vertex bills differently and this will be wrong
 * there, which is why the figure is always reported as an estimate.
 */

/** @type {Record<string, {input: number, output: number, cacheRead: number, cacheWrite: number}>} */
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }
}

export function addUsage(total, delta) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'requests']) {
    total[field] += delta[field] ?? 0
  }
  return total
}

/** Dollars, or null when the model's price is not known here. */
export function estimateCost(usage, model) {
  const price = PRICES[model]
  if (!price) return null
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  )
}

export function formatCost(dollars) {
  if (dollars === null) return 'unknown (this model is not in the price table)'
  if (dollars < 0.01) return 'under $0.01'
  return `$${dollars.toFixed(2)}`
}

export function formatUsage(usage, model) {
  const parts = [
    `${usage.requests} request${usage.requests === 1 ? '' : 's'}`,
    `${usage.inputTokens.toLocaleString('en-US')} in`,
    `${usage.outputTokens.toLocaleString('en-US')} out`,
  ]
  if (usage.cacheReadTokens) parts.push(`${usage.cacheReadTokens.toLocaleString('en-US')} cached`)
  return `${parts.join(', ')} — ${formatCost(estimateCost(usage, model))}`
}
