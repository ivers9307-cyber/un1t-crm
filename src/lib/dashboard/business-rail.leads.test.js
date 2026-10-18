// UN1TRADAR.3 — the rail's "uncontacted leads" row reads the acquisition board
// when the location's primary board is something else (Hatch: the manual
// waitlist board), and is unchanged where the primary board is acquisition.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn(async () => 0) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn(async () => ({ source: 'none', reads: {} })) }))

import { buildNeedsYouRail } from './business-rail'

const L = 'loc-1'
const NOW = new Date('2026-10-18T12:00:00Z')
const OLD = '2026-10-16T09:00:00Z'
const NEW = '2026-10-18T09:00:00Z'

function tableDb(tables) {
  const log = []
  return {
    log,
    from(table) {
      const s = { table, filters: [] }
      const b = {}
      for (const m of ['select', 'order', 'limit']) b[m] = () => b
      for (const op of ['eq', 'in', 'lte', 'lt', 'gte']) b[op] = (c, v) => { s.filters.push([op, c, v]); return b }
      b.then = (res, rej) => {
        log.push(s)
        const rows = (tables[table] || []).filter((r) => s.filters.every(([op, c, v]) => (
          op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'lte' ? String(r[c]) <= String(v) : op === 'lt' ? String(r[c]) < String(v) : String(r[c]) >= String(v))))
        return Promise.resolve({ data: rows, error: null }).then(res, rej)
      }
      return b
    },
  }
}
const leadsRowOf = async (db) => (await buildNeedsYouRail(db, { id: 'u1' }, L, NOW)).find((r) => r.key === 'leads') ?? null

beforeEach(() => vi.clearAllMocks())

describe('rail leadsRow', () => {
  it('leadsRow on an acquisition-primary location is unchanged (contacts.pipeline_stage_slug)', async () => {
    const db = tableDb({
      pipelines: [{ id: 'p-acq', location_id: L, key: 'acquisition', is_primary: true, enabled: true }],
      contacts: [
        { id: 'c1', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD },
        { id: 'c2', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: NEW },
      ],
      lead_radar_actions: [],
    })
    expect(await leadsRowOf(db)).toEqual({ key: 'leads', chip: 'Leads', tone: 'teal', text: '1 lead uncontacted > 24h', href: '/dashboard/lead-radar' })
    expect(db.log.some((q) => q.table === 'deals')).toBe(false)
  })

  it('leadsRow on a manual-primary location reads acquisition deals (open, new_lead stage, > 24h, not contacted)', async () => {
    const db = tableDb({
      pipelines: [
        { id: 'p-wait', location_id: L, key: 'waitlist', is_primary: true, enabled: true },
        { id: 'p-acq', location_id: L, key: 'acquisition', is_primary: false, enabled: true },
      ],
      pipeline_stages: [{ id: 's-new', pipeline_id: 'p-acq', location_id: L, slug: 'new_lead' }, { id: 's-trial', pipeline_id: 'p-acq', location_id: L, slug: 'trial' }],
      deals: [
        { id: 'd1', location_id: L, pipeline_id: 'p-acq', stage_id: 's-new', status: 'open', contact_id: 'a', created_at: OLD },
        { id: 'd2', location_id: L, pipeline_id: 'p-acq', stage_id: 's-new', status: 'open', contact_id: 'b', created_at: OLD },
        { id: 'd3', location_id: L, pipeline_id: 'p-acq', stage_id: 's-new', status: 'open', contact_id: 'c', created_at: NEW },
        { id: 'd4', location_id: L, pipeline_id: 'p-acq', stage_id: 's-trial', status: 'open', contact_id: 'd', created_at: OLD },
        { id: 'd5', location_id: L, pipeline_id: 'p-acq', stage_id: 's-new', status: 'won', contact_id: 'e', created_at: OLD },
      ],
      lead_radar_actions: [{ contact_id: 'b', action: 'contacted' }],
      // the contacts column follows the waitlist board here: never counted
      contacts: [{ id: 'x', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }, { id: 'y', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }, { id: 'z', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }],
    })
    expect((await leadsRowOf(db)).text).toBe('1 lead uncontacted > 24h')
  })

  it('no acquisition board (or a disabled one) → no row', async () => {
    const db = tableDb({
      pipelines: [{ id: 'p-wait', location_id: L, key: 'waitlist', is_primary: true, enabled: true }, { id: 'p-acq', location_id: L, key: 'acquisition', is_primary: false, enabled: false }],
      contacts: [{ id: 'x', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }],
    })
    expect(await leadsRowOf(db)).toBeNull()
  })
})
