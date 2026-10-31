/**
 * The Anthropic provider.
 *
 * Three choices worth stating.
 *
 * Structured output, not a tool call and not "reply with JSON". The response is
 * constrained to the schema server-side, so a batch cannot come back as prose
 * with the translations inside it, and the one failure mode left — a key that
 * does not match any requested key — is caught by the engine.
 *
 * The system prompt is cached. It holds the style guide and the whole glossary
 * and is identical for every batch in a locale, so after the first request it
 * is read at a fraction of the price. That is also why the per-batch items are
 * in the user turn and not appended to the system prompt: putting them there
 * would invalidate the cache on every request.
 *
 * Retries for rate limits and transient failures are the SDK's job. Retries for
 * a translation that failed validation are the engine's, because only the
 * engine knows what was wrong with it.
 */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

export const DEFAULT_MODEL = 'claude-opus-5-5'

const TranslationBatch = z.object({
  translations: z.array(
    z.object({
      key: z.string().describe('the exact key string from the request'),
      message: z.string().describe('the translated ICU message'),
      note: z.string().nullable().describe('anything a reviewer should know, or null'),
    }),
  ),
})

/**
 * Is this a missing or rejected credential, rather than a real API failure?
 *
 * Matched on the SDK's own error shape where there is one, and on its message
 * for the client-side case, which throws before any request is made and so has
 * no status to check.
 */
export function isCredentialProblem(err) {
  if (err?.status === 401 || err?.name === 'AuthenticationError') return true
  return typeof err?.message === 'string' && err.message.includes('Could not resolve authentication method')
}

/**
 * Tokens, approximately, from character count.
 *
 * About 3.6 characters per token for English prose with punctuation and
 * structure. Wrong for CJK, which is denser, and wrong in the safe direction
 * for a cost estimate: a European-language catalog estimated this way comes out
 * a little high rather than a little low.
 */
function approximateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 3.6)
}

export function createAnthropicProvider({ model = DEFAULT_MODEL, effort = 'high', apiKey = undefined } = {}) {
  let client = null

  // Constructed lazily so a dry run, and every test, works with no credentials
  // present at all.
  const getClient = () => {
    client ??= new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      maxRetries: 4,
    })
    return client
  }

  return {
    id: 'anthropic',
    model,

    /**
     * Count the tokens a batch would cost.
     *
     * Falls back to a character-based approximation when no credentials are
     * available, rather than failing. A dry run is how someone decides whether
     * this is worth setting up at all, so demanding the key first gets the
     * order backwards. The result says which number it is.
     */
    async estimate({ system, user }) {
      try {
        const response = await getClient().messages.countTokens({
          model,
          system,
          messages: [{ role: 'user', content: user }],
        })
        return { inputTokens: response.input_tokens, approximate: false }
      } catch (err) {
        if (!isCredentialProblem(err)) throw err
        return { inputTokens: approximateTokens(system) + approximateTokens(user), approximate: true }
      }
    },

    async translateBatch({ system, user }) {
      const response = await getClient().messages.parse({
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: {
          effort,
          format: zodOutputFormat(TranslationBatch),
        },
      })

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
        requests: 1,
      }

      if (response.stop_reason === 'refusal') {
        return {
          error: {
            code: 'PROVIDER_REFUSED',
            detail:
              `the model declined this batch${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}. ` +
              `If these strings are ordinary UI text, this is most likely a false positive on one string in the batch; ` +
              `re-run with a smaller batch size to find it.`,
          },
          usage,
        }
      }

      if (response.stop_reason === 'max_tokens') {
        return {
          error: {
            code: 'PROVIDER_TRUNCATED',
            detail: 'the response hit the output limit, so the batch is incomplete. Lower batchSize and run again.',
          },
          usage,
        }
      }

      if (!response.parsed_output) {
        return {
          error: { code: 'PROVIDER_UNPARSEABLE', detail: 'the response did not match the expected structure' },
          usage,
        }
      }

      const results = new Map()
      for (const row of response.parsed_output.translations) {
        results.set(row.key, { message: row.message, note: row.note ?? null })
      }

      return { results, usage }
    },
  }
}

export default createAnthropicProvider
