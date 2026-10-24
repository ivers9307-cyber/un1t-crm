// FINDTEAM.8 (I2) — a placed solo's check-in (scan and manual) follows
// placed_into_registration_id to the team they joined and checks the person in
// on THEIR member row there; never on the dead solo row.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'
import { signCheckinToken } from '@/lib/event-checkin-tokens'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/contact-events', async (importOriginal) => ({ ...(await importOriginal()), emitEvent: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const checkin = await import('./route.js')
const scan = await import('./scan/route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const EV = 'e0000000-0000-4000-8000-000000000001'
const SOLO = 'c0000000-0000-4000-8000-000000000001'
const TEAM = 'c0000000-0000-4000-8000-000000000002'
const SOLO_M = 'd0000000-0000-4000-8000-000000000001'
const TEAM_M = 'd0000000-0000-4000-8000-000000000002'
const OTHER_M = 'd0000000-0000-4000-8000-000000000003'
const SECRET = 'find-team-checkin-secret'
const manager = (locs) => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'manager', profileRole: 'manager',
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, 'manager'])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role: 'manager', permissions: { races: true } }])),
  locations: locs.map((id) => ({ id, role: 'manager', features: { races: true } })),
})

let regs
const soloRow = (extra = {}) => ({
  id: SOLO, race_event_id: EV, status: 'placed', contact_id: 'c-sarah', placed_into_registration_id: TEAM,
  race_events: { id: EV, location_id: L1 },
  teams: { id: 't-solo', team_members: [{ id: SOLO_M, name: 'Sarah Byrne', email: 'Sarah@Example.test', contact_id: 'c-sarah' }] },
  ...extra,
})
const teamRow = (members) => ({ id: TEAM, race_event_id: EV, teams: { id: 't-team', team_members: members } })

function makeDb() {
  return fakeDb((q) => {
    if (q.table === 'race_registrations') return { data: regs[eqOf(q, 'id')] ?? null, error: null }
    return { data: null, error: null }
  })
}

let savedKey
beforeAll(() => { savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY; process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET })
afterAll(() => { if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager([L1]))
  regs = {
    [SOLO]: soloRow(),
    [TEAM]: teamRow([
      { id: OTHER_M, name: 'Ann', email: 'ann@example.test', contact_id: 'c-ann' },
      { id: TEAM_M, name: 'Sarah Byrne', email: 'sarah@example.test', contact_id: 'c-sarah' },
    ]),
  }
  db = makeDb()
})

const props = { params: Promise.resolve({ id: EV }) }
const postScan = (registrationId, memberId) => scan.POST(
  new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: signCheckinToken({ eventId: EV, registrationId, memberId }, SECRET) }) }),
  props,
)
const postManual = (race_registration_id, team_member_id) => checkin.POST(
  new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ race_registration_id, team_member_id }) }),
  props,
)
const checkins = () => db.queries.filter((x) => x.table === 'race_checkins' && x.action === 'insert')

describe.each([
  ['scan', postScan],
  ['manual', postManual],
])('%s check-in of a placed solo (FINDTEAM.8 I2)', (_label, call) => {
  it("checks in the person's member row on the TARGET team", async () => {
    const res = await call(SOLO, SOLO_M)
    expect(res.status).toBe(200)
    expect(checkins()).toHaveLength(1)
    expect(checkins()[0].payload).toMatchObject({ race_registration_id: TEAM, team_member_id: TEAM_M, contact_id: 'c-sarah', location_id: L1 })
  })

  it('falls back to a lower-cased email match when the contact differs', async () => {
    regs[TEAM] = teamRow([{ id: TEAM_M, name: 'Sarah', email: 'sarah@example.test', contact_id: 'c-other' }])
    regs[SOLO] = soloRow({ contact_id: null, teams: { id: 't-solo', team_members: [{ id: SOLO_M, name: 'Sarah', email: ' SARAH@example.test ', contact_id: null }] } })
    const res = await call(SOLO, SOLO_M)
    expect(res.status).toBe(200)
    expect(checkins()[0].payload).toMatchObject({ race_registration_id: TEAM, team_member_id: TEAM_M })
  })

  it('refuses when the person is not on the target team, and never checks in the solo row', async () => {
    regs[TEAM] = teamRow([{ id: OTHER_M, name: 'Ann', email: 'ann@example.test', contact_id: 'c-ann' }])
    const res = await call(SOLO, SOLO_M)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That person is not on this registration')
    expect(checkins()).toHaveLength(0)
  })

  it('refuses 404 when the target is on another event', async () => {
    regs[TEAM] = { ...regs[TEAM], race_event_id: 'e-other' }
    expect((await call(SOLO, SOLO_M)).status).toBe(404)
    expect(checkins()).toHaveLength(0)
  })

  it('leaves a confirmed row unchanged', async () => {
    regs[SOLO] = soloRow({ status: 'confirmed', placed_into_registration_id: null })
    const res = await call(SOLO, SOLO_M)
    expect(res.status).toBe(200)
    expect(checkins()[0].payload).toMatchObject({ race_registration_id: SOLO, team_member_id: SOLO_M })
    expect(db.queries.filter((x) => x.table === 'race_registrations')).toHaveLength(1)
  })
})

describe('manual undo of a placed solo', () => {
  it('deletes the check-in on the target team', async () => {
    const res = await checkin.DELETE(new Request(`http://localhost/api/x?team_member_id=${SOLO_M}&race_registration_id=${SOLO}`, { method: 'DELETE' }), props)
    expect(res.status).toBe(200)
    const del = db.queries.find((x) => x.table === 'race_checkins' && x.action === 'delete')
    expect(eqOf(del, 'race_registration_id')).toBe(TEAM)
    expect(eqOf(del, 'team_member_id')).toBe(TEAM_M)
  })
})
