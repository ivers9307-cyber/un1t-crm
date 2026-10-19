// UN1TRADAR.3 — the radar write routes accept a crossover at the ACTIVE studio
// (a membership or a un1t client there) and refuse it anywhere else (404).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => USER) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/radar-cache', () => ({ invalidateRadar: vi.fn(), radarCache: vi.fn() }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn(async () => ({ source: 'glofox', reads: {}, providesMemberships: true, pinArrears: false })) }))
vi.mock('@/lib/contact-crossovers', () => ({ isCrossoverAt: vi.fn(async () => false), crossoverIdsAt: vi.fn(async () => new Set()) }))

import { isCrossoverAt } from '@/lib/contact-crossovers'
import { POST as churnAction } from './route.js'
import { POST as leadAction } from '../../lead-radar/action/route.js'
import { POST as refreshMember } from '../refresh-member/route.js'

const HATCH = 'loc-hatch'
let USER = { id: 'user-1', activeLocation: { id: HATCH } }
let db
let inserts
const CONTACT = { id: 'c-dual', name: 'Dual Member', first_name: 'Dual', location_id: 'loc-still', wa_phone: null, phone: null }

function mockDb() {
  return {
    from(table) {
      const chain = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = () => chain
      chain.maybeSingle = () => Promise.resolve({ data: table === 'contacts' ? CONTACT : null, error: null })
      chain.insert = (row) => { inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }) }
      chain.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
      return chain
    },
  }
}
const req = (path, body) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => { vi.clearAllMocks(); inserts = []; db = mockDb() })

describe('single-contact radar actions and crossovers', () => {
  for (const [name, POST, path, table] of [
    ['churn action', churnAction, '/api/churn-radar/action', 'churn_radar_actions'],
    ['lead action', leadAction, '/api/lead-radar/action', 'lead_radar_actions'],
  ]) {
    it(`${name}: a crossover at the active studio is accepted`, async () => {
      isCrossoverAt.mockResolvedValueOnce(true)
      const res = await POST(req(path, { contact_id: 'c-dual', action: 'contacted' }))
      expect(res.status).toBe(200)
      expect(isCrossoverAt).toHaveBeenCalledWith(db, 'c-dual', HATCH)
      expect(inserts).toEqual([{ table, row: expect.objectContaining({ contact_id: 'c-dual', location_id: HATCH, action: 'contacted' }) }])
    })
    it(`${name}: refused (404) when not a crossover at the active studio (a probe error is the same)`, async () => {
      isCrossoverAt.mockResolvedValueOnce(false)
      const res = await POST(req(path, { contact_id: 'c-dual', action: 'contacted' }))
      expect(res.status).toBe(404)
      expect(inserts).toEqual([])
    })
  }
  it('an owned contact never needs the probe', async () => {
    CONTACT.location_id = HATCH
    try {
      const res = await churnAction(req('/api/churn-radar/action', { contact_id: 'c-dual', action: 'contacted' }))
      expect(res.status).toBe(200)
      expect(isCrossoverAt).not.toHaveBeenCalled()
    } finally { CONTACT.location_id = 'loc-still' }
  })
})

describe('crossovers that must stay home-studio only', () => {
  it("payment_reminder refuses a crossover (its billing is another studio's)", async () => {
    isCrossoverAt.mockResolvedValueOnce(true)
    const res = await churnAction(req('/api/churn-radar/action', { contact_id: 'c-dual', action: 'payment_reminder' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("Payment reminders go from the member's home studio.")
    expect(inserts).toEqual([])
  })
  it('refresh-member never accepts a crossover (404, no probe)', async () => {
    const res = await refreshMember(req('/api/churn-radar/refresh-member', { contact_id: '00000000-0000-4000-8000-000000000001' }))
    expect(res.status).toBe(404)
    expect(isCrossoverAt).not.toHaveBeenCalled()
  })
})
