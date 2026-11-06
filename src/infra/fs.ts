/** Small, synchronous file primitives: atomic writes, a lock file, JSON lines. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
export function writeAtomic(path: string, text: string): void {
  ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

export function readJson<T>(path: string, fallback: T): T {
  const text = readText(path)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function appendLine(path: string, value: unknown): void {
  ensureDir(dirname(path))
  appendFileSync(path, `${JSON.stringify(value)}\n`)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `fn` holding an exclusive lock file. A lock older than `staleMs` belongs to a dead process and is
 * taken over; rw holds it only for the few milliseconds a state update takes.
 */
export function withLock<T>(path: string, fn: () => T, { timeoutMs = 15_000, staleMs = 30_000 } = {}): T {
  ensureDir(dirname(path))
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        // A lock whose owner died (killed mid-update) is taken over at once; an unreadable one after staleMs.
        const owner = Number((readText(path) ?? '').trim())
        const dead = Number.isInteger(owner) && owner > 0 && owner !== process.pid && !processAlive(owner)
        if (dead || Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true })
      } catch {
        // the holder released it meanwhile
      }
      if (Date.now() - started > timeoutMs) throw new Error(`could not take the rw lock ${path} within ${timeoutMs} ms`)
      sleep(25)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(path, { force: true })
  }
}

export function exists(path: string): boolean {
  return existsSync(path)
}

export function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
