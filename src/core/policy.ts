/**
 * The gate: who may create work. The owner's requests are explicit and always pass. Work an agent finds
 * by itself (a watchdog finding, a GAP, a follow-up idea) is a proposal under a rule the owner wrote, and
 * the accept mode decides what happens to it. Starting in `observe` costs the owner one look per batch
 * instead of one surprise per task.
 */
import type { TaskContract } from './model.ts'

export type AcceptMode = 'off' | 'observe' | 'auto'

export interface Rule {
  readonly id: string
  readonly text: string
  readonly enabled: boolean
  /** Tiers a proposal under this rule may use; empty means any. */
  readonly tiers: readonly string[]
  /** The largest number of scope entries an auto-accepted proposal may have. */
  readonly maxScope: number
}

export interface Policy {
  readonly mode: AcceptMode
  readonly rules: readonly Rule[]
}

export type GateResult =
  | { readonly outcome: 'refuse'; readonly reason: string }
  | { readonly outcome: 'propose'; readonly reason: string }
  | { readonly outcome: 'accept'; readonly reason: string; readonly authority: string }

export function gate(task: TaskContract, policy: Policy): GateResult {
  if (task.basis === 'explicit') return { outcome: 'propose', reason: 'explicit work is approved by the owner (rw add or rw approve)' }
  const ruleId = task.basis.slice('rule:'.length)
  const rule = policy.rules.find((item) => item.id === ruleId)
  if (!rule) return { outcome: 'refuse', reason: `no rule ${ruleId} in .rw/config.json policy.rules` }
  if (!rule.enabled) return { outcome: 'refuse', reason: `rule ${ruleId} is disabled` }
  if (policy.mode === 'off') return { outcome: 'refuse', reason: 'policy.mode is off: proposals are not recorded' }
  if (policy.mode === 'observe') return { outcome: 'propose', reason: `recorded for the owner (observe mode, rule ${ruleId})` }
  if (rule.tiers.length && !rule.tiers.includes(task.tier)) {
    return { outcome: 'propose', reason: `rule ${ruleId} does not allow tier ${task.tier}; the owner decides` }
  }
  if (task.scope.length > rule.maxScope) {
    return { outcome: 'propose', reason: `scope has ${task.scope.length} entries, rule ${ruleId} allows ${rule.maxScope} without the owner` }
  }
  return { outcome: 'accept', reason: `auto-accepted under rule ${ruleId}`, authority: `rule ${ruleId} (auto)` }
}
