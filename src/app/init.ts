/**
 * `rw init`: give a repository the kit. One source of truth for agent instructions (`skills/` in this
 * package), installed into each host's own location, so Claude Code, Antigravity and DSH read the same text.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../core/frontmatter.ts'
import { UserError } from '../core/model.ts'
import { exists, readText, writeAtomic } from '../infra/fs.ts'
import { gitOk } from '../infra/git.ts'
import { packageFile, PACKAGE_ROOT } from './repo.ts'

export const HOSTS = ['claude', 'antigravity', 'dsh'] as const
export type Host = (typeof HOSTS)[number]

const BEGIN = '<!-- rw:begin -->'
const END = '<!-- rw:end -->'

export interface InitResult {
  readonly root: string
  readonly written: readonly string[]
  readonly kept: readonly string[]
  readonly notes: readonly string[]
  readonly warnings: readonly string[]
}

export function skills(): { name: string; description: string; text: string }[] {
  const dir = join(PACKAGE_ROOT, 'skills')
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const text = packageFile('skills', entry.name, 'SKILL.md')
      const { fields } = parse(text)
      return { name: entry.name, description: String(fields.description ?? ''), text }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Replace the text between the rw markers, or append the section; never touch the rest of the file. */
export function upsertSection(current: string | undefined, section: string): string {
  const block = `${BEGIN}\n${section.trim()}\n${END}`
  if (current === undefined || current.trim() === '') return `# AGENTS.md\n\n${block}\n`
  const start = current.indexOf(BEGIN)
  const end = current.indexOf(END)
  if (start >= 0 && end > start) return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`
  return `${current.trimEnd()}\n\n${block}\n`
}

export function init(cwd: string, options: { hosts: readonly Host[]; force?: boolean }): InitResult {
  let root: string
  try {
    root = gitOk(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new UserError(`${cwd} is not inside a git repository; run git init first`)
  }
  const written: string[] = []
  const kept: string[] = []
  const notes: string[] = []
  const put = (rel: string, text: string, overwrite = options.force === true) => {
    const path = join(root, rel)
    if (exists(path) && !overwrite) {
      kept.push(rel)
      return
    }
    writeAtomic(path, text)
    written.push(rel)
  }

  put('.rw/config.json', packageFile('templates', 'config.json'))
  // runtime state and the machine-local config overlay never enter git; existing files gain missing lines
  const ignore = join(root, '.rw', '.gitignore')
  const ignored = (readText(ignore) ?? '').split(/\r?\n/).map((line) => line.trim())
  const lines = ['state/', 'config.local.json'].filter((line) => !ignored.includes(line))
  if (lines.length) {
    writeAtomic(ignore, `${(readText(ignore) ?? '').replace(/\s*$/, '\n').replace(/^\n$/, '')}${lines.join('\n')}\n`)
    written.push('.rw/.gitignore')
  } else kept.push('.rw/.gitignore')
  put('.rw/prompts/worker.md', packageFile('templates', 'team-worker.md'))
  put('.rw/prompts/reviewer.md', packageFile('templates', 'team-reviewer.md'))
  put('work/tasks/README.md', packageFile('templates', 'tasks-README.md'))
  put('work/reports/README.md', packageFile('templates', 'reports-README.md'))
  const agents = join(root, 'AGENTS.md')
  const merged = upsertSection(readText(agents), packageFile('templates', 'agents-section.md'))
  if (merged !== readText(agents)) {
    writeAtomic(agents, merged)
    written.push('AGENTS.md')
  } else kept.push('AGENTS.md')

  const all = skills()
  for (const host of options.hosts) {
    if (host === 'claude') {
      for (const skill of all) put(`.claude/skills/${skill.name}/SKILL.md`, skill.text, true)
      const claudeMd = readText(join(root, 'CLAUDE.md'))
      if (!claudeMd) put('CLAUDE.md', '@AGENTS.md\n', true)
      else if (!claudeMd.includes('@AGENTS.md')) {
        writeAtomic(join(root, 'CLAUDE.md'), `${claudeMd.trimEnd()}\n\n@AGENTS.md\n`)
        written.push('CLAUDE.md')
      }
    }
    if (host === 'antigravity') {
      for (const skill of all) {
        const body = parse(skill.text).body
        put(`.agent/workflows/${skill.name}.md`, `---\ndescription: ${skill.description}\n---\n\n${body.trim()}\n`, true)
      }
      put('.agent/rules/router-worker.md', packageFile('templates', 'antigravity-rule.md'), true)
      notes.push('Antigravity: workflows are in .agent/workflows (run /rw-router in the agent panel). Check your Antigravity version reads .agent/; move them if it uses another folder.')
    }
    if (host === 'dsh') {
      notes.push('DSH: install the plugin into a profile (docs/04-hosts.md); it registers the rw skills and tools itself, nothing is written to the repository.')
    }
  }
  const warnings: string[] = []
  try {
    const config = JSON.parse(readText(join(root, '.rw', 'config.json')) ?? '{}') as { gates?: { merge?: unknown[] }; watchdog?: { checks?: unknown[] } }
    if (!config.gates?.merge?.length) warnings.push('gates.merge is empty: a merge runs only each task\'s own accept commands. Add the repository\'s full gate (for example "bun run gates") to .rw/config.json.')
    if (!config.watchdog?.checks?.length) warnings.push('watchdog.checks is empty: rw watchdog audits rw\'s own state only, none of the repository\'s invariants.')
  } catch {
    warnings.push('.rw/config.json is not valid JSON')
  }
  return { root, written, kept, notes, warnings }
}
