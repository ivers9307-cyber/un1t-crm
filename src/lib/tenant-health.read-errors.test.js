// HUBREAD.1 — /admin/health's reads. Each used to destructure only `data`,
// so a failed read read as "nothing wrong": no chips, the org "healthy",
// Mia $0.00, no backlog, or "No active locations".

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { getTenantHealth } from './tenant-health.js'
import { logError } from '@/lib/log'

const LOCS = [{ id: 'l1', name: 'Stillorgan', organization_id: 'o1', organizations: { name: 'UN1T Group' }, active: true }]

// Per-table answers; .eq(col, val) is honoured on rows that carry the column.
function healthDb(byTable = {}) {
  return {
    from(table) {
      const result = byTable[table] ?? { data: [], error: null }
      const eqs = []
      const b = {
        select: () => b,
        eq: (col, val) => { eqs.push([col, val]); return b },
        in: () => b, gte: () => b, order: () => b,
        then: (res, rej) => Promise.resolve(result.error
          ? { data: null, error: result.error }
          : { data: (result.data || []).filter((r) => eqs.every(([c, v]) => !(c in r) || r[c] === v)), error: null },
        ).then(res, rej),
      }
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('getTenantHealth — failed reads (HUBREAD.1)', () => {
  for (const [table, signal] of [['channel_connections', 'connections'], ['tenant_cron_health', 'heartbeats']]) {
    it(`a failed ${table} read is never "healthy"`, async () => {
      const out = await getTenantHealth(healthDb({ locations: { data: LOCS }, [table]: { error: { message: 'boom' } } }))
      expect(out.unreadable).toEqual([signal])
      const org = out.orgs[0]
      expect(org.needsAttention).toBe(false)
      expect(org.unverified).toBe(true)
      expect(org.locations[0].unknownSignals).toEqual([signal])
      expect(logError).toHaveBeenCalledTimes(1)
    })
  }

  it('a failed spend read is null, never $0.00; a failed backlog read is null, never 0', async () => {
    const out = await getTenantHealth(healthDb({
      locations: { data: LOCS },
      usage_rollups_daily: { error: { message: 'x' } },
      campaigns: { error: { message: 'y' } },
    }))
    expect(out.unreadable).toEqual(['rollups', 'campaigns'])
    const loc = out.orgs[0].locations[0]
    expect(loc.aiCostCentsMtd).toBeNull()
    expect(loc.campaignBacklog).toBeNull()
    // Spend and backlog are information, not the health verdict.
    expect(out.orgs[0].unverified).toBe(false)
  })

  it('a failed locations read is no orgs AND says so', async () => {
    const out = await getTenantHealth(healthDb({ locations: { error: { message: 'x' } } }))
    expect(out).toEqual({ orgs: [], unreadable: ['locations'] })
  })

  it('a deactivated registry row is not shown as a connection', async () => {
    const out = await getTenantHealth(healthDb({
      locations: { data: LOCS },
      channel_connections: { data: [
        { location_id: 'l1', platform: 'glofox', status: 'connected', last_error: null, is_active: false },
        { location_id: 'l1', platform: 'instagram', status: 'connected', last_error: null, is_active: true },
      ] },
    }))
    expect(out.orgs[0].locations[0].connections.map((c) => c.platform)).toEqual(['instagram'])
  })

  it('healthy reads: nothing unknown (pin)', async () => {
    const out = await getTenantHealth(healthDb({ locations: { data: LOCS } }))
    expect(out.unreadable).toEqual([])
    expect(out.orgs[0]).toMatchObject({ needsAttention: false, unverified: false })
    expect(out.orgs[0].locations[0]).toMatchObject({ aiCostCentsMtd: 0, campaignBacklog: 0, unknownSignals: [] })
  })
})
