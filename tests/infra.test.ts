import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withLock } from '../src/infra/fs.ts'

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
