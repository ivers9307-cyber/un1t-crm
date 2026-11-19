// UN1TRADAR.3 — the rail's "uncontacted leads" row reads the acquisition board
// when the location's primary board is something else (Hatch: the manual
// waitlist board), and is unchanged where the primary board is acquisition.
// CONTACTLOG.2 — "contacted" is the board's rule now (loadRecentlyContacted,
// stubbed here over the fake's `contact_log` rows), and the row opens the
// board's "Not contacted" view.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn(async () => 0) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn() }))
vi.mock('@/lib/contact-log', () => ({
  loadRecentlyContacted: vi.fn(async (db, { locationId, contactIds }) => {
    db.log.push({ table: 'contact_log', filters: [['eq', 'location_id', locationId], ['in', 'contact_id', contactIds]] })
    if (db.errors.contact_log) return { ok: false }
    return { ok: true, contacted: new Set((db.tables.contact_log || []).filter((r) => r.location_id === locationId && contactIds.includes(r.contact_id)).map((r) => r.contact_id)) }
  }),
}))

import { radarReadsFor } from '@/lib/membership/reads/index'
import { buildNeedsYouRail } from './business-rail'

const L = 'loc-1'
const NOW = new Date('2026-10-18T12:00:00Z')
const OLD = '2026-10-16T09:00:00Z'
const NEW = '2026-10-18T09:00:00Z'

function tableDb(tables, errors = {}) {
  const log = []
  return {
    log,
    tables,
    errors,
    from(table) {
      const s = { table, filters: [] }
      const b = {}
      for (const m of ['select', 'order', 'limit']) b[m] = () => b
      for (const op of ['eq', 'in', 'lte', 'lt', 'gte']) b[op] = (c, v) => { s.filters.push([op, c, v]); return b }
      b.then = (res, rej) => {
        log.push(s)
        const rows = (tables[table] || []).filter((r) => s.filters.every(([op, c, v]) => (
          op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'lte' ? String(r[c]) <= String(v) : op === 'lt' ? String(r[c]) < String(v) : String(r[c]) >= String(v))))
        if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(res, rej)
        return Promise.resolve({ data: rows, error: null }).then(res, rej)
      }
      return b
    },
  }
}
const leadsRowOf = async (db) => (await buildNeedsYouRail(db, { id: 'u1' }, L, NOW)).find((r) => r.key === 'leads') ?? null

// The acquisition-board branch is UN1TRADAR.4's: it only runs where the
// studio's provider supplies memberships. Default here = it does.
const PROVIDES = { source: 'un1t_online', reads: {}, providesMemberships: true, pinArrears: true }
const NOT_YET = { source: 'un1t_online', reads: {}, providesMemberships: false, pinArrears: true }

beforeEach(() => {
  vi.clearAllMocks()
  radarReadsFor.mockResolvedValue(PROVIDES)
})

// Hatch today: waitlist primary, enabled acquisition board with leads on it.
function hatchTables(extra = {}) {
  return {
    pipelines: [
      { id: 'p-wait', location_id: L, key: 'waitlist', is_primary: true, enabled: true },
      { id: 'p-acq', location_id: L, key: 'acquisition', is_primary: false, enabled: true },
    ],
    pipeline_stages: [{ id: 's-new', pipeline_id: 'p-acq', location_id: L, slug: 'new_lead' }],
    deals: [
      { id: 'd1', location_id: L, pipeline_id: 'p-acq', stage_id: 's-new', status: 'open', contact_id: 'a', created_at: OLD },
      { id: 'd2', location_id: L, pipeline_id: 'p-acq', stage_id: 's-new', status: 'open', contact_id: 'b', created_at: OLD },
    ],
    contacts: [{ id: 'x', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }, { id: 'y', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }, { id: 'z', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }],
    ...extra,
  }
}

describe('rail leadsRow', () => {
  it('leadsRow on an acquisition-primary location is unchanged (contacts.pipeline_stage_slug)', async () => {
    const db = tableDb({
      pipelines: [{ id: 'p-acq', location_id: L, key: 'acquisition', is_primary: true, enabled: true }],
      contacts: [
        { id: 'c1', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD },
        { id: 'c2', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: NEW },
      ],
      })
    expect(await leadsRowOf(db)).toEqual({ key: 'leads', chip: 'Leads', tone: 'teal', text: '1 lead uncontacted > 24h', href: '/pipeline?nocontact=1' })
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
      contact_log: [{ contact_id: 'b', location_id: L }],
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

  it('acquisition-primary (Stillorgan) is the same whether or not the capability is reported', async () => {
    const tables = {
      pipelines: [{ id: 'p-acq', location_id: L, key: 'acquisition', is_primary: true, enabled: true }],
      contacts: [{ id: 'c1', location_id: L, pipeline_stage_slug: 'new_lead', joined_at: OLD }],
      }
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: {}, providesMemberships: true, pinArrears: false })
    const withCap = await leadsRowOf(tableDb(tables))
    radarReadsFor.mockResolvedValue(NOT_YET)
    const without = await leadsRowOf(tableDb(tables))
    expect(withCap).toEqual(without)
    expect(withCap.text).toBe('1 lead uncontacted > 24h')
  })

  it('un1t studio whose provider does not supply memberships yet: exactly main\'s contacts count, no acquisition read', async () => {
    radarReadsFor.mockResolvedValue(NOT_YET)
    const db = tableDb(hatchTables())
    expect((await leadsRowOf(db)).text).toBe('3 leads uncontacted > 24h')
    expect(db.log.some((q) => q.table === 'deals' || q.table === 'pipeline_stages')).toBe(false)
  })

  it('an unreadable membership source at a manual-primary studio also falls back to main\'s count', async () => {
    radarReadsFor.mockRejectedValue(Object.assign(new Error('membership source unreadable'), { code: 'MEMBERSHIP_SOURCE_UNREADABLE' }))
    const db = tableDb(hatchTables())
    expect((await leadsRowOf(db)).text).toBe('3 leads uncontacted > 24h')
    expect(db.log.some((q) => q.table === 'deals')).toBe(false)
  })

  it('acquisition branch: the contacting-actions read is scoped to the studio', async () => {
    const db = tableDb(hatchTables({
      contact_log: [
        { contact_id: 'a', location_id: 'other-studio' },
        { contact_id: 'b', location_id: L },
      ],
    }))
    // b is contacted HERE; a was contacted at another studio, so still counts
    expect((await leadsRowOf(db)).text).toBe('1 lead uncontacted > 24h')
    const q = db.log.find((x) => x.table === 'contact_log')
    expect(q.filters).toContainEqual(['eq', 'location_id', L])
  })

  it('acquisition branch: a failed contacting-actions read omits the row, never an over-count', async () => {
    const db = tableDb(hatchTables(), { contact_log: { message: 'boom' } })
    expect(await leadsRowOf(db)).toBeNull()
  })

  it('acquisition branch: a failed stages or deals read omits the row', async () => {
    expect(await leadsRowOf(tableDb(hatchTables(), { pipeline_stages: { message: 'boom' } }))).toBeNull()
    expect(await leadsRowOf(tableDb(hatchTables(), { deals: { message: 'boom' } }))).toBeNull()
  })
})
