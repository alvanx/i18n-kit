/**
 * Fill this example's translations without calling a provider.
 *
 * The engine takes any object with `translateBatch` and `estimate`, so a
 * provider can just as easily be a lookup table. That is what this is: the
 * German and Russian below were written by hand, and everything downstream of
 * the provider — the validation gate, the retry, the hashing, the catalog — is
 * the same code a real run uses.
 *
 * It exists for two reasons. The example's committed output can be regenerated
 * by anyone, with no API key and no spend. And two of the answers are
 * deliberately wrong in the two ways that matter, so running this prints the
 * rejection and the retry rather than asking you to take them on trust.
 *
 *   node examples/android-sync/offline-translate.mjs
 */

import { loadConfig, loadProject } from '../../packages/core/src/index.mjs'
import { translateProject } from '../../packages/translate/src/index.mjs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ANSWERS = {
  de: {
    'app.name': 'Tabsend',
    'batch.open_all': 'Alle öffnen',
    'batch.summary_partial': '{arrived, number} von {total, number} Tabs bisher angekommen',
    'batch.summary_title': '{count, plural, one {# Tab empfangen} other {# Tabs empfangen}}',
    // Deliberately wrong first: the sender device is dropped. Reads fine,
    // loses information, and no amount of proofreading in English finds it.
    'batch.summary_title_from': [
      '{count, plural, one {# Tab von einem Gerät} other {# Tabs von einem Gerät}}',
      '{count, plural, one {# Tab von {senderDevice}} other {# Tabs von {senderDevice}}}',
    ],
    'channel.links_desc': 'Tabs, die an dieses Gerät gesendet wurden',
    'channel.links_name': 'Eingehende Links',
    'relay.move_done': 'Verwendet jetzt {address}.',
    'relay.sync_progress': 'Bisher {percent, number}% synchronisiert',
    'relay.waiting': 'Warte auf die Antwort von {device}',
  },
  ru: {
    'app.name': 'Tabsend',
    'batch.open_all': 'Открыть все',
    'batch.summary_partial': 'Получено {arrived, number} из {total, number} вкладок',
    // Deliberately wrong first: two branches, mirroring English. Russian needs
    // four, and the missing ones cover 2, 3, 4, 22, 23 and so on.
    'batch.summary_title': [
      '{count, plural, one {Получена # вкладка} other {Получено # вкладок}}',
      '{count, plural, one {Получена # вкладка} few {Получено # вкладки} many {Получено # вкладок} other {Получено # вкладок}}',
    ],
    'batch.summary_title_from':
      '{count, plural, one {# вкладка с {senderDevice}} few {# вкладки с {senderDevice}} many {# вкладок с {senderDevice}} other {# вкладок с {senderDevice}}}',
    'channel.links_desc': 'Вкладки, отправленные на это устройство',
    'channel.links_name': 'Входящие ссылки',
    'relay.move_done': 'Теперь используется {address}.',
    'relay.sync_progress': 'Синхронизировано {percent, number}%',
    'relay.waiting': 'Ожидание ответа от {device}',
  },
}

const root = dirname(fileURLToPath(import.meta.url))
const { project } = loadProject(loadConfig(root))

const attempts = new Map()
const provider = {
  id: 'offline',
  model: 'claude-opus-5-5',
  async estimate() {
    return { inputTokens: 0, approximate: true }
  },
  async translateBatch({ items, locale }) {
    const results = new Map()
    for (const item of items) {
      const id = `${locale}/${item.key}`
      const nth = attempts.get(id) ?? 0
      attempts.set(id, nth + 1)
      const answer = ANSWERS[locale]?.[item.key]
      if (answer === undefined) continue
      results.set(item.key, {
        message: Array.isArray(answer) ? (answer[nth] ?? answer.at(-1)) : answer,
        note: null,
      })
    }
    return { results, usage: { inputTokens: 0, outputTokens: 0, requests: 1 } }
  },
}

const report = await translateProject({
  project,
  provider,
  onEvent: (event) => {
    if (event.type === 'rejected') {
      process.stdout.write(`rejected ${event.locale} ${event.key} (attempt ${event.attempt}): ${event.codes.join(', ')}\n`)
    }
    if (event.type === 'translated' && event.attempt > 1) {
      process.stdout.write(`accepted ${event.locale} ${event.key} on attempt ${event.attempt}\n`)
    }
    if (event.type === 'reused') {
      process.stdout.write(`reused   ${event.locale} ${event.key}, same source text as ${event.from}\n`)
    }
  },
})

process.stdout.write(
  `\ntranslated ${report.translated.length}, reused ${report.reused.length}, failed ${report.failed.length}\n` +
    `wrote ${project.save().length} catalog file(s)\n`,
)
