// MIA-HYGIENE.1 — the settings write-through contract. The customer-agent PUT
// used to build its persisted object field-by-field, and twice shipped a
// schema key that validated but never got WRITTEN (#495: followups /
// first_class_checkin / agent_name / handoff_cooldown_hours; audit 2026-08-19:
// effort / handoff_after_verify_failures were read live but unreachable from
// the editor). This suite makes the omission a CI failure instead of a silent
// prod drop: every SettingsSchema key must survive into the built blob.
import { describe, it, expect } from 'vitest'
import { SettingsSchema, DEFAULTS, buildCustomerAgentSettings } from './settings-contract'

// social_enabled is a top-level sibling on locations.settings (written next to
// customer_agent, not inside it) — the one documented exception.
const SIBLING_KEYS = ['social_enabled']

describe('settings write-through contract', () => {
  it('every schema key except documented siblings survives into the written blob', () => {
    const parsed = SettingsSchema.parse({ enabled: true })
    const built = buildCustomerAgentSettings(parsed)
    const missing = Object.keys(SettingsSchema.shape)
      .filter((k) => !SIBLING_KEYS.includes(k))
      .filter((k) => !(k in built))
    expect(missing).toEqual([])
  })

  it('effort round-trips; absent → null (core defaults to medium)', () => {
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, effort: 'low' })).effort,
    ).toBe('low')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).effort).toBe(null)
  })

  it('rejects an effort value outside the enum', () => {
    expect(SettingsSchema.safeParse({ enabled: true, effort: 'ultra' }).success).toBe(false)
  })

  it('handoff_after_verify_failures round-trips; absent → null (core defaults to 2)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, handoff_after_verify_failures: 3 }),
      ).handoff_after_verify_failures,
    ).toBe(3)
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true }))
        .handoff_after_verify_failures,
    ).toBe(null)
  })

  // PERSON-ACCT.7 — the deterministic script for the two-live-accounts
  // handoff. A customer-facing string that never reaches the blob is the
  // failure mode this whole file exists for (#495).
  it('account_conflict_handoff_text round-trips; blank → null (core default)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, account_conflict_handoff_text: '  Two accounts — a coach will sort it.  ' }),
      ).account_conflict_handoff_text,
    ).toBe('Two accounts — a coach will sort it.')
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, account_conflict_handoff_text: '   ' }))
        .account_conflict_handoff_text,
    ).toBe(null)
    expect(DEFAULTS.account_conflict_handoff_text).toBe(null)
  })

  it('existing transforms hold: trim-to-null, agent_name default, nested merges', () => {
    const built = buildCustomerAgentSettings(
      SettingsSchema.parse({
        enabled: true,
        tone: '  ',
        agent_name: ' ',
        followups: { enabled: true },
      }),
    )
    expect(built.tone).toBe(null)
    expect(built.agent_name).toBe(DEFAULTS.agent_name)
    expect(built.followups).toEqual({ ...DEFAULTS.followups, enabled: true })
  })
})
