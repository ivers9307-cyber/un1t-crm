// MIAORG.1 Task 2 — the monthly points target is read from the studio's
// RESOLVED Mia settings (DEFAULTS <- org <- studio): an org-wide target
// reaches a studio that sets none. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/hr-post-class-email', () => ({ sendPostClassEmail: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/achievements', () => ({ runDetectionForSession: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/external-export', () => ({ enqueueExportsForSession: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(() => Promise.resolve({ sent: 0, invalidated: 0 })) }))
vi.mock('@/lib/customer-nudge-claim', () => ({ sendNudgeOnce: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T', shortName: 'UN1T' })) }))
vi.mock('@/lib/location-time', async (orig) => ({ ...(await orig()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

import { finalizeSessionRewards } from './live-class'
import { STILLORGAN_BLOB, withOrgLayer } from './agent/settings-fixtures.test-helpers'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const SESSION = { id: 's1', contact_id: 'c1', location_id: LOC, effort_points: 100, ended_at: '2026-10-14T06:00:00Z', source: 'participation', glofox_event_id: null, class_name: 'HIIT', raw_metadata: {} }

function db({ customerAgent, org = null, monthPoints = 5000 }) {
  const inserts = []
  const inner = {
    inserts,
    from(table) {
      let single = { data: null, error: null }
      let many = { data: [], error: null }
      if (table === 'heart_rate_sessions') { single = { data: SESSION, error: null }; many = { data: [{ effort_points: monthPoints }], error: null } }
      if (table === 'locations') single = { data: { id: LOC, organization_id: 'org1', settings: customerAgent === undefined ? {} : { customer_agent: customerAgent } }, error: null }
      const b = {
        select: () => b, eq: () => b, not: () => b, gte: () => b, lte: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
        insert: (row) => { inserts.push({ table, row }); many = { data: [], error: null }; return b },
        upsert: () => b, update: () => b,
        single: () => Promise.resolve(single), maybeSingle: () => Promise.resolve(single),
        then: (ok, bad) => Promise.resolve(many).then(ok, bad),
      }
      return b
    },
  }
  return withOrgLayer(inner, org)
}
const bankedTarget = (d) => d.inserts.find((i) => i.table === 'member_monthly_targets')?.row?.target ?? null

beforeEach(() => vi.clearAllMocks())

describe('finalizeSessionRewards — monthly target from resolved settings', () => {
  // MIAORG.1 final review — monthly_points_target is studio-only: an org value
  // would start tier pushes at every studio while champ-app (which reads the
  // raw studio blob) saw none.
  it('an org-only monthly_points_target does NOT reach a studio that sets none (studio-only)', async () => {
    const d = db({ customerAgent: { enabled: true }, org: { monthly_points_target: 4500 } })
    await finalizeSessionRewards(d, 's1')
    expect(bankedTarget(d)).toBe(null)
  })

  it("the studio's own target wins regardless of an org value", async () => {
    const d = db({ customerAgent: { enabled: true, monthly_points_target: 3000 }, org: { monthly_points_target: 4500 } })
    await finalizeSessionRewards(d, 's1')
    expect(bankedTarget(d)).toBe(3000)
  })

  it("no behaviour change: Stillorgan's own 3000 banks; Hatch (no blob) has no target, org layer null", async () => {
    const still = db({ customerAgent: STILLORGAN_BLOB })
    await finalizeSessionRewards(still, 's1')
    expect(bankedTarget(still)).toBe(3000)
    const hatch = db({ customerAgent: undefined })
    await finalizeSessionRewards(hatch, 's1')
    expect(bankedTarget(hatch)).toBe(null)
  })
})
