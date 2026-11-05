import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, ConfigError } from '../src/config.mjs'
import { severityOf } from '../src/rules.mjs'
import { ADAPTERS, adapterForTarget, capabilityFindings } from '../src/adapters/index.mjs'
import { analyze } from '../src/icu.mjs'

const base = {
  schemaVersion: 1,
  sourceLocale: 'en',
  locales: { required: ['de', 'ja'], optional: ['ar'] },
}

const load = (overrides = {}) => resolveConfig({ ...base, ...overrides }, { root: '/proj' })

test('applies defaults', () => {
  const cfg = load()
  assert.equal(cfg.policy.defaultClass, 'ui')
  assert.equal(cfg.policy.zeroCase, 'separate-key')
  assert.equal(cfg.generated.committed, false)
  assert.equal(cfg.paths.source, '/proj/i18n/source')
  assert.equal(cfg.paths.out, '/proj/build/i18n')
  assert.deepEqual(cfg.locales.all, ['de', 'ja', 'ar'])
})

test('undeclared locales fall straight back to source', () => {
  assert.deepEqual(load().fallbackChain('de'), ['de', 'en'])
})

test('accepts an explicit fallback chain', () => {
  const cfg = resolveConfig(
    {
      ...base,
      locales: { required: ['pt-BR', 'pt'], optional: [] },
      fallback: { 'pt-BR': ['pt-BR', 'pt', 'en'] },
    },
    { root: '/proj' },
  )
  assert.deepEqual(cfg.fallbackChain('pt-BR'), ['pt-BR', 'pt', 'en'])
})

test('rejects a fallback chain that does not end at the source locale', () => {
  assert.throws(
    () =>
      resolveConfig(
        { ...base, locales: { required: ['pt-BR', 'pt'] }, fallback: { 'pt-BR': ['pt-BR', 'pt'] } },
        { root: '/proj' },
      ),
    /must end at the source locale/,
  )
})

test('rejects a locale listed as both required and optional', () => {
  assert.throws(() => load({ locales: { required: ['de'], optional: ['de'] } }), /both required and optional/)
})

test('rejects the source locale appearing as a target', () => {
  assert.throws(() => load({ locales: { required: ['en', 'de'] } }), /must not appear in locales/)
})

test('rejects an unknown adapter', () => {
  assert.throws(() => load({ targets: { web: { adapter: 'flutter' } } }), /Known adapters/)
})

test('rejects Android legacy locale format alongside a script subtag', () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          ...base,
          locales: { required: ['zh-Hans'] },
          targets: { android: { adapter: 'android', options: { localeFormat: 'legacy' } } },
        },
        { root: '/proj' },
      ),
    /cannot express the script subtag/,
  )
})

test('a project may raise a warning to an error', () => {
  const cfg = load({ severity: { TEXT_EXPANSION: 'error' } })
  assert.equal(severityOf('TEXT_EXPANSION', { overrides: cfg.severity }), 'error')
})

test('a project may not lower an error', () => {
  assert.throws(() => load({ severity: { PLACEHOLDER_MISMATCH: 'warn' } }), /cannot be lowered/)
})

test('rejects an unknown rule code in severity overrides', () => {
  assert.throws(() => load({ severity: { NOT_A_RULE: 'warn' } }), /not a known rule code/)
})

test('release mode raises stale human text to an error', () => {
  assert.equal(severityOf('STALE_HUMAN_TEXT'), 'warn')
  assert.equal(severityOf('STALE_HUMAN_TEXT', { release: true }), 'error')
})

test('expansion budget shrinks as source strings get longer', () => {
  const cfg = load()
  assert.equal(cfg.expansionBudgetFor(5, 'de'), 3.0)
  assert.equal(cfg.expansionBudgetFor(45, 'de'), 1.6)
  assert.equal(cfg.expansionBudgetFor(200, 'de'), 1.3)
})

test('a per-locale expansion override multiplies the bucket', () => {
  const cfg = load({ policy: { localeExpansionOverride: { de: 1.2 } } })
  assert.equal(Math.round(cfg.expansionBudgetFor(45, 'de') * 100) / 100, 1.92)
  assert.equal(cfg.expansionBudgetFor(45, 'ja'), 1.6)
})

test('targetsForMessage honours a message-level targets list', () => {
  const cfg = load({
    targets: { web: { adapter: 'web' }, android: { adapter: 'android' } },
  })
  assert.deepEqual(
    cfg.targetsForMessage({ targets: ['web'] }).map(([n]) => n),
    ['web'],
  )
  assert.deepEqual(cfg.targetsForMessage({}).map(([n]) => n), ['web', 'android'])
})

test('a disabled target is excluded', () => {
  const cfg = load({
    targets: { web: { adapter: 'web' }, android: { adapter: 'android', enabled: false } },
  })
  assert.deepEqual(cfg.enabledTargets().map(([n]) => n), ['web'])
})

test('ConfigError carries a hint', () => {
  try {
    load({ locales: { required: ['de'], optional: ['de'] } })
    assert.fail('expected a throw')
  } catch (err) {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /Required fails check/)
  }
})

test('a relative target out path resolves against the project root', () => {
  // Left relative it resolved against the process working directory, so an
  // export run from anywhere but the project root scattered strings.xml
  // files outside the repository.
  const config = resolveConfig(
    {
      schemaVersion: 1,
      sourceLocale: 'en',
      locales: { required: ['de'], optional: [] },
      targets: { android: { adapter: 'android', out: 'app/src/main/res' } },
    },
    { root: '/tmp/project', file: '/tmp/project/i18n/config.json' },
  )
  assert.equal(config.targets.android.out, '/tmp/project/app/src/main/res')
})

test('an absolute target out path is left alone', () => {
  const config = resolveConfig(
    {
      schemaVersion: 1,
      sourceLocale: 'en',
      locales: { required: ['de'], optional: [] },
      targets: { android: { adapter: 'android', out: '/elsewhere/res' } },
    },
    { root: '/tmp/project', file: '/tmp/project/i18n/config.json' },
  )
  assert.equal(config.targets.android.out, '/elsewhere/res')
})

test('a target declares the ICU subset its own formatter really has', () => {
  const cfg = load({
    targets: {
      ext: {
        adapter: 'web',
        out: 'extension/src/locales',
        capabilities: { dateTimeArgs: false, selectordinal: false, numberDateSkeletons: false },
      },
    },
  })
  const adapter = adapterForTarget(cfg.targets.ext)
  assert.equal(adapter.capabilities.dateTimeArgs, false)
  assert.equal(adapter.capabilities.selectordinal, false)
  // Untouched flags still come from the adapter.
  assert.equal(adapter.capabilities.select, true)
  assert.equal(adapter.capabilities.plurals, 'icu')
  // And the stock adapter is not mutated for everyone else.
  assert.equal(ADAPTERS.web.capabilities.dateTimeArgs, true)
})

test('a declared subset makes check fail on a construct the app would throw on', () => {
  const cfg = load({ targets: { ext: { adapter: 'web', capabilities: { dateTimeArgs: false } } } })
  const findings = capabilityFindings(analyze('Sent {when, date, short}'), adapterForTarget(cfg.targets.ext), {
    targetName: 'ext',
  })
  assert.equal(findings.length, 1)
  assert.match(findings[0].detail, /date/)
  // The same message is fine for a target that did not narrow.
  assert.deepEqual(capabilityFindings(analyze('Sent {when, date, short}'), ADAPTERS.web, { targetName: 'web' }), [])
})

test('claiming more than the adapter can write is a config error, not a surprise at export', () => {
  assert.throws(
    () => load({ targets: { droid: { adapter: 'android', capabilities: { richText: true } } } }),
    (err) => err instanceof ConfigError && /cannot express it/.test(err.message),
  )
})

test('a capability that decides how files are written is not a project setting', () => {
  assert.throws(
    () => load({ targets: { ext: { adapter: 'web', capabilities: { plurals: 'none' } } } }),
    (err) => err instanceof ConfigError && /belongs to the adapter/.test(err.message),
  )
  assert.throws(
    () => load({ targets: { ext: { adapter: 'web', capabilities: { nope: false } } } }),
    (err) => err instanceof ConfigError && /Not a capability/.test(err.message),
  )
})

test('nesting may only be declared shallower', () => {
  assert.equal(adapterForTarget(load({ targets: { ext: { adapter: 'web', capabilities: { nesting: 1 } } } }).targets.ext).capabilities.nesting, 1)
  assert.throws(
    () => load({ targets: { ext: { adapter: 'web', capabilities: { nesting: 99 } } } }),
    (err) => err instanceof ConfigError && /deeper than/.test(err.message),
  )
})

test('a project whose tags live outside the formatter can say so', () => {
  assert.equal(load().policy.richText, 'icu')
  assert.equal(load({ policy: { richText: 'none' } }).policy.richText, 'none')
  assert.throws(
    () => load({ policy: { richText: 'html' } }),
    (err) => err instanceof ConfigError && /must be "icu" or "none"/.test(err.message),
  )
})
