import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { parse, stringify } from '../src/core/frontmatter.ts'
import { emptyState, type State, type TaskContract } from '../src/core/model.ts'
import { packet } from '../src/core/plan.ts'
import { gate, type Policy } from '../src/core/policy.ts'
import { fill } from '../src/core/prompt.ts'
import { checkReport, commandTable, parseReport } from '../src/core/report.ts'
import { braceExpand, matches, outside, patternProblem, patternsOverlap } from '../src/core/scope.ts'
import { register, transition } from '../src/core/state.ts'
import { mandateHash, parseTask, renderTask, validateSet } from '../src/core/task.ts'
import { audit, type Facts } from '../src/core/watchdog.ts'
import { chain, mergeConfig, parseConfig } from '../src/app/config.ts'

const NOW = '2026-11-06T12:00:00.000Z'

function task(id: string, extra: Partial<TaskContract> = {}): TaskContract {
  return {
    id, title: `title ${id}`, parent: '', depends: [], tier: 'build', review: 'none', basis: 'explicit',
    authority: 'owner', scope: [`src/${id}/**`], accept: ['npm test'], body: '## Goal\n\nDo it.', ...extra,
  }
}

describe('frontmatter', () => {
  test('parses scalars, inline and block lists, quotes and comments', () => {
    const doc = parse('---\nid: TASK-001\n# note\ntitle: "a: b, c"\nscope: [src/**, "x, y"]\naccept:\n  - npm test\n  - "node -e \\"1\\""\nempty: []\n---\n\nbody\n')
    assert.equal(doc.fields.id, 'TASK-001')
    assert.equal(doc.fields.title, 'a: b, c')
    assert.deepEqual(doc.fields.scope, ['src/**', 'x, y'])
    assert.deepEqual(doc.fields.accept, ['npm test', 'node -e "1"'])
    assert.deepEqual(doc.fields.empty, [])
    assert.equal(doc.body, 'body\n')
  })
  test('fails loudly with a line number', () => {
    assert.throws(() => parse('---\nid TASK-1\n---\n'), /line 2/)
    assert.throws(() => parse('---\nid: a\nid: b\n---\n'), /duplicate key id/)
    assert.throws(() => parse('---\nid: a\n'), /not closed/)
    assert.throws(() => parse('no frontmatter'), /must start with ---/)
    assert.throws(() => parse('---\n  - orphan\n---\n'), /list item without a key/)
  })
  test('round-trips through stringify', () => {
    const fields = { id: 'TASK-002', title: 'has: colon', list: ['a', 'b, c', 'd]'] }
    const doc = parse(stringify(fields, 'text'))
    assert.deepEqual(doc.fields, fields)
    assert.equal(doc.body.trim(), 'text')
  })
})

describe('scope', () => {
  test('globs, directories and plain paths', () => {
    assert.ok(matches('src/app/**', 'src/app/a/b.ts'))
    assert.ok(matches('src/app/', 'src/app/x.ts'))
    assert.ok(matches('src/app', 'src/app/x.ts'))
    assert.ok(matches('src/app', 'src/app'))
    assert.ok(!matches('src/app', 'src/apple.ts'))
    assert.ok(matches('src/*.ts', 'src/a.ts'))
    assert.ok(!matches('src/*.ts', 'src/a/b.ts'))
    assert.ok(matches('docs/**/*.md', 'docs/a.md'))
    assert.ok(matches('docs/**/*.md', 'docs/x/y/a.md'))
    assert.ok(matches('src\\win\\**', 'src/win/a.ts'))
  })
  test('a path that could escape never matches, and matching is exact about case, spaces and unicode', () => {
    assert.ok(!matches('src/**', 'src/../secret.txt'))
    assert.ok(!matches('src/**', 'src/./a.ts'))
    assert.ok(!matches('**', '/etc/passwd'))
    assert.ok(!matches('**', 'C:/Windows/x'))
    assert.ok(!matches('src/**', 'Src/a.ts'), 'case differs: refused, never widened')
    assert.ok(matches('src/my dir/**', 'src/my dir/a b.ts'))
    assert.ok(matches('src/café/*.txt', 'src/café/menu.txt'))
    assert.ok(!matches('src/*', 'src/a/b'))
    assert.deepEqual(outside(['src/**'], ['src/../README.md']), ['src/../README.md'])
  })
  test('brace alternatives expand, nest, and are validated', () => {
    assert.deepEqual(braceExpand('src/{a,b/{c,d}}.ts'), ['src/a.ts', 'src/b/c.ts', 'src/b/d.ts'])
    assert.ok(matches('packages/sim/src/{commands,index}.ts', 'packages/sim/src/index.ts'))
    assert.ok(!matches('packages/sim/src/{commands,index}.ts', 'packages/sim/src/state.ts'))
    assert.ok(matches('{src,test}/**', 'test/a/b.ts'))
    assert.ok(!patternsOverlap('src/{a,b}.ts', 'src/c.ts'))
    assert.ok(patternsOverlap('src/{a,b}.ts', 'src/b.ts'))
    assert.match(patternProblem('src/{a,b.ts') ?? '', /unbalanced \{/)
    assert.match(patternProblem('{a,b,c,d,e,f,g,h}/{a,b,c,d,e,f,g,h}/{a,b}') ?? '', /more than 64/)
    assert.equal(patternProblem('src/{a,b}.ts'), undefined)
    assert.deepEqual(parse('---\nscope: [src/{a,b}.ts, test/**]\n---\n').fields.scope, ['src/{a,b}.ts', 'test/**'])
    const { problems } = parseTask(renderTask(task('TASK-001', { scope: ['src/{a,b.ts'] })), 'TASK-001')
    assert.match(problems.join(), /unbalanced/)
  })
  test('outside lists stray files and honours always-allowed paths', () => {
    assert.deepEqual(outside(['src/**'], ['src/a.ts', 'README.md', 'work/reports/TASK-001.md'], ['work/reports/TASK-001.md']), ['README.md'])
  })
  test('overlap is conservative but separates distinct trees', () => {
    assert.ok(patternsOverlap('src/**', 'src/app/x.ts'))
    assert.ok(patternsOverlap('src/app/', 'src/app/**'))
    assert.ok(!patternsOverlap('src/a/**', 'src/b/**'))
    assert.ok(!patternsOverlap('docs/x.md', 'docs/y.md'))
    assert.ok(patternsOverlap('**/*.md', 'docs/y.md'))
  })
})

describe('task files', () => {
  test('render and parse agree; the mandate hash ignores whitespace in the body', () => {
    const t = task('TASK-003', { depends: ['TASK-001'], parent: 'STORY M01' })
    const parsed = parseTask(renderTask(t), 'TASK-003')
    assert.deepEqual(parsed.problems, [])
    assert.deepEqual(parsed.task, { ...t, body: `${t.body}\n` })
    assert.equal(mandateHash(t), mandateHash({ ...t, body: `${t.body}\n\n` }))
    assert.notEqual(mandateHash(t), mandateHash({ ...t, scope: ['src/**'] }))
  })
  test('lists every contract problem at once', () => {
    const { problems } = parseTask('---\nid: TASK-9\nstate: running\nbasis: maybe\nscope: [/abs, ../up]\n---\n', 'TASK-009')
    const text = problems.join('\n')
    for (const expected of ['id must look like', 'does not match', 'state is not a task field', 'basis must be', 'missing authority', 'missing accept', 'relative', 'missing title', 'missing body']) {
      assert.match(text, new RegExp(expected))
    }
  })
  test('finds unknown dependencies and cycles', () => {
    const issues = validateSet([task('TASK-001', { depends: ['TASK-002'] }), task('TASK-002', { depends: ['TASK-001'] }), task('TASK-003', { depends: ['TASK-404'] })])
    assert.ok(issues.some((issue) => issue.problem.includes('cycle')))
    assert.ok(issues.some((issue) => issue.problem.includes('unknown TASK-404')))
  })
})

describe('reports', () => {
  const report = (state: string, extra = '', body = '## Commands\n\n| Command | Result |\n| --- | --- |\n| `npm test` | PASS 12 tests |\n') =>
    parseReport(`---\ntask: TASK-001\nstate: ${state}\n${extra}---\n${body}`).report!
  test('reads the commands table', () => {
    assert.deepEqual(commandTable('## Commands\n\n| Command | Result |\n| --- | --- |\n| `a  b` | PASS |\n## Next\n| x | y |'), [{ command: 'a b', result: 'PASS' }])
  })
  test('ready needs every acceptance command passing', () => {
    assert.deepEqual(checkReport(report('ready'), task('TASK-001')), [])
    assert.match(checkReport(report('ready'), task('TASK-001', { accept: ['npm test', 'npm run lint'] })).join(), /not reported: npm run lint/)
    assert.match(checkReport(report('ready', '', '## Commands\n| c | r |\n|--|--|\n| npm test | FAIL |\n'), task('TASK-001')).join(), /did not pass/)
  })
  test('blocked needs one short question', () => {
    assert.match(checkReport(report('blocked'), task('TASK-001')).join(), /needs question/)
    assert.deepEqual(checkReport(report('blocked', 'question: Which colour?\n'), task('TASK-001')), [])
    assert.match(checkReport(report('blocked', `question: ${'word '.repeat(90)}\n`), task('TASK-001')).join(), /at most 80/)
  })
})

describe('plan', () => {
  const state = (entries: Record<string, State['tasks'][string]['state']>): State => {
    let s = emptyState()
    for (const [id, to] of Object.entries(entries)) {
      s = register(s, id, 'queued', NOW, 'test')
      if (to !== 'queued') s = { ...s, tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, state: to } } }
    }
    return s
  }
  test('dependencies, scope overlap and the lane limit decide readiness', () => {
    const tasks = [
      task('TASK-001'),
      task('TASK-002', { depends: ['TASK-001'] }),
      task('TASK-003', { scope: ['src/TASK-001/x.ts'] }),
      task('TASK-004'),
      task('TASK-005'),
    ]
    const p = packet(tasks, state({ 'TASK-001': 'running', 'TASK-002': 'queued', 'TASK-003': 'queued', 'TASK-004': 'queued', 'TASK-005': 'queued' }), 2)
    assert.deepEqual(p.ready, ['TASK-004'])
    assert.deepEqual(p.running, ['TASK-001'])
    const reasons = Object.fromEntries(p.waiting.map((item) => [item.task, item.reason]))
    assert.match(reasons['TASK-002']!, /waits for TASK-001/)
    assert.match(reasons['TASK-003']!, /overlaps TASK-001/)
    assert.match(reasons['TASK-005']!, /lane\(s\) busy/)
    assert.equal(p.halt, false)
  })
  test('halts with the reason the owner needs', () => {
    assert.equal(packet([], emptyState(), 2).haltReason, 'queue empty')
    const blocked = packet([task('TASK-001')], { ...state({ 'TASK-001': 'blocked' }) }, 2)
    assert.equal(blocked.halt, true)
    assert.match(blocked.haltReason, /waiting on the owner/)
    const dead = packet([task('TASK-001'), task('TASK-002', { depends: ['TASK-001'] })], state({ 'TASK-001': 'dropped', 'TASK-002': 'queued' }), 2)
    assert.match(dead.haltReason, /depends on dropped TASK-001/)
    const unregistered = packet([task('TASK-001')], emptyState(), 2)
    assert.equal(unregistered.attention[0]?.state, 'proposed')
  })
})

describe('policy', () => {
  const policy = (mode: Policy['mode']): Policy => ({ mode, rules: [{ id: 'gap', text: 'gaps', enabled: true, tiers: ['light'], maxScope: 2 }] })
  test('the accept mode decides proposals; explicit work always waits for the owner', () => {
    const t = task('TASK-001', { basis: 'rule:gap', tier: 'light' })
    assert.equal(gate(t, policy('off')).outcome, 'refuse')
    assert.equal(gate(t, policy('observe')).outcome, 'propose')
    assert.equal(gate(t, policy('auto')).outcome, 'accept')
    assert.equal(gate({ ...t, tier: 'build' }, policy('auto')).outcome, 'propose')
    assert.equal(gate({ ...t, scope: ['a', 'b', 'c'] }, policy('auto')).outcome, 'propose')
    assert.equal(gate({ ...t, basis: 'rule:none' }, policy('auto')).outcome, 'refuse')
    assert.equal(gate(task('TASK-002'), policy('auto')).outcome, 'propose')
  })
})

describe('state transitions', () => {
  test('refuses moves the table does not allow, and keeps history', () => {
    let s = register(emptyState(), 'TASK-001', 'queued', NOW, 'owner')
    assert.throws(() => transition(s, 'TASK-001', 'merged', NOW), /TASK-001 is queued; merged needs review/)
    s = transition(s, 'TASK-001', 'dispatch', NOW)
    s = transition(s, 'TASK-001', 'reportBlocked', NOW, { question: 'Which?' })
    assert.equal(s.tasks['TASK-001']?.question, 'Which?')
    s = transition(s, 'TASK-001', 'answer', NOW, { question: undefined })
    assert.equal(s.tasks['TASK-001']?.state, 'running')
    assert.deepEqual(s.tasks['TASK-001']?.history.map((item) => item.to), ['queued', 'running', 'blocked', 'running'])
  })
})

describe('watchdog', () => {
  const facts = (state: State, contracts: TaskContract[], extra: Partial<Facts> = {}): Facts => ({
    now: NOW, state, contracts, invalid: [], alive: {}, worktrees: new Set(), leftovers: [], staleMinutes: 20, manualStaleHours: 24, checks: [], ...extra,
  })
  test('is silent when healthy and names each deviation', () => {
    assert.deepEqual(audit(facts(emptyState(), [])), [])
    const t = task('TASK-001')
    let s = transition(register(emptyState(), 'TASK-001', 'queued', NOW, 'x'), 'TASK-001', 'dispatch', NOW, { mandateHash: 'stale' })
    s = { ...s, lanes: { 'TASK-001': {
      task: 'TASK-001', role: 'worker', executor: 'claude', model: '', branch: 'b', worktree: '/wt', base: 'main', baseCommit: 'x', session: '',
      pid: 42, status: 'running', startedAt: NOW, heartbeatAt: '2026-11-06T11:00:00.000Z', log: 'l', pending: [], attempts: [],
    } } }
    const checks = audit(facts(s, [t], { alive: { 42: true } })).map((item) => item.check)
    assert.deepEqual(checks.sort(), ['lane', 'mandate', 'worktree'])
    assert.match(audit(facts(s, [t], { alive: { 42: false } })).map((d) => d.detail).join(), /process 42 is gone/)
    const left = audit(facts(emptyState(), [], { leftovers: ['branch rw/TASK-009-x belongs to no lane'] }))
    assert.deepEqual(left.map((d) => d.check), ['leftover'])
    assert.match(left[0]!.detail, /1 leftover .* → rw clean/)
  })
})

describe('config', () => {
  test('defaults, validation and tier chains', () => {
    const config = parseConfig({})
    assert.equal(config.base, 'main')
    assert.deepEqual(chain(config, 'review'), [{ executor: 'claude', model: 'opus' }, { executor: 'manual', model: '' }])
    assert.throws(() => parseConfig({ typo: 1 }), /unknown key/)
    assert.throws(() => parseConfig({ tiers: { build: ['ghost'] } }), /executor ghost/)
    assert.throws(() => parseConfig({ policy: { mode: 'yolo' } }), /policy.mode/)
    const disabled = parseConfig({ executors: { claude: { kind: 'claude', enabled: false } } })
    assert.deepEqual(chain(disabled, 'build'), [{ executor: 'manual', model: '' }])
  })
})

describe('local config overlay', () => {
  test('objects merge key by key; lists and values replace', () => {
    const base = { tiers: { build: ['agy', 'claude'], light: ['claude:light'] }, executors: { agy: { kind: 'command', enabled: false, start: ['agy'], models: { default: '' } } }, limits: { lanes: 2 } }
    const local = { tiers: { build: ['agy'] }, executors: { agy: { enabled: true, start: ['node', 'C:/bridge.mjs'], models: { default: 'm1' } } }, worktreeRoot: 'D:/lanes' }
    const merged = mergeConfig(base, local) as typeof base & { worktreeRoot: string }
    assert.deepEqual(merged.tiers, { build: ['agy'], light: ['claude:light'] })
    assert.deepEqual(merged.executors.agy, { kind: 'command', enabled: true, start: ['node', 'C:/bridge.mjs'], models: { default: 'm1' } })
    assert.equal(merged.limits.lanes, 2)
    assert.equal(merged.worktreeRoot, 'D:/lanes')
    const config = parseConfig(merged)
    assert.deepEqual(chain(config, 'build'), [{ executor: 'agy', model: 'm1' }])
    assert.equal(mergeConfig(base, undefined), base)
  })
})

describe('prompts', () => {
  test('fill refuses an unknown placeholder', () => {
    assert.equal(fill('a {x} b', { x: '1' }), 'a 1 b')
    assert.throws(() => fill('{missing}', {}), /\{missing\}/)
  })
})
