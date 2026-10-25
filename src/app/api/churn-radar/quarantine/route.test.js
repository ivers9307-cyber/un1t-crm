// UN1TRADAR.3 — bulk quarantine and lead cleanup act on owned contacts and on
// crossovers at the ACTIVE studio only. The contacts write (Glofox studio,
// 'stale' / 'archive') touches owned contacts only: a crossover's row belongs
// to another studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => USER) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/radar-cache', () => ({ invalidateRadar: vi.fn(), radarCache: vi.fn() }))
vi.mock('@/lib/contact-crossovers', () => ({ isCrossoverAt: vi.fn(async () => false), crossoverIdsAt: vi.fn(async () => new Set()) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn(async () => ({ source: 'glofox', reads: {}, providesMemberships: true, pinArrears: false })) }))

import { crossoverIdsAt } from '@/lib/contact-crossovers'
import { POST as quarantinePOST } from './route.js'
import { POST as cleanupPOST } from '../../lead-radar/cleanup/route.js'

const L = 'loc-1'
const USER = { id: 'user-1', profileRole: 'master', activeLocation: { id: L }, rolesByLocation: { [L]: 'owner' } }
let db
let writes

function mockDb(owned) {
  return {
    from(table) {
      const s = { table, filters: [] }
      const chain = {}
      chain.select = () => chain
      chain.eq = (c, v) => { s.filters.push(['eq', c, v]); return chain }
      chain.in = (c, v) => { s.filters.push(['in', c, v]); return chain }
      chain.update = (patch) => { s.update = patch; return chain }
      chain.insert = (rows) => { writes.push({ table, insert: rows }); return Promise.resolve({ data: null, error: null }) }
      chain.then = (res, rej) => {
        if (s.update) { writes.push({ table, update: s.update, ids: s.filters.find(([k]) => k === 'in')[2] }); return Promise.resolve({ data: null, error: null }).then(res, rej) }
        if (table === 'contacts') {
          const ids = s.filters.find(([k, c]) => k === 'in' && c === 'id')[2]
          return Promise.resolve({ data: ids.filter((id) => owned.includes(id)).map((id) => ({ id })), error: null }).then(res, rej)
        }
        return Promise.resolve({ data: [], error: null }).then(res, rej)
      }
      return chain
    },
  }
}
const req = (path, body) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => { vi.clearAllMocks(); writes = []; db = mockDb(['owned-1']) })

describe('bulk radar triage and crossovers', () => {
  for (const [name, POST, path, decision, table, action] of [
    ['quarantine', quarantinePOST, '/api/churn-radar/quarantine', 'stale', 'churn_radar_actions', 'quarantine_stale'],
    ['cleanup', cleanupPOST, '/api/lead-radar/cleanup', 'archive', 'lead_radar_actions', 'cleanup_archive'],
  ]) {
    it(`${name}: scopes owned ∪ crossover ids only; the contacts write is owned only`, async () => {
      crossoverIdsAt.mockResolvedValueOnce(new Set(['cross-1']))
      const res = await POST(req(path, { decision, contact_ids: ['owned-1', 'cross-1', 'stranger-1'] }))
      expect(res.status).toBe(200)
      expect(crossoverIdsAt).toHaveBeenCalledWith(db, ['cross-1', 'stranger-1'], L)
      const upd = writes.find((w) => w.update)
      expect(upd).toMatchObject({ table: 'contacts', update: { pipeline_stage_slug: 'dormant' }, ids: ['owned-1'] })
      const ins = writes.find((w) => w.insert)
      expect(ins.table).toBe(table)
      expect(ins.insert.map((r) => r.contact_id).sort()).toEqual(['cross-1', 'owned-1'])
      expect(ins.insert.every((r) => r.action === action && r.location_id === L)).toBe(true)
    })
    it(`${name}: a probe failure leaves the owned contacts only`, async () => {
      crossoverIdsAt.mockResolvedValueOnce(new Set())
      await POST(req(path, { decision, contact_ids: ['owned-1', 'cross-1'] }))
      expect(writes.find((w) => w.insert).insert.map((r) => r.contact_id)).toEqual(['owned-1'])
    })
  }
})

// ORGCONTACTS.4 (decision 3) — dormancy is per studio: the archive / stale
// decision writes the stage AT the radar's studio onto the person's
// contact_studios row (owned and crossover alike, keeping the row's kind /
// source / status), and the contact-wide column only for the owned contacts,
// whose primary studio this is. A person with no relationship row here is
// not marked here.
vi.mock('@/lib/contact-studios', () => ({
  contactsAtStudio: vi.fn(async () => ({ ok: true, rows: [] })),
  upsertContactStudio: vi.fn(async () => ({ ok: true, row: {} })),
}))
import { contactsAtStudio, upsertContactStudio } from '@/lib/contact-studios'

describe("the radar archive writes the studio row's stage and the contact column only at the primary studio", () => {
  for (const [name, POST, path, decision] of [
    ['quarantine', quarantinePOST, '/api/churn-radar/quarantine', 'stale'],
    ['cleanup', cleanupPOST, '/api/lead-radar/cleanup', 'archive'],
  ]) {
    it(`${name}: owned + crossover rows get stage_slug dormant at this studio; the contacts column stays owned-only; no row → no mark`, async () => {
      crossoverIdsAt.mockResolvedValueOnce(new Set(['cross-1']))
      contactsAtStudio.mockResolvedValueOnce({ ok: true, rows: [
        { contact_id: 'owned-1', location_id: L, kind: 'member', status: 'ended', source: 'glofox', stage_slug: 'member' },
        { contact_id: 'cross-1', location_id: L, kind: 'lead', status: 'active', source: 'deal', stage_slug: 'new_lead' },
      ] })
      const res = await POST(req(path, { decision, contact_ids: ['owned-1', 'cross-1', 'norow-1'] }))
      expect(res.status).toBe(200)
      expect(contactsAtStudio).toHaveBeenCalledWith(db, L, { contactIds: ['owned-1', 'cross-1'] })
      const calls = upsertContactStudio.mock.calls.map((c) => c[1]).sort((a, b) => a.contactId.localeCompare(b.contactId))
      expect(calls).toEqual([
        { contactId: 'cross-1', locationId: L, kind: 'lead', status: 'active', source: 'deal', stageSlug: 'dormant' },
        { contactId: 'owned-1', locationId: L, kind: 'member', status: 'ended', source: 'glofox', stageSlug: 'dormant' },
      ])
      expect(writes.find((w) => w.update)).toMatchObject({ table: 'contacts', update: { pipeline_stage_slug: 'dormant' }, ids: ['owned-1'] })
    })

    it(`${name}: a failed studio-row read or write is logged and the decision still lands (the log and the contacts column are the record)`, async () => {
      crossoverIdsAt.mockResolvedValueOnce(new Set())
      contactsAtStudio.mockResolvedValueOnce({ ok: false, error: 'down' })
      const res = await POST(req(path, { decision, contact_ids: ['owned-1'] }))
      expect(res.status).toBe(200)
      expect(upsertContactStudio).not.toHaveBeenCalled()
      expect(writes.find((w) => w.update)).toMatchObject({ table: 'contacts', ids: ['owned-1'] })
    })
  }
})
