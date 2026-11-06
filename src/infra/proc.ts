/** Processes: run a command, resolve it on Windows, start a detached child, check a pid. */
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

const WINDOWS = process.platform === 'win32'

export interface Run {
  readonly ok: boolean
  readonly code: number
  /** stdout and stderr together, for people. */
  readonly out: string
  /** stdout alone, for parsing. */
  readonly stdout: string
}

/**
 * Find an executable on PATH. On Windows, `claude` is `claude.cmd`, and Node refuses to spawn a .cmd
 * without a shell, so the caller needs to know which one it got.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): { file: string; shell: boolean } {
  if (!WINDOWS) return { file: command, shell: false }
  const exts = extname(command) ? [''] : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.toLowerCase())
  const dirs = isAbsolute(command) || command.includes('\\') || command.includes('/') ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter)
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? join(dir, command + ext) : command + ext
      if (existsSync(file)) return { file, shell: /\.(cmd|bat)$/i.test(file) }
    }
  }
  return { file: command, shell: false }
}

/** Quote one argument for cmd.exe, used only when a .cmd shim must run through the shell. */
export function quoteForCmd(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^%!()]/.test(arg)) return arg
  return `"${arg.replaceAll('"', '""')}"`
}

export function prepare(argv: readonly string[], env?: NodeJS.ProcessEnv): { file: string; args: string[]; shell: boolean } {
  const [command, ...args] = argv
  if (!command) throw new Error('empty command')
  const resolved = resolveCommand(command, env)
  if (resolved.shell) return { file: quoteForCmd(resolved.file), args: args.map(quoteForCmd), shell: true }
  return { file: resolved.file, args, shell: false }
}

/** Run a shell command line (acceptance commands and gates are written for a shell). */
export function runShell(command: string, cwd: string, timeoutMs = 30 * 60_000, env: NodeJS.ProcessEnv = process.env): Run {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`
  return { ok: result.status === 0 && !result.error, code: result.status ?? -1, out, stdout: result.stdout ?? '' }
}

export function runArgv(argv: readonly string[], cwd: string, input?: string, env: NodeJS.ProcessEnv = process.env): Run {
  const { file, args, shell } = prepare(argv, env)
  const result = spawnSync(file, args, { cwd, shell, encoding: 'utf8', input, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`
  return { ok: result.status === 0 && !result.error, code: result.status ?? -1, out, stdout: result.stdout ?? '' }
}

/** Start a process that outlives this one; its stdio goes nowhere. Returns its pid. */
export function startDetached(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const options: SpawnOptions = { cwd, env, detached: true, stdio: 'ignore', windowsHide: true }
  const child = spawn(argv[0] as string, argv.slice(1), options)
  child.unref()
  return child.pid ?? -1
}

/** End a process and everything it started. On POSIX the executor leads its own process group. */
export function killTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return false
  if (WINDOWS) return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).status === 0
  try {
    process.kill(-pid, 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch {
      return false
    }
  }
}

/** Wait up to `ms` for a process to be gone; returns whether it is. */
export function waitGone(pid: number, ms: number): boolean {
  const deadline = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return true
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function lastLines(text: string, count = 20, maxChars = 4000): string {
  const tail = text.trimEnd().split(/\r?\n/).slice(-count).join('\n')
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail
}

/**
 * Whether a lane is still at work: a manual lane waits for its person; a lane run by a process is active
 * while the process lives; a lane run inside a host (the DSH plugin, pid 0) is active until the host
 * marks it exited.
 */
export function laneActive(lane: { readonly status: string; readonly pid: number }): boolean {
  if (lane.status === 'manual') return true
  if (lane.status === 'exited') return false
  return lane.pid > 0 ? alive(lane.pid) : true
}
