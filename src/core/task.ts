/** Task files: `work/tasks/TASK-###.md`. Parse, validate, render, and fingerprint the mandate. */
import { createHash } from 'node:crypto'
import { list, parse, str, stringify, type Fields } from './frontmatter.ts'
import { patternProblem } from './scope.ts'
import { TASK_ID, UserError, type Basis, type Mandate, type TaskContract } from './model.ts'

export const TASK_KEYS = ['id', 'title', 'parent', 'depends', 'tier', 'review', 'basis', 'authority', 'scope', 'accept'] as const

export interface TaskIssue {
  readonly task: string
  readonly problem: string
}

function basisOf(raw: string | undefined): Basis | undefined {
  if (raw === undefined || raw === '' || raw === 'explicit') return 'explicit'
  if (/^rule:[a-z0-9][a-z0-9-]*$/.test(raw)) return raw as Basis
  return undefined
}

/** Parse a task file; `problems` lists every contract violation instead of stopping at the first. */
export function parseTask(text: string, fileId?: string): { task?: TaskContract; problems: string[] } {
  const problems: string[] = []
  let fields: Fields
  let body: string
  try {
    ;({ fields, body } = parse(text))
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)] }
  }
  const unknown = Object.keys(fields).filter((key) => !(TASK_KEYS as readonly string[]).includes(key) && key !== 'state')
  if (unknown.length) problems.push(`unknown field(s): ${unknown.join(', ')}`)
  if ('state' in fields) problems.push('state is not a task field: rw keeps it (run `rw status`)')
  let id = '', title = '', parent = '', tier = '', authority = '', reviewRaw = ''
  try {
    id = str(fields, 'id') ?? ''
    title = str(fields, 'title') ?? ''
    parent = str(fields, 'parent') ?? ''
    tier = str(fields, 'tier') ?? 'build'
    authority = str(fields, 'authority') ?? ''
    reviewRaw = str(fields, 'review') ?? 'none'
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const basis = basisOf(typeof fields.basis === 'string' ? fields.basis : undefined)
  const scope = list(fields, 'scope')
  const accept = list(fields, 'accept')
  const depends = list(fields, 'depends')
  if (!TASK_ID.test(id)) problems.push(`id must look like TASK-001, got ${JSON.stringify(id)}`)
  if (fileId && id !== fileId) problems.push(`id ${id} does not match its file name ${fileId}.md`)
  if (!title) problems.push('missing title')
  if (!basis) problems.push('basis must be explicit or rule:<rule-id>')
  if (!authority) problems.push('missing authority: who approved this work, and when')
  if (scope.length === 0) problems.push('missing scope: the paths this task may change')
  if (accept.length === 0) problems.push('missing accept: the exact commands that prove it')
  if (!/^[a-z][a-z0-9-]*$/.test(tier)) problems.push(`bad tier ${JSON.stringify(tier)}`)
  if (reviewRaw !== 'none' && reviewRaw !== 'required') problems.push('review must be none or required')
  for (const dep of depends) if (!TASK_ID.test(dep)) problems.push(`depends entry ${dep} is not a task id`)
  if (depends.includes(id)) problems.push('a task cannot depend on itself')
  for (const path of scope) {
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
      problems.push(`scope path ${path} must be relative to the repository root`)
    }
    const bad = patternProblem(path)
    if (bad) problems.push(`scope ${bad}`)
  }
  if (!body.trim()) problems.push('missing body: a ## Goal section in the owner\'s words')
  if (problems.length) return { problems }
  return {
    task: {
      id, title, parent, depends, tier, review: reviewRaw as 'none' | 'required',
      basis: basis as Basis, authority, scope, accept, body,
    },
    problems,
  }
}

export function requireTask(text: string, fileId?: string): TaskContract {
  const { task, problems } = parseTask(text, fileId)
  if (!task) throw new UserError(`${fileId ?? 'task'}: ${problems.join('; ')}`)
  return task
}

export function renderTask(task: TaskContract): string {
  const fields: Record<string, string | readonly string[]> = {
    id: task.id,
    title: task.title,
    ...(task.parent ? { parent: task.parent } : {}),
    depends: task.depends,
    tier: task.tier,
    review: task.review,
    basis: task.basis,
    authority: task.authority,
    scope: task.scope,
    accept: task.accept,
  }
  return stringify(fields, task.body, TASK_KEYS)
}

/** The fingerprint the watchdog compares: the mandate, the dependencies and the goal text. */
export function mandateHash(task: Mandate & Pick<TaskContract, 'depends' | 'body' | 'title'>): string {
  const canonical = JSON.stringify({
    basis: task.basis, authority: task.authority, scope: task.scope, accept: task.accept,
    depends: task.depends, title: task.title, body: task.body.trim().replaceAll('\r\n', '\n'),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function bodyTemplate(goal: string): string {
  return [
    '## Goal',
    '',
    goal.trim() || 'State the outcome in the owner\'s words.',
    '',
    '## Read first',
    '',
    '- (the decision, spec section or file the worker must read; ids only, no paraphrase)',
    '',
    '## Out of scope',
    '',
    '- (what the worker must not touch, if the scope globs do not already say it)',
  ].join('\n')
}

/** Validate the whole set: unknown dependencies and cycles. */
export function validateSet(tasks: readonly TaskContract[]): TaskIssue[] {
  const issues: TaskIssue[] = []
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    for (const dep of task.depends) if (!ids.has(dep)) issues.push({ task: task.id, problem: `depends on unknown ${dep}` })
  }
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (done.has(id)) return
    if (visiting.has(id)) {
      issues.push({ task: id, problem: `dependency cycle ${[...path, id].join(' → ')}` })
      return
    }
    visiting.add(id)
    for (const dep of byId.get(id)?.depends ?? []) if (byId.has(dep)) visit(dep, [...path, id])
    visiting.delete(id)
    done.add(id)
  }
  for (const task of tasks) visit(task.id, [])
  return issues
}
