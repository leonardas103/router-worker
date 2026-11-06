/**
 * End to end: a real git repository, `rw init`, detached lane supervisors and a scripted executor.
 * Exercises dispatch → report → merge, the scope check, block → answer → resume in the same session,
 * a capacity fallback, a red merge gate returned to the same lane, and an executor that never reports.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts')
const FAKE = resolve(import.meta.dirname, 'fixtures', 'fake-worker.mjs')
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures', 'fake-claude.mjs')

let dir = ''
let repo = ''

function sh(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stdout}${result.stderr}`)
  return result.stdout
}

function rw(...args: string[]): { code: number; out: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, RW_TASK: '' } })
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
}

function state(): { tasks: Record<string, { state: string; question?: string; note?: string; remediation: number }>; lanes: Record<string, { executor: string; session: string; attempts: unknown[] }> } {
  return JSON.parse(readFileSync(join(repo, '.rw', 'state', 'state.json'), 'utf8'))
}

async function until(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(state().tasks)}\n${rw('status').out}`)
    rw('loop', '--once')
    await new Promise((r) => setTimeout(r, 150))
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'rw-e2e-'))
  repo = join(dir, 'game')
  sh(dir, 'git', ['init', '-q', '-b', 'main', repo])
  sh(repo, 'git', ['config', 'user.email', 'rw@test'])
  sh(repo, 'git', ['config', 'user.name', 'rw test'])
  writeFileSync(join(repo, 'check.mjs'), "import fs from 'node:fs'\nfor (const f of fs.readdirSync('src', { withFileTypes: true })) if (f.isFile() && fs.readFileSync('src/' + f.name, 'utf8').includes('RED')) process.exit(1)\n")
  writeFileSync(join(repo, 'README.md'), '# game\n')
  // what a real repository keeps out of git, and the setup a fresh worktree needs
  writeFileSync(join(repo, '.gitignore'), '.env.local\nprepared.txt\n')
  writeFileSync(join(repo, '.env.local'), 'SECRET=1\n')
  writeFileSync(join(repo, 'prep.mjs'), "import fs from 'node:fs'\nconst t = fs.readFileSync(`work/tasks/${process.env.RW_TASK}.md`, 'utf8')\nif (t.includes('badprep')) { console.log('install failed: registry unreachable'); process.exit(1) }\nif (t.includes('needsmarker') && !fs.existsSync('src/marker.txt')) { console.log('missing src/marker.txt'); process.exit(1) }\nfs.writeFileSync('prepared.txt', 'ok')\n")
  mkdirSync(join(repo, 'src'), { recursive: true })
  // an acceptance command that writes, like a formatter or codegen
  writeFileSync(join(repo, 'gen.mjs'), "import fs from 'node:fs'\nfs.writeFileSync('src/generated.txt', String(Date.now()))\n")
  writeFileSync(join(repo, 'src', '.keep'), '')
  writeFileSync(join(repo, 'src', 'shared.txt'), 'committed\n')
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'init'])
  const init = rw('init', '--host', 'claude,antigravity')
  assert.equal(init.code, 0, init.out)
  // a `claude` on disk that is the fake: the claude adapter's real flags and stream-json, scripted work
  const shim = join(dir, 'fake-claude')
  if (process.platform === 'win32') writeFileSync(`${shim}.cmd`, `@node "${FAKE_CLAUDE}" %*\r\n`)
  else {
    writeFileSync(shim, `#!/bin/sh\nexec node "${FAKE_CLAUDE}" "$@"\n`)
    chmodSync(shim, 0o755)
  }
  const config = {
    base: 'main',
    worktreeRoot: join(dir, 'worktrees'),
    limits: { lanes: 3 },
    gates: { merge: ['node check.mjs'] },
    worktree: { copy: ['.env.local'], prepare: ['node prep.mjs'] },
    policy: { mode: 'observe', rules: [{ id: 'gap-followup', text: 'follow-ups for named gaps', enabled: true }] },
    tiers: { build: ['fake', 'second'], review: ['fake'] },
    executors: {
      claudeish: { kind: 'claude', command: shim, models: { default: 'haiku' } },
      fake: { kind: 'command', models: { default: 'fake-default', cheap: 'fake-cheap' }, start: ['node', FAKE, 'start'], resume: ['node', FAKE, 'resume', '{session}'], stdin: true, sessionPattern: '"conversationId":"([0-9a-f-]{36})"' },
      second: { kind: 'command', start: ['node', '--input-type=module', '-e', `process.env.FAKE_EXECUTOR='second'; await import(${JSON.stringify(pathToFileURL(FAKE).href)})`, 'start'], stdin: true },
    },
  }
  writeFileSync(join(repo, '.rw', 'config.json'), JSON.stringify(config, null, 2))
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-q', '-m', 'rw init'])
})

after(() => {
  if (dir && !process.env.RW_KEEP) rmSync(dir, { recursive: true, force: true })
})

describe('router-worker end to end', () => {
  test('init installed the kit for each host', () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.claude/skills/rw-worker/SKILL.md', '.agent/workflows/rw-router.md', '.agent/rules/router-worker.md', 'work/tasks/README.md']) {
      assert.ok(readFileSync(join(repo, file), 'utf8').length > 0, file)
    }
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /<!-- rw:begin -->/)
  })

  test('a task goes from add to merged, and the board says so', async () => {
    const added = rw('add', 'ok greeting', '--scope', 'src/TASK-001.txt', '--accept', 'node check.mjs', '--goal', 'Say hello.')
    assert.equal(added.code, 0, added.out)
    await until(() => state().tasks['TASK-001']?.state === 'done', 'TASK-001 done')
    assert.match(sh(repo, 'git', ['show', 'main:src/TASK-001.txt']), /ok greeting/)
    assert.match(sh(repo, 'git', ['show', 'main:work/reports/TASK-001.md']), /state: ready/)
    assert.match(rw('status').out, /Done 1/)
    assert.equal(rw('watchdog', '--skip-checks').out.trim(), 'WATCHDOG OK')
    // the merge removed its lane, and kept the gate's output
    assert.doesNotMatch(sh(repo, 'git', ['branch', '--list', 'rw/*']), /TASK-001/)
    assert.ok(!existsSync(join(dir, 'worktrees', 'TASK-001-ok-greeting')), 'worktree removed')
    const gateLog = readFileSync(join(repo, '.rw', 'state', 'lanes', 'TASK-001.merge.log'), 'utf8')
    assert.match(gateLog, /## `node check.mjs` → exit 0 in/)
  })

  test('a file outside the scope is refused and the task fails with the reason', async () => {
    rw('add', 'stray write', '--scope', 'src/TASK-002.txt', '--accept', 'node check.mjs')
    await until(() => state().tasks['TASK-002']?.state === 'failed', 'TASK-002 failed')
    assert.match(state().tasks['TASK-002']?.note ?? '', /outside the task's scope: outside.txt/)
    assert.equal(rw('loop', '--once').code, 0)
    const halted = rw('loop')
    assert.equal(halted.code, 3, halted.out)
    rw('stop', 'TASK-002', 'test')
  })

  test('a question waits for the owner, and the answer resumes the same session', async () => {
    rw('add', 'ask greeting', '--scope', 'src/TASK-003.txt', '--accept', 'node check.mjs')
    await until(() => state().tasks['TASK-003']?.state === 'blocked', 'TASK-003 blocked')
    assert.equal(state().tasks['TASK-003']?.question, 'Should the greeting say hello or hi?')
    assert.match(rw('status').out, /Needs you[\s\S]*Should the greeting say hello or hi\?/)
    const session = state().lanes['TASK-003']?.session
    assert.ok(session, 'the lane recorded its session')
    assert.equal(rw('answer', 'TASK-003', 'hi').code, 0)
    await until(() => state().tasks['TASK-003']?.state === 'done', 'TASK-003 done')
    assert.match(sh(repo, 'git', ['show', 'main:src/TASK-003.txt']), /\nhi\n/)
  })

  test('a capacity failure falls back to the next executor of the tier', async () => {
    rw('add', 'quota hit', '--scope', 'src/TASK-004.txt', '--accept', 'node check.mjs')
    await until(() => state().tasks['TASK-004']?.state === 'done', 'TASK-004 done')
    const events = readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8')
    assert.match(events, /"type":"fallback","lane":"TASK-004","from":"fake","to":"second"/)
  })

  test('a red merge gate goes back to the same lane, which fixes it', async () => {
    rw('add', 'redgate change', '--scope', 'src/TASK-005.txt', '--accept', 'node check.mjs')
    await until(() => state().tasks['TASK-005']?.state === 'done', 'TASK-005 done')
    assert.match(sh(repo, 'git', ['show', 'main:src/TASK-005.txt']), /GREEN/)
    const history = readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8')
    assert.match(history, /"type":"followup","task":"TASK-005","kind":"gate"/)
  })

  test('an executor that exits without reporting fails the task; retry continues the branch', async () => {
    rw('add', 'silent worker', '--scope', 'src/TASK-006.txt', '--accept', 'node check.mjs')
    await until(() => state().tasks['TASK-006']?.state === 'failed', 'TASK-006 failed')
    assert.match(state().tasks['TASK-006']?.note ?? '', /without a usable report/)
    assert.equal(rw('retry', 'TASK-006').code, 0)
    assert.equal(state().tasks['TASK-006']?.state, 'queued')
    rw('stop', 'TASK-006', 'test over')
  })

  test('a required review asks for changes once, the worker fixes them in its session, then it merges', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'picky review', '--scope', 'src/picky.txt', '--scope', 'src/TASK-*.txt', '--accept', 'node check.mjs', '--review').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    const events = readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8')
    assert.match(events, new RegExp(`"type":"verdict","task":"${id}","approve":false,"round":1`))
    assert.match(events, new RegExp(`"type":"verdict","task":"${id}","approve":true,"round":2`))
    assert.match(sh(repo, 'git', ['show', `main:src/${id}.txt`]), /please/)
  })

  test('a gate that writes files cannot land: the verified tree must be the merged tree', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'gatewrite change', '--scope', 'src/*.txt', '--accept', 'node gen.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'blocked', `${id} blocked after remediation`)
    assert.match(state().tasks[id]?.question ?? '', /gate commands changed files.*already went back to the worker 2 time\(s\)/)
    assert.equal((state().tasks[id] as unknown as { remediation: number }).remediation, 2, 'counts returns, never past the limit')
    const returns = readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8').split('\n').filter((line) => line.includes(`"task":"${id}","kind":"gate"`))
    assert.equal(returns.length, 2, 'two returns to the worker, then the owner')
    const events = readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8')
    assert.ok(!events.includes(`"type":"merge","task":"${id}"`), 'it never merged')
    assert.ok(!sh(repo, 'git', ['ls-tree', '-r', '--name-only', 'main']).includes('src/generated.txt'))
    rw('stop', id, 'test over')
  })

  test('hold ends the executor itself, not only its supervisor', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'slow worker', '--scope', 'src/TASK-0*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'running', `${id} running`)
    const pidFile = () => {
      const lane = (state().lanes[id] as unknown as { worktree: string }).worktree
      return join(lane, '..', `${id}.pid`)
    }
    await until(() => existsSync(pidFile()), `${id} executor started`)
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    const held = rw('hold', id, 'test')
    assert.equal(held.code, 0, held.out)
    const deadline = Date.now() + 10_000
    let gone = false
    while (Date.now() < deadline && !gone) {
      try { process.kill(pid, 0) } catch { gone = true }
      if (!gone) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(gone, `executor ${pid} still running after hold`)
    assert.equal(state().tasks[id]?.state, 'held')
    rw('stop', id, 'test over')
  })

  test('a committed symbolic link is refused', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, async () => {
    const id = /TASK-\d+/.exec(rw('add', 'symlink write', '--scope', 'src/**', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'failed', `${id} failed`)
    assert.match(state().tasks[id]?.note ?? '', /symbolic links are not merged/)
    rw('stop', id, 'test over')
  })

  test('a new worktree gets the ignored files and setup it needs before the worker starts', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'needsprep task', '--scope', 'src/TASK-0{0,1,2,3}*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    assert.match(readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8'), new RegExp(`"type":"prepare","lane":"${id}","copied":1,"commands":1`))
  })

  test('a failing setup fails the task with its output, before any agent runs', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'badprep task', '--scope', 'src/badprep.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'failed', `${id} failed`)
    assert.match(state().tasks[id]?.note ?? '', /worktree.prepare `node prep.mjs` failed \(exit 1\): install failed: registry unreachable/)
    rw('stop', id, 'test over')
  })

  test('a setup failure fixed on main is picked up by retry: a lane with no work restarts from the current base', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'needsmarker setup', '--scope', 'src/TASK-*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'failed', `${id} failed`)
    assert.match(state().tasks[id]?.note ?? '', /missing src\/marker.txt → fix it on main, then rw retry/)
    writeFileSync(join(repo, 'src', 'marker.txt'), 'fixed\n')
    sh(repo, 'git', ['add', 'src/marker.txt'])
    sh(repo, 'git', ['commit', '-q', '-m', 'fix the setup input'])
    assert.equal(rw('retry', id).code, 0)
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    assert.match(readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8'), new RegExp(`"type":"lane-fresh","task":"${id}"`))
  })

  test('rw reset refuses to discard work unless forced, then queues the task from the current base', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'stray reset', '--scope', 'src/reset.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'failed', `${id} failed`)
    const lane = state().lanes[id] as unknown as { worktree: string; branch: string }
    const refused = rw('reset', id)
    assert.equal(refused.code, 2)
    assert.match(refused.out, /has 1 commit\(s\) on rw\/.*--force discards them, rw retry .* continues on them/)
    const forced = rw('reset', id, '--force')
    assert.equal(forced.code, 0, forced.out)
    assert.equal(state().tasks[id]?.state, 'queued')
    assert.equal(state().lanes[id], undefined)
    assert.ok(!existsSync(lane.worktree), 'worktree removed')
    assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${lane.branch}`], { cwd: repo }).status, 1, 'branch deleted')
    rw('stop', id, 'test over')
  })

  test('a worktree that lost its .git link is still torn down by reset --force', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'silent wedge', '--scope', 'src/wedge.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'failed', `${id} failed`)
    const lane = state().lanes[id] as unknown as { worktree: string; branch: string }
    rmSync(join(lane.worktree, '.git'), { force: true })
    const refused = rw('reset', id)
    assert.equal(refused.code, 2)
    assert.match(refused.out, /no longer a git worktree/)
    const forced = rw('reset', id, '--force')
    assert.equal(forced.code, 0, forced.out)
    assert.doesNotMatch(forced.out, /left behind/)
    assert.ok(!existsSync(lane.worktree), 'folder removed')
    assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${lane.branch}`], { cwd: repo }).status, 1, 'branch deleted')
    rw('stop', id, 'test over')
  })

  test('--executor alone takes the model the executor has in the tier, not the tool\'s own default', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'ok model pick', '--scope', 'src/TASK-*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    const started = rw('dispatch', id, '--executor', 'fake')
    assert.equal(started.code, 0, started.out)
    assert.equal((state().lanes[id] as unknown as { model: string }).model, 'fake-default')
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    const cheap = /TASK-\d+/.exec(rw('add', 'ok model alias', '--scope', 'src/TASK-*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    assert.equal(rw('dispatch', cheap, '--executor', 'fake', '--model', 'cheap').code, 0)
    assert.equal((state().lanes[cheap] as unknown as { model: string }).model, 'fake-cheap')
    await until(() => state().tasks[cheap]?.state === 'done', `${cheap} done`)
  })

  test('verifyReport runs the acceptance commands at rw report and refuses a claimed PASS that fails', async () => {
    const config = join(repo, '.rw', 'config.json')
    const original = readFileSync(config, 'utf8')
    writeFileSync(config, JSON.stringify({ ...JSON.parse(original), verifyReport: true }, null, 2))
    sh(repo, 'git', ['commit', '-q', '-am', 'verifyReport on'])
    const id = /TASK-\d+/.exec(rw('add', 'redgate verify', '--scope', 'src/TASK-*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'failed', `${id} failed`)
    assert.match(state().tasks[id]?.note ?? '', /acceptance command failed when rw ran it: node check.mjs \(exit 1\)/)
    writeFileSync(config, original)
    sh(repo, 'git', ['commit', '-q', '-am', 'verifyReport off'])
    rw('stop', id, 'test over')
  })

  test('reset refuses a running task, and --force stops its executor and discards the lane', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'slow reset', '--scope', 'src/slowreset.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'running' && existsSync(join((state().lanes[id] as unknown as { worktree: string }).worktree, '..', `${id}.pid`)), `${id} executor running`)
    const lane = state().lanes[id] as unknown as { worktree: string; branch: string }
    const pid = Number(readFileSync(join(lane.worktree, '..', `${id}.pid`), 'utf8'))
    const refused = rw('reset', id)
    assert.equal(refused.code, 2)
    assert.match(refused.out, /is running; rw hold .* first, or rw reset .* --force stops its executor/)
    const forced = rw('reset', id, '--force')
    assert.equal(forced.code, 0, forced.out)
    assert.doesNotMatch(forced.out, /left behind/)
    let gone = false
    try { process.kill(pid, 0) } catch { gone = true }
    assert.ok(gone, 'executor stopped')
    assert.ok(!existsSync(lane.worktree), 'worktree removed')
    assert.equal(state().tasks[id]?.state, 'queued')
    rw('stop', id, 'test over')
  })

  test('where git cannot be started, the watchdog runs what it can and says it is partial (exit 4)', () => {
    // no PATH: git cannot be found, the same failure a sandbox that forbids starting processes produces
    const env: NodeJS.ProcessEnv = { ...process.env, RW_TASK: '' }
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') env[key] = ''
    const result = spawnSync(process.execPath, [CLI, 'watchdog', '--skip-checks'], { cwd: repo, encoding: 'utf8', env })
    assert.equal(result.status, 4, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /SKIPPED leftover branches and folders: git could not be started \(ENOENT\)/)
    assert.match(result.stdout, /WATCHDOG PARTIAL: no deviation in what ran; 1 check\(s\) skipped/)
  })

  test('rw watchdog --repos audits several repositories from anywhere and exits with the worst verdict', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'rw-elsewhere-'))
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'watchdog', '--skip-checks', ...args], { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, RW_TASK: '' } })
      const missing = join(elsewhere, 'not-a-repo')
      mkdirSync(missing)
      const both = run('--repos', `${repo},${missing}`)
      assert.equal(both.status, 1, both.stdout + both.stderr)
      assert.match(both.stdout, new RegExp(`WATCHDOG (OK|DEVIATIONS=\\d+)  ${repo.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`))
      assert.match(both.stdout, /ERROR .*not inside a git repository/)
      assert.match(both.stdout, /WATCHDOG ERROR  .*not-a-repo/)
      const list = join(elsewhere, 'repos.txt')
      writeFileSync(list, `# repositories rw watches\n${repo}\n\n${repo}   # listed twice, audited once\n`)
      const fromFile = run('--repos-file', list, '--json')
      const parsed = JSON.parse(fromFile.stdout) as { repos: { path: string; verdict: string }[] }
      assert.equal(parsed.repos.length, 1)
      assert.ok(['ok', 'deviations'].includes(parsed.repos[0]!.verdict))
      assert.equal(fromFile.status, parsed.repos[0]!.verdict === 'ok' ? 0 : 1)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('rw <command> --help shows that command', () => {
    const help = rw('add', '--help').out
    assert.match(help, /rw add "<title>"/)
    assert.doesNotMatch(help, /rw loop/)
  })

  test('rw status reminds the owner to commit the kit lanes are checked out with', () => {
    writeFileSync(join(repo, 'AGENTS.md'), `${readFileSync(join(repo, 'AGENTS.md'), 'utf8')}\nlocal note\n`)
    assert.match(rw('status').out, /## Problems[\s\S]*commit AGENTS.md on main: lane worktrees are checked out from main/)
    sh(repo, 'git', ['checkout', '--', 'AGENTS.md'])
    assert.doesNotMatch(rw('status').out, /## Problems/)
  })

  test('the owner\'s uncommitted edits do not block a merge that does not touch them', async () => {
    writeFileSync(join(repo, 'README.md'), '# game\n\nowner draft, not committed\n')
    const id = /TASK-\d+/.exec(rw('add', 'ok beside dirt', '--scope', 'src/TASK-0{0,1,2,3}*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), /owner draft/)
    assert.match(sh(repo, 'git', ['show', `main:src/${id}.txt`]), /ok beside dirt/)
    sh(repo, 'git', ['checkout', '--', 'README.md'])
  })

  test('an uncommitted edit to a file the merge changes waits, keeps the edit, and merges once it is gone', async () => {
    writeFileSync(join(repo, 'src', 'shared.txt'), 'owner edit\n')
    const id = /TASK-\d+/.exec(rw('add', 'shared change', '--scope', 'src/shared.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => /merge waits: your uncommitted changes/.test(state().tasks[id]?.note ?? ''), `${id} merge waiting`)
    assert.equal(state().tasks[id]?.state, 'review')
    assert.equal(readFileSync(join(repo, 'src', 'shared.txt'), 'utf8'), 'owner edit\n')
    assert.equal(sh(repo, 'git', ['show', 'main:src/shared.txt']), 'committed\n')
    assert.match(rw('status').out, /merge waits: your uncommitted changes/)
    sh(repo, 'git', ['checkout', '--', 'src/shared.txt'])
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    assert.match(sh(repo, 'git', ['show', 'main:src/shared.txt']), /shared change/)
  })

  test('the claude adapter records its session at launch, and the answer resumes that session', async () => {
    const calls = join(dir, 'fake-claude.log')
    process.env.FAKE_CLAUDE_LOG = calls
    const id = /TASK-\d+/.exec(rw('add', 'ask via claude', '--scope', 'src/TASK-*.txt', '--accept', 'node check.mjs').out)?.[0] as string
    const started = rw('dispatch', id, '--executor', 'claudeish')
    assert.equal(started.code, 0, started.out)
    await until(() => state().tasks[id]?.state === 'blocked', `${id} blocked`)
    const session = (state().lanes[id] as unknown as { session: string }).session
    assert.match(session, /^[0-9a-f-]{36}$/, 'the session is known while the worker is still finishing its turn')
    assert.equal(rw('answer', id, 'hi').code, 0)
    await until(() => state().tasks[id]?.state === 'done', `${id} done`)
    const runs = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { started?: string; resumed?: string; model: string })
    assert.equal(runs.length, 2)
    assert.equal(runs[0]?.started, session, 'started with --session-id <the recorded session>')
    assert.equal(runs[1]?.resumed, session, 'the answer ran --resume <the same session>')
    assert.ok(runs.every((run) => run.model === 'haiku'), 'the tier model, both times')
    delete process.env.FAKE_CLAUDE_LOG
  })

  test('workers cannot authorize work; the gate records proposals', () => {
    const inLane = spawnSync(process.execPath, [CLI, 'add', 'sneaky', '--scope', 'x', '--accept', 'true'], { cwd: repo, encoding: 'utf8', env: { ...process.env, RW_TASK: 'TASK-001' } })
    assert.equal(inLane.status, 2)
    assert.match(inLane.stderr, /owner's decision/)
    const unknown = rw('propose', 'idea', '--rule', 'nope', '--scope', 'src/x', '--accept', 'true')
    assert.equal(unknown.code, 2)
    assert.match(unknown.out, /no rule nope/)
    const proposed = rw('propose', 'gap idea', '--rule', 'gap-followup', '--scope', 'src/gap.txt', '--accept', 'node check.mjs')
    assert.match(proposed.out, /proposed: recorded for the owner \(observe mode/)
    const id = /TASK-\d+/.exec(proposed.out)?.[0] as string
    assert.match(rw('status').out, new RegExp(`${id}[^\\n]*approve or reject the proposal under rule:gap-followup`))
    assert.equal(rw('reject', id, 'not now').code, 0)
    assert.equal(state().tasks[id]?.state, 'dropped')
  })

  test('editing a dispatched contract is a watchdog deviation', async () => {
    const id = /TASK-\d+/.exec(rw('add', 'ask edit', '--scope', 'src/edit.txt', '--accept', 'node check.mjs').out)?.[0] as string
    await until(() => state().tasks[id]?.state === 'blocked', `${id} blocked`)
    const file = join(repo, 'work', 'tasks', `${id}.md`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('src/edit.txt', 'src/**'))
    const audit = rw('watchdog', '--skip-checks')
    assert.equal(audit.code, 1)
    assert.match(audit.out, new RegExp(`DEVIATION mandate: ${id} contract changed after dispatch`))
  })

  test('leftover branches and folders are a watchdog deviation, and rw clean removes them', () => {
    sh(repo, 'git', ['branch', 'rw/orphan', 'main'])
    // a folder rw created and a teardown could not remove (TASK-001's merged lane), and one it never made
    const merged = join(dir, 'worktrees', 'TASK-001-ok-greeting')
    mkdirSync(join(merged, 'node_modules', 'deep'), { recursive: true })
    writeFileSync(join(merged, 'node_modules', 'deep', 'x.js'), '')
    mkdirSync(join(dir, 'worktrees', 'another-repos-lane'), { recursive: true })
    const before = rw('watchdog', '--skip-checks')
    assert.match(before.out, /DEVIATION leftover: \d+ leftover lane branch\(es\)\/folder\(s\): .* → rw clean/)
    const kept = rw('clean')
    assert.equal(kept.code, 3, 'a dropped lane with work is kept without --force')
    assert.match(kept.out, /removed branch rw\/orphan/)
    assert.match(kept.out, /kept    TASK-\d+ lane .* holds work \(rw clean --force removes it\)/)
    rw('clean', '--force')
    const after = rw('watchdog', '--skip-checks').out
    assert.doesNotMatch(after, /DEVIATION leftover/)
    assert.ok(!existsSync(merged), 'the leftover rw created is removed')
    assert.ok(existsSync(join(dir, 'worktrees', 'another-repos-lane')), 'a folder rw did not create is never touched')
    assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/rw/orphan'], { cwd: repo }).status, 1)
  })
})
