/**
 * A provider that does not call anything.
 *
 * Its job is to make the engine testable: every behaviour worth asserting about
 * — the retry loop, human-edit protection, the spend ceiling, a failure recorded
 * with no text — is engine behaviour, and tying those tests to a network call
 * would mean they never run in CI.
 *
 * `answers` maps a key to either a string or a list of strings. A list is
 * returned one entry per attempt, which is how a test says "fail validation
 * first, then get it right" and checks that the correction actually came back.
 */

export function createStubProvider({ answers = {}, estimateTokens = 1000 } = {}) {
  const attempts = new Map()

  return {
    id: 'stub',
    model: 'stub',
    attempts,

    async estimate() {
      return { inputTokens: estimateTokens }
    },

    async translateBatch({ items }) {
      const results = new Map()

      for (const item of items) {
        const nth = attempts.get(item.key) ?? 0
        attempts.set(item.key, nth + 1)

        const answer = answers[item.key]
        if (answer === undefined) continue // a key the stub declines to answer
        const message = Array.isArray(answer) ? (answer[nth] ?? answer.at(-1)) : answer
        if (message === null) continue
        results.set(item.key, { message, note: null })
      }

      return {
        results,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
      }
    },
  }
}

export default createStubProvider
