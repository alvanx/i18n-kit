/**
 * Rendering a check report.
 *
 * Three formats, because three different readers exist: a person at a terminal,
 * a GitHub Actions log that can turn findings into annotations, and a machine.
 *
 * The human format groups by severity rather than by file. A run with two
 * errors and ninety warnings should open with the two errors, because those are
 * what stop the build; a file-ordered list buries them.
 */

const COLORS = {
  error: '[31m',
  warn: '[33m',
  info: '[90m',
  dim: '[2m',
  bold: '[1m',
  reset: '[0m',
}

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR

const paint = (text, color) => (useColor() ? `${COLORS[color]}${text}${COLORS.reset}` : text)

/**
 * Where a finding happened, as one readable location.
 *
 * Namespace and key are joined with a slash rather than a dot. Keys contain
 * dots of their own, so `app.app.greeting` leaves a reader counting segments to
 * work out where the namespace ends; `app/app.greeting` does not.
 */
function locationOf(finding) {
  const parts = []
  if (finding.locale) parts.push(finding.locale)
  if (finding.target) parts.push(`target:${finding.target}`)
  if (finding.namespace && finding.key) parts.push(`${finding.namespace}/${finding.key}`)
  else if (finding.key) parts.push(finding.key)
  else if (finding.path) parts.push(finding.path)
  else if (finding.file) parts.push(finding.file)
  return parts.join(' · ')
}

export function formatHuman(report) {
  const lines = []
  const bySeverity = { error: [], warn: [], info: [] }
  for (const f of report.findings) bySeverity[f.severity].push(f)

  const HEADINGS = {
    error: 'Errors (these break at runtime or ship wrong text)',
    warn: 'Warnings (a human should look)',
    info: 'Notes',
  }

  for (const severity of ['error', 'warn', 'info']) {
    const group = bySeverity[severity]
    if (group.length === 0) continue

    lines.push('')
    lines.push(paint(`${HEADINGS[severity]} — ${group.length}`, severity === 'info' ? 'dim' : severity))

    for (const f of group) {
      const location = locationOf(f)
      lines.push(`  ${paint(f.code, severity)}${location ? ` ${paint(location, 'dim')}` : ''}`)
      lines.push(`    ${f.detail}`)
    }
  }

  lines.push('')
  const { error, warn, info } = report.counts
  const summary = `${error} error${error === 1 ? '' : 's'}, ${warn} warning${warn === 1 ? '' : 's'}, ${info} note${info === 1 ? '' : 's'}`

  if (report.ok && warn === 0 && info === 0) {
    lines.push(paint('Everything checks out.', 'bold'))
  } else if (report.ok) {
    lines.push(`${paint('Passed', 'bold')} with ${summary}.`)
  } else {
    lines.push(`${paint('Failed', 'error')}: ${summary}.`)
    lines.push(paint('Run `i18n check --explain <CODE>` for what a rule means and why it exists.', 'dim'))
  }
  if (report.release) lines.push(paint('Release mode: rules that only block a release were applied.', 'dim'))

  return lines.join('\n')
}

/** GitHub Actions workflow commands, which the UI turns into inline annotations. */
export function formatGithub(report) {
  const LEVEL = { error: 'error', warn: 'warning', info: 'notice' }
  return report.findings
    .map((f) => {
      const file = f.file ?? f.path
      const props = [file ? `file=${file}` : null, `title=${f.code}`].filter(Boolean).join(',')
      const location = locationOf(f)
      const text = `${location ? `${location}: ` : ''}${f.detail}`.replaceAll('\n', '%0A')
      return `::${LEVEL[f.severity]} ${props}::${text}`
    })
    .join('\n')
}

export function formatJson(report) {
  return JSON.stringify(
    {
      ok: report.ok,
      counts: report.counts,
      release: report.release,
      findings: report.findings.map((f) => ({ ...f, description: report.describe(f.code) })),
    },
    null,
    2,
  )
}

export function formatReport(report, format) {
  switch (format) {
    case 'json':
      return formatJson(report)
    case 'github':
      return formatGithub(report)
    default:
      return formatHuman(report)
  }
}

/** Per-locale completeness, for `i18n status`. */
export function formatStatus(rows) {
  const columns = ['locale', 'translated', 'missing', 'stale', 'failed', 'human']
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  )

  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')

  return [
    paint(line(columns), 'bold'),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => r[c] ?? ''))),
  ].join('\n')
}
