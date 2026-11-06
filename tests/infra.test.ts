import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withLock } from '../src/infra/fs.ts'
import { mainRootFromFiles } from '../src/infra/git.ts'

test('a lock left by a dead process is taken over at once, not after the stale timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-lock-'))
  try {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    const lock = join(dir, 'lock')
    writeFileSync(lock, `${dead.stdout}\n`)
    const started = Date.now()
    assert.equal(withLock(lock, () => 'ran', { timeoutMs: 2_000, staleMs: 60_000 }), 'ran')
    assert.ok(Date.now() - started < 1_000, 'took the dead owner\'s lock without waiting')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock held by a live process is waited for, then fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-lock-'))
  try {
    const lock = join(dir, 'lock')
    writeFileSync(lock, `${process.ppid}\n`)
    assert.throws(() => withLock(lock, () => 'ran', { timeoutMs: 200, staleMs: 60_000 }), /could not take the rw lock/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the repository root is found from files alone, from the main checkout and from a lane worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-root-'))
  try {
    const repo = join(dir, 'repo')
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
    git(dir, 'init', '-q', '-b', 'main', repo)
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    git(repo, 'worktree', 'add', '-q', '-b', 'lane', join(dir, 'lane'))
    const real = (path: string) => realpathSync(path)
    assert.equal(real(mainRootFromFiles(join(repo))), real(repo))
    mkdirSync(join(dir, 'lane', 'deep', 'er'), { recursive: true })
    assert.equal(real(mainRootFromFiles(join(dir, 'lane', 'deep', 'er'))), real(repo), 'a lane worktree resolves to its main checkout')
    assert.throws(() => mainRootFromFiles(tmpdir() === '/' ? '/' : join(dir)), /not inside a git repository/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
