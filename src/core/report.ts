/** Worker reports: `work/reports/TASK-###.md`, written by the worker on its lane branch. */
import { parse, str, stringify } from './frontmatter.ts'
import { REPORT_STATES, type CommandResult, type Report, type ReportState, type TaskContract } from './model.ts'

const QUESTION_WORDS = 80

function cells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}

/** Rows of the table under `## Commands`: the exact command and its result. */
export function commandTable(body: string): CommandResult[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((line) => /^##\s+Commands\s*$/i.test(line.trim()))
  if (start < 0) return []
  const rows: CommandResult[] = []
  let header = true
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    const row = cells(line)
    if (!row) continue
    if (row.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
    if (header) {
      header = false
      continue
    }
    rows.push({ command: clean(row[0] ?? ''), result: (row[1] ?? '').trim() })
  }
  return rows
}

export function clean(command: string): string {
  return command.replaceAll('`', '').replace(/\s+/g, ' ').trim()
}

export function passed(result: string): boolean {
  return /^(pass|ok|green|✅|✓)/i.test(result.trim())
}

export function words(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}

export function parseReport(text: string): { report?: Report; problems: string[] } {
  const problems: string[] = []
  let doc
  try {
    doc = parse(text)
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)] }
  }
  const task = str(doc.fields, 'task') ?? ''
  const state = (str(doc.fields, 'state') ?? '') as ReportState
  if (!/^TASK-\d{3,}$/.test(task)) problems.push('report needs task: TASK-###')
  if (!REPORT_STATES.includes(state)) problems.push(`report state must be one of ${REPORT_STATES.join(', ')}`)
  if (problems.length) return { problems }
  return {
    report: {
      task, state,
      commit: str(doc.fields, 'commit') ?? '',
      question: str(doc.fields, 'question') ?? '',
      commands: commandTable(doc.body),
      body: doc.body,
    },
    problems,
  }
}

/** What the report must say for its state. The git-side checks (commit, cleanliness, scope) live in the app. */
export function checkReport(report: Report, task: TaskContract): string[] {
  const problems: string[] = []
  if (report.task !== task.id) problems.push(`report is for ${report.task}, not ${task.id}`)
  if (report.state === 'ready') {
    const ran = new Map(report.commands.map((row) => [clean(row.command), row.result]))
    for (const command of task.accept) {
      const result = ran.get(clean(command))
      if (result === undefined) problems.push(`acceptance command not reported: ${command}`)
      else if (!passed(result)) problems.push(`acceptance command did not pass: ${command} → ${result}`)
    }
    if (report.question) problems.push('a ready report has no open question; report blocked to ask one')
  }
  if (report.state === 'blocked') {
    if (!report.question) problems.push('a blocked report needs question: one concrete question the owner can answer')
    else if (words(report.question) > QUESTION_WORDS) problems.push(`question has ${words(report.question)} words; ask one concrete question in at most ${QUESTION_WORDS}`)
  }
  if ((report.state === 'dropped' || report.state === 'failed') && !report.body.trim()) {
    problems.push(`a ${report.state} report says why in its body`)
  }
  return problems
}

export function reportTemplate(task: TaskContract): string {
  const rows = task.accept.map((command) => `| \`${command}\` | PASS / FAIL + one line |`)
  return stringify(
    { task: task.id, state: 'ready', commit: '', question: '' },
    [
      '## Summary',
      '',
      'One paragraph: the user-visible outcome, then what changed.',
      '',
      '## Changed',
      '',
      '- path — why',
      '',
      '## Commands',
      '',
      '| Command | Result |',
      '| --- | --- |',
      ...rows,
      '',
      '## Risks',
      '',
      '- none, or the risk and who it affects',
      '',
      '## Gaps',
      '',
      '- known functionality not done here, with the owner it belongs to',
    ].join('\n'),
    ['task', 'state', 'commit', 'question'],
  )
}
