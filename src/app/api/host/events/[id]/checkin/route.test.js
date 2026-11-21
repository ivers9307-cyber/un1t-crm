// HOSTCHECKIN.1 — the host check-in routes: own events only (404 otherwise),
// a host session required (401), cancelled/unpaid refused, and the same
// race_checkins rows as staff write (checked_in_by empty). Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb as baseFakeDb } from '@/lib/event-waitlist.test-helpers'

// The waitlist fake plus .upsert (recorded like insert).
function fakeDb(respond) {
  const db = baseFakeDb(respond)
  const from = db.from.bind(db)
  db.from = (table) => {
    const b = from(table)
    const q = db.queries[db.queries.length - 1]
    b.upsert = (payload, opts) => { q.action = 'upsert'; q.payload = payload; q.opts = opts; return b }
    return b
  }
  return db
}

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const R1 = 'a0000000-0000-4000-8000-0000000000a1'
const M1 = 'b0000000-0000-4000-8000-0000000000b1'
let session
let db
let reg
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/contact-events', () => ({ emitEvent: vi.fn(async () => {}), EVENT_TYPES: { RACE_CHECKED_IN: 'race.checked_in' } }))

const { emitEvent } = await import('@/lib/contact-events')
const { POST, DELETE } = await import('./route.js')
const { POST: ALL } = await import('./all/route.js')

const props = (id = E1) => ({ params: Promise.resolve({ id }) })
const post = (body) => new Request('https://crm.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1' } }
  reg = {
    id: R1, race_event_id: E1, status: 'confirmed', contact_id: 'c1', placed_into_registration_id: null,
    race_events: { id: E1, location_id: 'L-anchor', host_id: 'h1' },
    teams: { id: 't1', team_members: [{ id: M1, email: 'ann@example.test', contact_id: 'c1' }, { id: 'm2', email: null, contact_id: null }] },
  }
  db = fakeDb((q) => {
    if (q.table === 'race_registrations') return { data: reg, error: null }
    return { data: null, error: null }
  })
})

describe('POST /api/host/events/[id]/checkin', () => {
  it('checks one person in on the host\'s own event, with the same row staff write', async () => {
    const res = await POST(post({ team_member_id: M1, race_registration_id: R1 }), props())
    expect(res.status).toBe(200)
    const ins = db.queries.find((q) => q.table === 'race_checkins' && q.action === 'insert')
    expect(ins.payload).toEqual({ race_registration_id: R1, team_member_id: M1, contact_id: 'c1', location_id: 'L-anchor', checked_in_by: null })
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'race.checked_in', contactEmail: 'ann@example.test' }))
  })

  it('401 without a host session; 404 for another host\'s event or another event\'s entry', async () => {
    session = null
    expect((await POST(post({ team_member_id: M1, race_registration_id: R1 }), props())).status).toBe(401)
    session = { host: { id: 'h2' } }
    expect((await POST(post({ team_member_id: M1, race_registration_id: R1 }), props())).status).toBe(404)
    session = { host: { id: 'h1' } }
    reg.race_event_id = 'e-other'
    expect((await POST(post({ team_member_id: M1, race_registration_id: R1 }), props())).status).toBe(404)
    expect(db.queries.some((q) => q.table === 'race_checkins')).toBe(false)
  })

  it('refuses a cancelled or unpaid entry with 409', async () => {
    reg.status = 'pending_payment'
    const res = await POST(post({ team_member_id: M1, race_registration_id: R1 }), props())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_checkable')
  })

  it('a re-tap (unique violation) is a clean no-op', async () => {
    db = fakeDb((q) => {
      if (q.table === 'race_registrations') return { data: reg, error: null }
      if (q.table === 'race_checkins') return { data: null, error: { message: 'duplicate key value violates unique constraint' } }
      return { data: null, error: null }
    })
    expect((await POST(post({ team_member_id: M1, race_registration_id: R1 }), props())).status).toBe(200)
  })
})

describe('DELETE /api/host/events/[id]/checkin', () => {
  it('undoes on the host\'s own event, and 404s another host\'s', async () => {
    const url = `https://crm.test/x?team_member_id=${M1}&race_registration_id=${R1}`
    expect((await DELETE(new Request(url, { method: 'DELETE' }), props())).status).toBe(200)
    const del = db.queries.find((q) => q.table === 'race_checkins' && q.action === 'delete')
    expect(del.ops).toContainEqual(['eq', 'race_registration_id', R1])
    expect(del.ops).toContainEqual(['eq', 'team_member_id', M1])
    session = { host: { id: 'h2' } }
    expect((await DELETE(new Request(url, { method: 'DELETE' }), props())).status).toBe(404)
    expect((await DELETE(new Request('https://crm.test/x', { method: 'DELETE' }), props())).status).toBe(400)
  })
})

describe('POST /api/host/events/[id]/checkin/all', () => {
  it('checks in everyone on the entry, own events only', async () => {
    const res = await ALL(post({ race_registration_id: R1 }), props())
    expect(res.status).toBe(200)
    expect((await res.json()).data.checked_in).toBe(2)
    const up = db.queries.find((q) => q.table === 'race_checkins' && q.action === 'upsert')
    expect(up.payload.map((r) => [r.team_member_id, r.checked_in_by, r.location_id])).toEqual([[M1, null, 'L-anchor'], ['m2', null, 'L-anchor']])
    expect(up.opts).toEqual({ onConflict: 'race_registration_id,team_member_id', ignoreDuplicates: true })
    session = { host: { id: 'h2' } }
    expect((await ALL(post({ race_registration_id: R1 }), props())).status).toBe(404)
  })

  it('refuses a cancelled entry', async () => {
    reg.status = 'cancelled'
    expect((await ALL(post({ race_registration_id: R1 }), props())).status).toBe(409)
  })
})
