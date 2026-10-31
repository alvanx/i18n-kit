import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, ConfigError } from '../src/config.mjs'
import { severityOf } from '../src/rules.mjs'

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
