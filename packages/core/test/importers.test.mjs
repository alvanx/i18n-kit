/**
 * Importer tests.
 *
 * The emphasis is on the conversions that lose information if they go wrong,
 * and on the findings that tell a human where to look. An importer that
 * silently produces `{arg2}` everywhere still "works"; it just produces a
 * catalog nobody can translate well. So the findings are asserted as carefully
 * as the output.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { importAndroid } from '../src/importers/android.mjs'
import { importChrome } from '../src/importers/chrome.mjs'
import { importXcstrings, importStrings } from '../src/importers/apple.mjs'
import { importIcuJson } from '../src/importers/icu-json.mjs'
import { parseXml, XmlError, decodeEntities } from '../src/importers/xml.mjs'
import { analyze } from '../src/icu.mjs'

const android = (body) => importAndroid(`<?xml version="1.0" encoding="utf-8"?>\n<resources>${body}</resources>`, { namespace: 'app' })
const only = (result) => result.entries[0]

// --- the XML subset ---------------------------------------------------------

test('a construct the reader does not understand throws instead of being guessed at', () => {
  assert.throws(() => parseXml('<!DOCTYPE resources SYSTEM "x"><resources/>'), XmlError)
  assert.throws(() => parseXml('<resources><string name="a">x</resources>'), XmlError)
  assert.throws(() => parseXml('<resources><string name=a>x</string></resources>'), XmlError)
})

test('an unknown entity is reported for that one string, not fatal for the file', () => {
  // &nbsp; has no definition without a DTD. The string it appears in cannot be
  // read, and the other fifty-six in the file still can.
  assert.throws(() => decodeEntities('&nbsp;'), /Unknown entity/)

  const result = android(`<string name="a_bad">&nbsp;</string><string name="a_good">Fine</string>`)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].key, 'a.good')
  assert.match(result.findings.find((f) => f.code === 'IMPORT_UNREADABLE').detail, /Unknown entity/)
})

// --- Android ----------------------------------------------------------------

test('a plural becomes ICU with the count named from its position', () => {
  const entry = only(
    android(`<plurals name="tab_count"><item quantity="one">%1$d tab</item><item quantity="other">%1$d tabs</item></plurals>`),
  )
  assert.equal(entry.entry.message, '{count, plural, one {# tab} other {# tabs}}')
  assert.equal(entry.key, 'tab.count')
  assert.equal(entry.entry.platformNames.android, 'tab_count')
})

test('text around a plural is kept inside every branch', () => {
  const entry = only(
    android(
      `<plurals name="send_confirm"><item quantity="one">Send %1$d tab to %2$s?</item><item quantity="other">Send %1$d tabs to %2$s?</item></plurals>`,
    ),
  )
  assert.equal(entry.entry.message, '{count, plural, one {Send # tab to {arg2}?} other {Send # tabs to {arg2}?}}')
  assert.doesNotThrow(() => analyze(entry.entry.message))
})

test('xliff markup gives an argument its name and its example', () => {
  const entry = only(
    android(`<string name="move_done">Now using <xliff:g id="address" example="home.local">%1$s</xliff:g>.</string>`),
  )
  assert.equal(entry.entry.message, 'Now using {address}.')
  assert.deepEqual(entry.entry.placeholders, { address: { example: 'home.local' } })
})

test('an argument with no name is reported, with both ways to fix it', () => {
  const result = android(`<string name="greet">Hello %1$s</string>`)
  const finding = result.findings.find((f) => f.code === 'IMPORT_UNNAMED_ARG')
  assert.ok(finding)
  assert.equal(finding.arg, 'arg1')
  assert.equal(finding.catalogKey, 'app.greet')
  assert.match(finding.detail, /xliff:g/)
})

test('a section header labels the group and does not become one string’s comment', () => {
  const result = android(
    `<!-- Notifications --><string name="a_one">One</string><string name="a_two">Two</string>`,
  )
  assert.equal(result.entries[0].entry.group, 'Notifications')
  assert.equal(result.entries[1].entry.group, 'Notifications')
  assert.equal(result.entries[0].entry.comment, undefined, 'a header is not a description')
})

test('a sentence-shaped comment above a string is that string’s comment', () => {
  const result = android(`<!-- Shown while a batch is still arriving. --><string name="a_b">x</string>`)
  assert.equal(result.entries[0].entry.comment, 'Shown while a batch is still arriving.')
})

test('translatable="false" is left out entirely', () => {
  assert.equal(android(`<string name="a_b" translatable="false">x</string>`).entries.length, 0)
})

test('a string array is skipped by name rather than mangled into one message', () => {
  const result = android(`<string-array name="choices"><item>a</item><item>b</item></string-array>`)
  assert.equal(result.entries.length, 0)
  assert.equal(result.findings[0].code, 'IMPORT_SKIPPED')
  assert.match(result.findings[0].detail, /not one message/)
})

test('ICU metacharacters in the source text are escaped so the result still parses', () => {
  const entry = only(android(`<string name="a_b">Use {braces} and 50%% and it\\'s fine</string>`))
  assert.doesNotThrow(() => analyze(entry.entry.message))
  assert.match(entry.entry.message, /'\{'braces'\}'/)
})

test('an apostrophe before a placeholder is doubled, so ICU cannot swallow the argument', () => {
  const entry = only(android(`<string name="a_b">l\\'<xliff:g id="name">%1$s</xliff:g></string>`))
  const parsed = analyze(entry.entry.message)
  assert.ok(parsed.args.has('name'), 'the placeholder survived the apostrophe')
})

test('whitespace is collapsed unless the string is quoted, which is what Android does', () => {
  assert.equal(only(android(`<string name="a_b">one\n      two</string>`)).entry.message, 'one two')
  assert.equal(only(android(`<string name="a_b">"  padded  "</string>`)).entry.message, '  padded  ')
})

// --- Chrome -----------------------------------------------------------------

test('Chrome placeholders carry their example across, and $$ stays a dollar sign', () => {
  const result = importChrome(
    JSON.stringify({
      pay: { message: 'Send to $DEVICE$ for $$5', description: 'Dialog', placeholders: { DEVICE: { content: '$1', example: 'Phone' } } },
    }),
    { namespace: 'ext' },
  )
  assert.equal(result.entries[0].entry.message, 'Send to {device} for $5')
  assert.deepEqual(result.entries[0].entry.placeholders, { device: { example: 'Phone' } })
})

test('a bare positional in Chrome is reported rather than accepted quietly', () => {
  const result = importChrome(JSON.stringify({ hi: { message: 'Hello $1' } }), { namespace: 'ext' })
  assert.equal(result.entries[0].entry.message, 'Hello {arg1}')
  assert.equal(result.findings[0].code, 'IMPORT_UNNAMED_ARG')
})

// --- Apple ------------------------------------------------------------------

test('an Xcode substitution plural becomes an ICU plural in place', () => {
  const result = importXcstrings(
    JSON.stringify({
      sourceLanguage: 'en',
      strings: {
        'send.confirm': {
          localizations: {
            en: {
              stringUnit: { value: 'Send %#@tabCount@ to %2$@?' },
              substitutions: {
                tabCount: {
                  argNum: 1,
                  formatSpecifier: 'lld',
                  variations: { plural: { one: { stringUnit: { value: '%arg tab' } }, other: { stringUnit: { value: '%arg tabs' } } } },
                },
              },
            },
          },
        },
      },
    }),
    { namespace: 'ios' },
  )
  assert.equal(result.entries[0].entry.message, 'Send {tabCount, plural, one {# tab} other {# tabs}} to {arg2}?')
  assert.doesNotThrow(() => analyze(result.entries[0].entry.message))
})

test('a key that is the English text still gets a usable catalog key', () => {
  const result = importXcstrings(
    JSON.stringify({ sourceLanguage: 'en', strings: { 'Open all tabs': { comment: 'Button' } } }),
    { namespace: 'ios' },
  )
  assert.equal(result.entries[0].entry.message, 'Open all tabs')
  assert.equal(result.entries[0].entry.platformNames.apple, 'Open all tabs')
  assert.match(result.entries[0].key, /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/)
})

test('a legacy .strings comment becomes the catalog comment', () => {
  const result = importStrings('/* The send button */\n"send" = "Send";\n', { namespace: 'ios' })
  assert.equal(result.entries[0].entry.comment, 'The send button')
})

// --- plain ICU JSON ---------------------------------------------------------

test('nested JSON flattens, and the original lookup path is kept', () => {
  const result = importIcuJson(JSON.stringify({ send: { confirmTitle: 'Send?' } }), { namespace: 'web' })
  assert.equal(result.entries[0].key, 'send.confirm_title')
  assert.equal(result.entries[0].entry.platformNames.web, 'send.confirmTitle')
})

test("react-intl's extracted shape brings its description along as the comment", () => {
  const result = importIcuJson(
    JSON.stringify({ 'send.go': { defaultMessage: 'Send', description: 'Primary button' } }),
    { namespace: 'web' },
  )
  assert.equal(result.entries[0].entry.comment, 'Primary button')
})
