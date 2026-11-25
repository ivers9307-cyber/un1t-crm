// INBOXFOLLOW.3 — followups.staff_threads must reach the runner through the
// REAL settings path (the Zod contract on save, the resolver at runtime), not
// only through a hand-built settings object. Zod strips unknown keys, so a key
// missing from the contract is silently dropped on the first settings save.
import { describe, it, expect } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db'
import { StudioSettingsSchema, OrgSettingsSchema, orgSettingsRefusals, buildOrgLayer } from './settings-contract'
import { resolveAgentSettingsForLocation } from './settings-resolve'
import { followupConfigFromSettings } from '@/lib/inbox-followup-config'

const STAFF = { quiet_after_hours: 72, nudge_enabled: true, template_name: 'staff_check_in' }
const location = (customer_agent, organization_id = null) => ({ id: 'loc-1', name: 'Test', organization_id, settings: { customer_agent } })

describe('followups.staff_threads', () => {
  it('survives the contract parse a settings save runs', () => {
    const parsed = StudioSettingsSchema.safeParse({ enabled: true, followups: { enabled: false, staff_threads: STAFF } })
    expect(parsed.success).toBe(true)
    expect(parsed.data.followups.staff_threads).toEqual(STAFF)
  })

  it('refuses a quiet period outside 4..336 hours', () => {
    for (const bad of [3, 337]) {
      const parsed = StudioSettingsSchema.safeParse({ followups: { staff_threads: { ...STAFF, quiet_after_hours: bad } } })
      expect(parsed.success).toBe(false)
    }
  })

  it('comes out of the resolver intact and reads as the inbox config', async () => {
    const out = await resolveAgentSettingsForLocation(createFakeDb(), location({ enabled: true, followups: { enabled: true, staff_threads: STAFF } }))
    expect(out.ok).toBe(true)
    expect(out.settings.followups.staff_threads).toEqual(STAFF)
    expect(out.settings.followups.template_name).toBe(null) // the ladder's own fields are untouched
    expect(followupConfigFromSettings(out.settings)).toEqual({ quietHours: 72, nudgeEnabled: true })
  })

  it('a studio that never set it resolves with no staff_threads: off, 48 hours', async () => {
    const out = await resolveAgentSettingsForLocation(createFakeDb(), location({ enabled: true, followups: { enabled: true } }))
    expect(out.settings.followups.staff_threads).toBeUndefined()
    expect(followupConfigFromSettings(out.settings)).toEqual({ quietHours: 48, nudgeEnabled: false })
  })

  it('the nudge switch and template are studio-only: an organisation layer never turns them on', async () => {
    const orgLayer = { followups: { staff_threads: { quiet_after_hours: 24, nudge_enabled: true, template_name: 'org_tpl' } } }
    expect(OrgSettingsSchema.safeParse(orgLayer).success).toBe(true)
    const db = createFakeDb({ tables: { org_settings: [{ organization_id: 'org-1', customer_agent: orgLayer }] } })

    // Studio silent: the quiet period is inherited, the switch and template are not.
    const inherited = await resolveAgentSettingsForLocation(db, location({ enabled: true }, 'org-1'))
    const st = inherited.settings.followups.staff_threads
    expect(st.quiet_after_hours).toBe(24)
    expect(st.nudge_enabled ?? false).toBe(false)
    expect(st.template_name ?? null).toBe(null)
    expect(followupConfigFromSettings(inherited.settings)).toEqual({ quietHours: 24, nudgeEnabled: false })
    // What the settings screen reads as the organisation's values carries no switch either.
    expect(inherited.org.followups.staff_threads).toEqual({ quiet_after_hours: 24 })

    // Studio sets its own switch and template: those win; the quiet period still shows through.
    const own = await resolveAgentSettingsForLocation(db, location({
      enabled: true, followups: { staff_threads: { nudge_enabled: true, template_name: 'own_tpl' } },
    }, 'org-1'))
    expect(own.settings.followups.staff_threads).toEqual({ quiet_after_hours: 24, nudge_enabled: true, template_name: 'own_tpl' })

    // Studio sets everything: its own values.
    const full = await resolveAgentSettingsForLocation(db, location({ enabled: true, followups: { staff_threads: STAFF } }, 'org-1'))
    expect(full.settings.followups.staff_threads).toEqual(STAFF)
  })

  it('the organisation editor path refuses the two studio-only fields', () => {
    const issues = orgSettingsRefusals({ followups: { staff_threads: { quiet_after_hours: 24, nudge_enabled: true } } })
    expect(issues.map((i) => i.path)).toEqual(['settings.followups.staff_threads.nudge_enabled'])
    expect(orgSettingsRefusals({ followups: { staff_threads: { template_name: 'x' } } })).toHaveLength(1)
    expect(orgSettingsRefusals({ followups: { staff_threads: { quiet_after_hours: 24 } } })).toEqual([])
    const layer = buildOrgLayer({ followups: { staff_threads: STAFF } }, ['followups.staff_threads'])
    expect(layer.followups.staff_threads).toEqual({ quiet_after_hours: 72 })
  })
})
