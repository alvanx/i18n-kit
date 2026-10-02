/**
 * Running adapters and writing their output.
 *
 * Three guards sit between a catalog and a file on disk:
 *
 *   Capability. A message using a construct the target cannot express stops the
 *   export for that target. `check` reports the same thing earlier, but export
 *   re-checks rather than trusting that anyone ran it.
 *
 *   Ownership. Every generated file carries a marker. A file already sitting at
 *   a target path without one belongs to somebody else, and export refuses
 *   rather than eating a hand-written strings.xml that predates the toolkit.
 *
 *   Determinism. Output is byte-stable for a given catalog, which is what lets
 *   `check` assert that committed artifacts match the source of truth.
 */

import { existsSync, readFileSync } from 'node:fs'
import { getAdapter, capabilityFindings, resolveLocaleTag, messagesForTarget } from './adapters/index.mjs'
import { writeIfChanged, checkOwnership } from './writer.mjs'

/**
 * Plan every file the enabled targets would write, without touching disk.
 *
 * @returns {{ plans: Array<{target: string, files: Array<object>}>, findings: Array<object> }}
 */
export function planExport(project) {
  const config = project.config
  const plans = []
  const findings = []

  for (const [name, target] of config.enabledTargets()) {
    const adapter = getAdapter(target.adapter)

    for (const locale of config.targetLocales()) {
      const resolved = resolveLocaleTag(locale, target, adapter)
      if (!resolved.ok) {
        findings.push({ code: resolved.code, detail: resolved.detail, target: name, locale })
      }
    }

    let blocked = false
    for (const { namespace, key, entry } of messagesForTarget(project, name)) {
      const analysis = project.tryAnalysisOf(entry.message)
      if (!analysis) continue // the parse error is reported by check
      for (const finding of capabilityFindings(analysis, adapter, { targetName: name })) {
        findings.push({ ...finding, target: name, namespace, key })
        blocked = true
      }
    }

    // Emitting a target with a known-unrepresentable message would produce
    // exactly the lossy output this design refuses, so skip it entirely and
    // let the findings explain why.
    if (blocked || findings.some((f) => f.target === name && f.code === 'UNMAPPED_LOCALE')) continue

    plans.push({ target: name, files: adapter.emit({ project, config, target: { ...target, name } }) })
  }

  return { plans, findings }
}

/**
 * Write the planned files.
 *
 * @param {import('./catalog.mjs').Project} project
 * @param {{dryRun?: boolean}} opts
 */
export function runExport(project, { dryRun = false } = {}) {
  const { plans, findings } = planExport(project)
  const written = []
  const unchanged = []

  for (const plan of plans) {
    for (const file of plan.files) {
      const ownership = checkOwnership(file.path, file.isOurs ?? (() => false))
      if (!ownership.ok) {
        findings.push({ ...ownership, target: plan.target, path: file.path })
        continue
      }

      if (dryRun) {
        const same = existsSync(file.path) && readFileSync(file.path, 'utf8') === file.contents
        ;(same ? unchanged : written).push(file.path)
        continue
      }

      if (writeIfChanged(file.path, file.contents)) written.push(file.path)
      else unchanged.push(file.path)
    }
  }

  return { written, unchanged, findings }
}

/**
 * Compare committed artifacts against a fresh render.
 *
 * Only meaningful when `generated.committed` is on. It catches the merge that
 * updated the catalog but not the generated files, which otherwise ships stale
 * strings while every catalog check passes.
 */
export function checkDrift(project) {
  const { plans, findings } = planExport(project)

  for (const plan of plans) {
    for (const file of plan.files) {
      if (!existsSync(file.path)) {
        findings.push({
          code: 'GENERATED_DRIFT',
          target: plan.target,
          path: file.path,
          detail: `${file.path} is missing. Run \`i18n export\`.`,
        })
        continue
      }
      if (readFileSync(file.path, 'utf8') !== file.contents) {
        findings.push({
          code: 'GENERATED_DRIFT',
          target: plan.target,
          path: file.path,
          detail: `${file.path} does not match a fresh export. Run \`i18n export\` and commit the result.`,
        })
      }
    }
  }

  return findings
}
