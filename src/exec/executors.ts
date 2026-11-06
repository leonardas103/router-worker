/**
 * Executor adapters. Each turns a lane prompt into one process invocation and reads back what the run
 * left in its log: a resumable session id, a cost, and whether it died of capacity (quota, rate limit),
 * which moves the lane to the next executor of its tier instead of failing the task.
 */
import { randomUUID } from 'node:crypto'
import type { ClaudeExecutor, CommandExecutor, ExecutorConfig } from '../app/config.ts'

export type Role = 'worker' | 'reviewer'

export interface Invocation {
  readonly argv: readonly string[]
  /** Text written to the process's stdin, then closed. */
  readonly stdin?: string
  /** The session id known before the run (claude assigns ours); otherwise read from the log after. */
  readonly session: string
}

export interface LaunchInput {
  readonly role: Role
  readonly task: string
  readonly cwd: string
  readonly model: string
  readonly prompt: string
  readonly promptFile: string
  /** Directories outside the worktree the session may write, such as the reviewer's review file. */
  readonly addDirs?: readonly string[]
  /** Set to continue an existing session with a follow-up instead of starting one. */
  readonly resumeSession?: string
}

export interface Outcome {
  readonly session?: string
  readonly costUsd?: number
  readonly capacity: boolean
}

export class ExecutorError extends Error {}

function claude(spec: ClaudeExecutor, input: LaunchInput): Invocation {
  const session = input.resumeSession ?? randomUUID()
  const tools = input.role === 'reviewer' ? spec.reviewerTools : spec.allowedTools
  const argv = [
    spec.command, '-p', '--output-format', 'stream-json', '--verbose',
    ...(input.resumeSession ? ['--resume', session] : ['--session-id', session]),
    '--permission-mode', input.role === 'reviewer' ? 'default' : spec.permissionMode,
    ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
    ...(input.role === 'reviewer' ? ['--disallowedTools', 'Edit,NotebookEdit'] : []),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
    ...spec.extraArgs,
  ]
  return { argv, stdin: input.prompt, session }
}

function command(spec: CommandExecutor, input: LaunchInput): Invocation {
  const resuming = input.resumeSession !== undefined
  if (resuming && spec.resume.length === 0) throw new ExecutorError('this executor has no resume command; the follow-up starts a new session')
  const template = resuming ? spec.resume : spec.start
  const vars: Record<string, string> = {
    promptFile: input.promptFile, cwd: input.cwd, model: input.model, session: input.resumeSession ?? '',
    task: input.task, role: input.role,
  }
  const argv = template.map((arg) => arg.replace(/\{(promptFile|cwd|model|session|task|role)\}/g, (_, name: string) => vars[name] ?? ''))
  return { argv, ...(spec.stdin ? { stdin: input.prompt } : {}), session: input.resumeSession ?? '' }
}

export function invocation(spec: ExecutorConfig, input: LaunchInput): Invocation {
  switch (spec.kind) {
    case 'claude':
      return claude(spec, input)
    case 'command':
      return command(spec, input)
    case 'manual':
      throw new ExecutorError('a manual lane has no process: rw prints its prompt for a person or an IDE agent')
    case 'dsh':
      throw new ExecutorError('the dsh executor runs only inside the DSH plugin (plugin/dsh); use claude, command or manual from the CLI')
  }
}

export function canResume(spec: ExecutorConfig): boolean {
  return spec.kind === 'claude' || (spec.kind === 'command' && spec.resume.length > 0) || spec.kind === 'dsh'
}

/** Read the run's log. Only the tail matters for capacity: an early mention of "quota" in code is not a failure. */
export function outcome(spec: ExecutorConfig, log: string, exitCode: number): Outcome {
  const tail = log.slice(-8000)
  const pattern = 'capacityPattern' in spec && spec.capacityPattern ? new RegExp(spec.capacityPattern, 'i') : undefined
  const capacity = exitCode !== 0 && pattern !== undefined && pattern.test(tail)
  if (spec.kind === 'claude') {
    let session: string | undefined
    let costUsd: number | undefined
    for (const line of log.split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const event = JSON.parse(line) as { type?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string }
        if (typeof event.session_id === 'string') session = event.session_id
        if (event.type === 'result' && typeof event.total_cost_usd === 'number') costUsd = event.total_cost_usd
      } catch {
        // a partial line at the end of a killed run
      }
    }
    return { ...(session ? { session } : {}), ...(costUsd !== undefined ? { costUsd } : {}), capacity }
  }
  if (spec.kind === 'command' && spec.sessionPattern) {
    const match = new RegExp(spec.sessionPattern).exec(log)
    if (match?.[1]) return { session: match[1], capacity }
  }
  return { capacity }
}
