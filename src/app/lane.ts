/**
 * The lane supervisor: `rw _lane <key>`, started detached by `launch`. It runs the executor in the lane's
 * worktree, keeps a heartbeat from the executor's output, delivers follow-ups that arrived meanwhile to
 * the same session, falls back to the next executor of the tier on a capacity failure, and settles the
 * task if the executor exits without reporting. There is no daemon: each lane supervises itself.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync } from 'node:fs'
import { patchLane } from '../core/state.ts'
import { transition } from '../core/state.ts'
import { readText, writeAtomic } from '../infra/fs.ts'
import { killTree, lastLines, prepare } from '../infra/proc.ts'
import { canResume, invocation, outcome, type Invocation } from '../exec/executors.ts'
import { chain } from './config.ts'
import { laneEnv, lanePromptFile, prepareFailed, prepareLane, report, workerPrompt } from './ops.ts'
import type { Repo } from './repo.ts'

const HEARTBEAT_MS = 10_000
const MAX_ROUNDS = 12

function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function runProcess(repo: Repo, key: string, run: Invocation, cwd: string, log: string, role: string): Promise<number> {
  const fd = openSync(log, 'a')
  const { file, args, shell } = prepare(run.argv)
  // detached on POSIX makes the executor a process-group leader, so hold/stop can end everything it started
  const child = spawn(file, args, { cwd, env: laneEnv(repo, key, role), stdio: ['pipe', fd, fd], shell, windowsHide: true, detached: process.platform !== 'win32' })
  if (child.pid) {
    const after = repo.update((state) => patchLane(state, key, { childPid: child.pid as number }))
    // a hold or stop that landed between the decision to run and the spawn: end the child now
    const lane = after.lanes[key]
    const task = lane ? after.tasks[lane.task]?.state : undefined
    if (!lane || (lane.role === 'worker' ? task !== 'running' : task !== 'review')) killTree(child.pid)
  }
  child.stdin?.on('error', () => {})
  child.stdin?.end(run.stdin ?? '')
  let seen = size(log)
  const beat = setInterval(() => {
    const now = size(log)
    if (now !== seen) {
      seen = now
      repo.update((state) => patchLane(state, key, { heartbeatAt: repo.now() }))
    }
  }, HEARTBEAT_MS)
  try {
    return await new Promise<number>((resolve) => {
      child.on('error', (error) => {
        writeAtomicAppend(log, `\n[rw] could not start ${run.argv[0]}: ${error.message}\n`)
        resolve(127)
      })
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    })
  } finally {
    clearInterval(beat)
    closeSync(fd)
  }
}

function writeAtomicAppend(path: string, text: string): void {
  const current = readText(path) ?? ''
  writeAtomic(path, current + text)
}

export async function runLane(repo: Repo, key: string): Promise<void> {
  repo.update((state) => patchLane(state, key, { pid: process.pid, status: 'running', heartbeatAt: repo.now() }))
  const prepared = prepareLane(repo, key)
  if (!prepared.ok) {
    prepareFailed(repo, key, prepared.reason)
    repo.update((state) => state.lanes[key]?.pid === process.pid ? patchLane(state, key, { status: 'exited', pid: 0 }) : state)
    return
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const state = repo.state()
    const lane = state.lanes[key]
    if (!lane) return
    // Another supervisor took this lane over (a follow-up launched it while this one was finishing): it owns it now.
    if (lane.pid !== process.pid) return
    const taskState = state.tasks[lane.task]?.state
    const spec = repo.config.executors[lane.executor]
    if (!spec) break
    if (lane.role === 'worker' && taskState !== 'running') break
    if (lane.role === 'reviewer' && (taskState !== 'review' || round > 0)) break
    const task = repo.contract(lane.task)
    let prompt: string
    let resumeSession: string | undefined
    if (lane.role === 'reviewer') prompt = readText(lanePromptFile(repo, key)) ?? ''
    else if (!lane.session || !canResume(spec)) prompt = [workerPrompt(repo, task, lane), ...lane.pending].join('\n\n---\n\n')
    else if (lane.pending.length) {
      prompt = lane.pending.join('\n\n---\n\n')
      resumeSession = lane.session
    } else break
    repo.update((current) => patchLane(current, key, { pending: [] }))
    const promptFile = lanePromptFile(repo, `${key}.r${round}`)
    writeAtomic(promptFile, prompt)
    const run = invocation(spec, {
      role: lane.role, task: lane.task, cwd: lane.worktree, model: lane.model, prompt, promptFile,
      addDirs: lane.role === 'reviewer' ? [repo.paths.lanes] : [],
      ...(resumeSession ? { resumeSession } : {}),
    })
    // A session id known before the run (Claude Code takes ours) is recorded now, not at exit: a worker can
    // report blocked mid-turn, and the owner, rw lane and a resume all need the id while the turn finishes.
    if (run.session && run.session !== lane.session) repo.update((current) => patchLane(current, key, { session: run.session }))
    const offset = size(lane.log)
    writeAtomicAppend(lane.log, `\n[rw] ${repo.now()} ${resumeSession ? 'resume' : 'start'} ${lane.executor}${lane.model ? `/${lane.model}` : ''} in ${lane.worktree}\n`)
    const code = await runProcess(repo, key, run, lane.worktree, lane.log, lane.role)
    const text = readFileSync(lane.log, 'utf8').slice(offset)
    const result = outcome(spec, text, code)
    const after = repo.update((current) => {
      const now = current.lanes[key]
      return patchLane(current, key, {
        exitCode: code,
        session: result.session ?? (run.session || now?.session || ''),
        ...(result.costUsd !== undefined ? { costUsd: (now?.costUsd ?? 0) + result.costUsd } : {}),
        heartbeatAt: repo.now(),
      })
    })
    repo.event('lane-exit', { lane: key, executor: lane.executor, code, capacity: result.capacity, costUsd: result.costUsd })
    if (result.capacity) {
      const options = chain(repo.config, lane.role === 'reviewer' ? 'review' : task.tier)
      const index = options.findIndex((option) => option.executor === lane.executor && option.model === lane.model)
      const fallback = options.slice(index + 1).find((option) => repo.config.executors[option.executor]?.kind !== 'manual') ?? options[index + 1]
      if (fallback && repo.config.executors[fallback.executor]?.kind !== 'manual') {
        repo.update((current) => patchLane(current, key, {
          executor: fallback.executor, model: fallback.model, session: '',
          attempts: [...lane.attempts, { executor: `${lane.executor}${lane.model ? `/${lane.model}` : ''}`, outcome: 'capacity' }],
        }))
        repo.event('fallback', { lane: key, from: lane.executor, to: fallback.executor })
        continue
      }
    }
    if ((after.lanes[key]?.pending.length ?? 0) > 0) continue
    break
  }
  let owned = false
  repo.update((state) => {
    owned = state.lanes[key]?.pid === process.pid
    return owned ? patchLane(state, key, { status: 'exited', pid: 0, childPid: 0 }) : state
  })
  if (owned) settle(repo, key)
}

/**
 * After the executor is done: a worker whose task is still running did not report. If its report file
 * exists, rw tries the report for it; otherwise the task fails with the log tail as its note. A reviewer
 * that ends without a verdict is left for the loop, which relaunches it once and then asks the owner.
 */
export function settle(repo: Repo, key: string): void {
  const state = repo.state()
  const lane = state.lanes[key]
  if (!lane || lane.role !== 'worker') return
  if (state.tasks[lane.task]?.state !== 'running' || lane.pending.length) return
  try {
    report(repo, lane.task)
    repo.event('auto-report', { task: lane.task })
    return
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    const tail = lastLines(readText(lane.log) ?? '', 6, 600)
    const note = `executor exited (code ${lane.exitCode ?? '?'}) without a usable report: ${why.replace(/\n- /g, '; ').replace(/\n/g, ' ')}${tail ? ` · log: ${tail.replace(/\s+/g, ' ')}` : ''}`
    repo.update((current) => current.tasks[lane.task]?.state === 'running' ? transition(current, lane.task, 'laneLost', repo.now(), { note: note.slice(0, 600) }, 'lane ended without a report') : current)
    repo.event('lane-lost', { task: lane.task })
  }
}
