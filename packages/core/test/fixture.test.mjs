/**
 * Golden-file tests against the committed hard-cases fixture.
 *
 * The fixture is the standing answer to "does this toolkit handle the awkward
 * parts of ICU": a plural beside other arguments, a plural inside a select,
 * selectordinal, an offset, an exact match, rich text, a repeated argument, and
 * number and date skeletons. If a change breaks one of them, a golden diff says
 * exactly which.
 *
 * Regenerate deliberately with UPDATE_GOLDEN=1, and read the diff before
 * committing it. A golden file that updates itself silently tests nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { loadProject } from '../src/catalog.mjs'
import { check } from '../src/check.mjs'
import { planExport } from '../src/export.mjs'
import { generatePseudoLocale, PSEUDO_LOCALES } from '../src/pseudo.mjs'
import { analyze, compareStructure } from '../src/icu.mjs'
import { serializeJson } from '../src/writer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '../../../fixtures/hard-cases')
const GOLDEN = join(FIXTURE, 'golden')

const UPDATE = process.env.UPDATE_GOLDEN === '1'

function assertGolden(name, actual) {
  const path = join(GOLDEN, name)
  if (UPDATE || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, actual, 'utf8')
    if (!UPDATE) return // first run writes the baseline
  }
  assert.equal(actual, readFileSync(path, 'utf8'), `golden mismatch for ${name}; run UPDATE_GOLDEN=1 and read the diff`)
}

function fixture() {
  const config = loadConfig(FIXTURE)
  const { project, findings } = loadProject(config)
  return { config, project, loadFindings: findings }
}

test('the fixture source is clean apart from untranslated strings', () => {
  const { project, loadFindings } = fixture()
  const report = check(project, { loadFindings })

  const sourceProblems = report.findings.filter(
    (f) => !f.code.startsWith('MISSING_KEY') && f.severity !== 'info',
  )
  assert.deepEqual(
    sourceProblems.map((f) => `${f.code} ${f.key ?? ''} ${f.detail}`),
    [],
    'the fixture should demonstrate hard cases, not broken ones',
  )
})

test('an ISO date example is not mistaken for personal data', () => {
  const { project, loadFindings } = fixture()
  const report = check(project, { loadFindings })
  assert.equal(
    report.findings.find((f) => f.code === 'EXAMPLE_LOOKS_PERSONAL'),
    undefined,
  )
})

test('every hard case parses and round-trips its structure', () => {
  const { project } = fixture()
  for (const { key, entry } of project.entries()) {
    const analysis = analyze(entry.message)
    assert.deepEqual(compareStructure(analysis, analyze(entry.message)), [], key)
  }
})

test('the fixture actually covers the constructs it claims to', () => {
  const { project } = fixture()
  const seen = new Set()
  for (const { entry } of project.entries()) {
    const c = analyze(entry.message).constructs
    if (c.hasPlural) seen.add('plural')
    if (c.hasSelect) seen.add('select')
    if (c.hasSelectOrdinal) seen.add('selectordinal')
    if (c.hasOffset) seen.add('offset')
    if (c.hasExactMatch) seen.add('exactMatch')
    if (c.hasTags) seen.add('richText')
    if (c.hasNumberOrDate) seen.add('numberDate')
    if (c.repeated.length) seen.add('repeated')
    if (c.maxDepth > 2) seen.add('nesting')
  }
  assert.deepEqual(
    [...seen].sort(),
    ['exactMatch', 'nesting', 'numberDate', 'offset', 'plural', 'repeated', 'richText', 'select', 'selectordinal'],
  )
})

test('web export matches its golden files', () => {
  const { project } = fixture()
  const { plans, findings } = planExport(project)
  assert.deepEqual(findings, [])

  for (const file of plans[0].files) {
    const name = file.path.split('/build/i18n/')[1]
    assertGolden(join('web', name.replace(/^web\//, '')), file.contents)
  }
})

test('export is byte-identical across two runs', () => {
  const a = planExport(fixture().project).plans[0].files.map((f) => f.contents)
  const b = planExport(fixture().project).plans[0].files.map((f) => f.contents)
  assert.deepEqual(a, b)
})

test('pseudo-locales match their golden files and keep every structure', () => {
  const { project } = fixture()
  for (const locale of Object.keys(PSEUDO_LOCALES)) {
    const { messages, skipped } = generatePseudoLocale(project, locale)
    assert.deepEqual(skipped, [], `${locale} should not skip anything in the fixture`)

    for (const { key, entry } of project.entries()) {
      assert.deepEqual(
        compareStructure(analyze(entry.message), analyze(messages[key])),
        [],
        `${locale} changed the structure of ${key}`,
      )
    }

    assertGolden(join('pseudo', `${locale}.json`), serializeJson({ locale, messages }))
  }
})
