// HUBREAD.1 — the /admin/tenants console reuses the hub. A hub that threw
// (tryAssembleHub → null) and a failed heartbeat read used to count 0 and
// render "OK" / "No integrations configured."

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/integrations-hub', () => ({ assembleIntegrationsHub: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { getTenantsRoster, getTenantDetail } from './admin-tenants'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import { logError } from '@/lib/log'

const ORG = { id: 'org-1', name: 'UN1T Group', slug: 'un1t', active: true, created_at: '2026-01-01T00:00:00Z' }
const LOC = { id: 'loc-1', name: 'Stillorgan', organization_id: 'org-1', active: true, created_at: '2026-01-01T00:00:00Z', settings: {} }

// Every read answers its table's rows (filters ignored: one org, one
// location), or the error given for that table.
function consoleDb(byTable = {}) {
  return {
    from(table) {
      const result = byTable[table] ?? { data: [], error: null }
      const answer = () => (result.error ? { data: null, error: result.error } : { data: result.data || [], error: null })
      const b = {
        select: () => b, eq: () => b, neq: () => b, in: () => b, gte: () => b,
        order: () => b, limit: () => b, range: () => b,
        maybeSingle: () => Promise.resolve(result.error
          ? { data: null, error: result.error }
          : { data: (result.data || [])[0] ?? null, error: null }),
        then: (res, rej) => Promise.resolve(answer()).then(res, rej),
      }
      return b
    },
  }
}
const TABLES = { organizations: { data: [ORG] }, locations: { data: [LOC] } }

beforeEach(() => {
  vi.clearAllMocks()
  assembleIntegrationsHub.mockResolvedValue({ attention: [] })
})

describe('getTenantsRoster — failed reads are unknown, never OK (HUBREAD.1)', () => {
  it('a hub that threw → attentionCount null, and it is logged', async () => {
    assembleIntegrationsHub.mockRejectedValue(new Error('boom'))
    const out = await getTenantsRoster(consoleDb(TABLES), { today: '2026-09-28' })
    expect(out.orgs[0].health.attentionCount).toBeNull()
    expect(out.orgs[0].health.staleHeartbeatCount).toBe(0)
    expect(logError).toHaveBeenCalled()
  })

  it('a failed heartbeat read → staleHeartbeatCount null', async () => {
    const out = await getTenantsRoster(
      consoleDb({ ...TABLES, tenant_cron_health: { error: { message: 'x' } } }),
      { today: '2026-09-28' },
    )
    expect(out.orgs[0].health).toEqual({ attentionCount: 0, staleHeartbeatCount: null })
  })

  it('a hub with an unreadable row → EVERY org is unknown, not just the first (S1)', async () => {
    // The unreadable attention row is pinned to the first in-scope
    // location (org A's) — org B must not read that as "nothing wrong".
    const ORG_B = { ...ORG, id: 'org-2', name: 'Org B', slug: 'org-b' }
    const LOC_B = { ...LOC, id: 'loc-2', name: 'Second Studio', organization_id: 'org-2' }
    assembleIntegrationsHub.mockResolvedValue({
      attention: [{ cardKey: 'xero', locationId: 'loc-1', status: 'unknown', unreadable: true }],
    })
    const out = await getTenantsRoster(
      consoleDb({ organizations: { data: [ORG, ORG_B] }, locations: { data: [LOC, LOC_B] } }),
      { today: '2026-09-28' },
    )
    const byId = Object.fromEntries(out.orgs.map((o) => [o.id, o.health.attentionCount]))
    expect(byId).toEqual({ 'org-1': null, 'org-2': null })
  })

  it('healthy reads still count real zeros (pin)', async () => {
    const out = await getTenantsRoster(consoleDb(TABLES), { today: '2026-09-28' })
    expect(out.orgs[0].health).toEqual({ attentionCount: 0, staleHeartbeatCount: 0 })
  })
})

describe('getTenantDetail — a hub that threw (HUBREAD.1)', () => {
  it('marks each location\'s integrations unreadable, never "No integrations configured"', async () => {
    assembleIntegrationsHub.mockRejectedValue(new Error('boom'))
    const out = await getTenantDetail(consoleDb({ ...TABLES, plans: { data: [] } }), 'org-1', { today: '2026-09-28' })
    expect(out.locations[0].integrations).toEqual({ connections: [], attention: [], unreadable: true })
  })
})
