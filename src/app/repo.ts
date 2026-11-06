/** The repository rw works on: its paths, its contracts on disk, and the one locked state file. */
import { chmodSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyState, formatTaskId, taskNumber, UserError, type State, type TaskContract } from '../core/model.ts'
import { packet } from '../core/plan.ts'
import { board } from '../core/status.ts'
import { parseTask, validateSet } from '../core/task.ts'
import { appendLine, ensureDir, exists, readJson, readText, withLock, writeAtomic, writeJson } from '../infra/fs.ts'
import { laneActive } from '../infra/proc.ts'
import { mainRoot } from '../infra/git.ts'
import { loadConfig, type Config } from './config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The router-worker package: prompts/, skills/, templates/ live here (src/app/ when run from source, lib/src/app/ when built). */
export const PACKAGE_ROOT = ((): string => {
  for (let dir = HERE, i = 0; i < 6; i++, dir = dirname(dir)) {
    if (exists(join(dir, 'prompts', 'worker.md')) && exists(join(dir, 'package.json'))) return dir
  }
  return resolve(HERE, '..', '..')
})()
/** The CLI entry this process runs from (src/cli.ts, or lib/cli.js when built). */
export const CLI_ENTRY = join(HERE, '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js')

export interface Paths {
  readonly rw: string
  readonly state: string
  readonly stateFile: string
  readonly lock: string
  readonly events: string
  readonly lanes: string
  readonly board: string
  readonly bin: string
  readonly teamPrompts: string
  readonly tasks: string
  readonly reports: string
}

export interface Contracts {
  readonly contracts: TaskContract[]
  readonly invalid: { task: string; problem: string }[]
}

export class Repo {
  readonly paths: Paths
  readonly root: string
  readonly config: Config
  readonly now: () => string
  private constructor(root: string, config: Config, now: () => string) {
    this.root = root
    this.config = config
    this.now = now
    const rw = join(root, '.rw')
    const state = join(rw, 'state')
    this.paths = {
      rw, state,
      stateFile: join(state, 'state.json'),
      lock: join(state, 'lock'),
      events: join(state, 'events.jsonl'),
      lanes: join(state, 'lanes'),
      board: join(state, 'STATUS.md'),
      bin: join(state, 'bin'),
      teamPrompts: join(rw, 'prompts'),
      tasks: join(root, config.tasksDir),
      reports: join(root, config.reportsDir),
    }
  }

  /** Open the repository `cwd` belongs to; from a lane worktree this is the main worktree. */
  static open(cwd = process.cwd(), now: () => string = () => new Date().toISOString()): Repo {
    let root: string
    try {
      root = mainRoot(cwd)
    } catch {
      throw new UserError(`${cwd} is not inside a git repository`)
    }
    if (!exists(join(root, '.rw', 'config.json'))) throw new UserError(`${root} has no .rw/config.json: run rw init there first`)
    return new Repo(root, loadConfig(root), now)
  }

  get name(): string {
    return this.root.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'repo'
  }

  /** Repository-relative, forward-slash paths: what task files and git use. */
  taskRel(id: string): string {
    return `${this.config.tasksDir.replace(/\/$/, '')}/${id}.md`
  }
  reportRel(id: string): string {
    return `${this.config.reportsDir.replace(/\/$/, '')}/${id}.md`
  }
  taskPath(id: string): string {
    return join(this.paths.tasks, `${id}.md`)
  }

  readContracts(): Contracts {
    const contracts: TaskContract[] = []
    const invalid: { task: string; problem: string }[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.paths.tasks)
    } catch {
      names = []
    }
    for (const name of names.filter((item) => /^TASK-\d{3,}\.md$/.test(item)).sort()) {
      const id = name.slice(0, -3)
      const { task, problems } = parseTask(readText(join(this.paths.tasks, name)) ?? '', id)
      if (task) contracts.push(task)
      else invalid.push({ task: id, problem: problems.join('; ') })
    }
    for (const issue of validateSet(contracts)) invalid.push(issue)
    return { contracts, invalid }
  }

  contract(id: string): TaskContract {
    const text = readText(this.taskPath(id))
    if (text === undefined) throw new UserError(`no task file ${this.taskRel(id)}`)
    const { task, problems } = parseTask(text, id)
    if (!task) throw new UserError(`${this.taskRel(id)}: ${problems.join('; ')}`)
    return task
  }

  state(): State {
    const state = readJson<State>(this.paths.stateFile, emptyState())
    if (state.version !== 1) throw new UserError(`${this.paths.stateFile} has version ${String(state.version)}; this rw reads version 1`)
    return state
  }

  /** The only way state changes: read, apply, write, under the lock; then the board is redrawn. */
  update(fn: (state: State) => State): State {
    const next = withLock(this.paths.lock, () => {
      const result = fn(this.state())
      writeJson(this.paths.stateFile, result)
      return result
    })
    this.renderBoard(next)
    return next
  }

  event(type: string, data: Record<string, unknown>): void {
    appendLine(this.paths.events, { at: this.now(), type, ...data })
  }

  nextId(): string {
    const fromFiles = this.readContracts().contracts.map((task) => taskNumber(task.id))
    let names: string[] = []
    try {
      names = readdirSync(this.paths.tasks)
    } catch {
      names = []
    }
    const fromNames = names.filter((name) => /^TASK-\d{3,}\.md$/.test(name)).map((name) => taskNumber(name.slice(0, -3)))
    const fromState = Object.keys(this.state().tasks).map(taskNumber)
    return formatTaskId(Math.max(0, ...fromFiles, ...fromNames, ...fromState) + 1)
  }

  /** Reviewer lanes are read-only but still cost capacity, so they take lane slots too. */
  freeLanes(state: State): number {
    const reviewers = Object.entries(state.lanes).filter(([key, lane]) => key.endsWith('.review') && lane.status !== 'manual' && laneActive(lane)).length
    return Math.max(0, this.config.limits.lanes - reviewers)
  }

  renderBoard(state = this.state(), problems: readonly string[] = []): string {
    const { contracts, invalid } = this.readContracts()
    const text = board({
      repo: this.name,
      now: this.now(),
      contracts,
      state,
      packet: packet(contracts, state, this.freeLanes(state)),
      problems: [...invalid.map((item) => `${item.task}: ${item.problem}`), ...problems],
    })
    writeAtomic(this.paths.board, text)
    return text
  }

  /** `rw` on the PATH of every lane, so prompts can say `rw report` on any platform. */
  ensureShims(): string {
    ensureDir(this.paths.bin)
    const node = process.execPath
    const flags = process.execArgv.filter((flag) => !flag.startsWith('--inspect'))
    const quoted = [node, ...flags, CLI_ENTRY].map((part) => `"${part}"`).join(' ')
    writeAtomic(join(this.paths.bin, 'rw'), `#!/bin/sh\nexec ${quoted} "$@"\n`)
    writeAtomic(join(this.paths.bin, 'rw.cmd'), `@echo off\r\n${quoted} %*\r\n`)
    if (process.platform !== 'win32') chmodSync(join(this.paths.bin, 'rw'), 0o755)
    return this.paths.bin
  }

  /** The command to run rw explicitly, for prompts read by a person or an IDE agent without the shim. */
  rwCommand(): string {
    const flags = process.execArgv.filter((flag) => !flag.startsWith('--inspect'))
    return [process.execPath, ...flags, CLI_ENTRY].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
  }

  teamPrompt(name: string): string | undefined {
    return readText(join(this.paths.teamPrompts, `${name}.md`))
  }
}

export function packageFile(...parts: string[]): string {
  const path = join(PACKAGE_ROOT, ...parts)
  const text = readText(path)
  if (text === undefined) throw new Error(`router-worker is missing its packaged file ${path}`)
  return text.replaceAll('\r\n', '\n')
}
