/**
 * The watchdog across several repositories: each one audited exactly as `rw watchdog` would audit it in
 * its own folder, with its own config, state and checks; then one verdict per repository and one for all.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { UserError } from '../core/model.ts'
import type { Deviation } from '../core/watchdog.ts'
import { watchdog } from './ops.ts'
import { Repo } from './repo.ts'

export type Verdict = 'ok' | 'deviations' | 'partial' | 'error'

export interface RepoAudit {
  readonly path: string
  readonly verdict: Verdict
  readonly deviations: readonly Deviation[]
  readonly skipped: readonly string[]
  /** Why the repository could not be audited at all (not a git repository, no .rw/config.json, …). */
  readonly error?: string
}

/** One repository per line; blank lines and `#` comments are ignored. */
export function readRepoList(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new UserError(`cannot read the repository list ${file}`)
  }
  return text.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean)
}

export function auditRepos(paths: readonly string[], options: { skipChecks?: boolean } = {}): RepoAudit[] {
  const seen = new Set<string>()
  const out: RepoAudit[] = []
  for (const raw of paths) {
    const path = resolve(raw)
    const key = path.replaceAll('\\', '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const { deviations, skipped } = watchdog(Repo.open(path), options)
      out.push({ path, deviations, skipped, verdict: deviations.length ? 'deviations' : skipped.length ? 'partial' : 'ok' })
    } catch (error) {
      // one broken repository must not hide the others' results
      out.push({ path, deviations: [], skipped: [], verdict: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}

/** 1 if any repository has a deviation or could not be audited, else 4 if any audit was partial, else 0. */
export function exitFor(audits: readonly RepoAudit[]): number {
  if (audits.some((audit) => audit.verdict === 'deviations' || audit.verdict === 'error')) return 1
  return audits.some((audit) => audit.verdict === 'partial') ? 4 : 0
}
