// ROLESWEEP.1b — events, their check-in / branding / teams sub-routes, event
// registrations, race-day registration controls, team members and the
// comms-sender picker judge `races` (and the payee / delete role floors) at
// the event's / registration's / team's / body's / query's location, never at
// the caller's ACTIVE studio (`user.role`, `hasPermission(user, …)`).
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES, MANAGER_ROLES } from '@/lib/schemas'
import { signCheckinToken } from '@/lib/event-checkin-tokens'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases, person, keyOnAtBOnly, ORG, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as events from '@/app/api/events/route.js'
import * as eventDetail from '@/app/api/events/[id]/route.js'
import * as checkin from '@/app/api/events/[id]/checkin/route.js'
import * as checkinAll from '@/app/api/events/[id]/checkin/all/route.js'
import * as checkinScan from '@/app/api/events/[id]/checkin/scan/route.js'
import * as controlBoard from '@/app/api/events/[id]/control-board/route.js'
import * as hero from '@/app/api/events/[id]/hero/route.js'
import * as logo from '@/app/api/events/[id]/logo/route.js'
import * as qrCode from '@/app/api/events/[id]/qr-code/route.js'
import * as eventTeams from '@/app/api/events/[id]/teams/route.js'
import * as teamsExport from '@/app/api/events/[id]/teams/export/route.js'
import * as eventReg from '@/app/api/event-registrations/[id]/route.js'
import * as regCancel from '@/app/api/registrations/[id]/cancel/route.js'
import * as penalties from '@/app/api/registrations/[id]/penalties/route.js'
import * as penalty from '@/app/api/registrations/[id]/penalties/[penaltyId]/route.js'
import * as raceEdit from '@/app/api/registrations/[id]/race-edit/route.js'
import * as raceFinish from '@/app/api/registrations/[id]/race-finish/route.js'
import * as raceReset from '@/app/api/registrations/[id]/race-reset/route.js'
import * as raceStart from '@/app/api/registrations/[id]/race-start/route.js'
import * as teamMember from '@/app/api/team-members/[id]/route.js'
import * as teamMembers from '@/app/api/teams/[id]/members/route.js'
import * as sendable from '@/app/api/locations/sendable/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
// describeGate with each row's expected outcome in its title ("… (main: pass) → forbidden").
const gate = (title, spec) => describeGate(title, { ...spec, cases: spec.cases.map(([l, c, t, o]) => [`${l} → ${o}`, c, t, o]) }, T)
const json = (method, body, qs = '') => new Request(`http://localhost/api/x${qs}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const form = () => new Request('http://localhost/api/x', { method: 'POST', body: new FormData() })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]
const nested = (make) => (loc) => [{ data: make(loc), error: null }]

const EV = '5e000000-0000-4000-8000-0000000000e1'
const REG = '5e000000-0000-4000-8000-0000000000e2'
const TM = '5e000000-0000-4000-8000-0000000000e3'
const WAVE = '5e000000-0000-4000-8000-0000000000e4'
const HOST = '5e000000-0000-4000-8000-0000000000e5'
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const FORBIDDEN_PLAIN = { status: 403, body: { success: false, error: 'Forbidden' } }
const MANAGER_REQUIRED = { status: 403, body: { success: false, error: 'Manager+ required' } }
const RACES_OFF = { status: 403, body: { success: false, error: 'Races feature is disabled at this location' } }
const EVENTS_OFF = { status: 403, body: { success: false, error: 'Events feature is disabled at this location' } }
const ACCOUNT_OFF = { status: 403, body: { success: false, error: 'Races feature not enabled for your account' } }

const SECRET = 'rolesweep-test-secret'
let savedKey
beforeAll(() => { savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY; process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET })
afterAll(() => { if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey })
beforeEach(() => vi.clearAllMocks())

// ── /api/events (list + create) ───────────────────────────────────────────
const EVENT_BODY = (loc, extra = {}) => ({ location_id: loc, name: 'Open Day', race_date: '2026-10-10', waves: [{ start_time: '10:00' }], ...extra })
gate('GET /api/events?location_id= — races at the location', {
  call: (loc) => events.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: EVENTS_OFF, hidden: NOT_MEMBER, cases: permissionCases('races'),
})
// The HOST-EDIT.1 branch of GET adds the ACTIVE organisation's hosted events,
// which sit on anchor locations no staff belongs to. The active studio is the
// only judgement for them (as in events/[id]), so it needs ADMIN_ROLES and
// `races` THERE, whatever ?location_id lists. On main the active-studio
// `races` check refused the whole call; the branch must not widen that.
describe('GET /api/events?location_id= — the hosted-events branch judges races at the ACTIVE studio', () => {
  const run = async (caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe([{ data: [], error: null }]) // the listed location's events
    createServerClient.mockReturnValue(probe.db)
    const out = await runProbed(probe, () => events.GET(bare('GET', `?location_id=${LOC_B}`)))
    return { probe, ...out }
  }
  it('races off at the active studio, on at the listed one: lists B without the hosted events', async () => {
    const { probe, status, body } = await run(keyOnAtBOnly('races'))
    expect(probe.passed, `read ${probe.tripped?.table} ${JSON.stringify(probe.tripped?.chain)}`).toBe(false)
    expect(status).toBe(200)
    expect(body).toEqual({ success: true, data: [] })
  })
  it('races on at the active studio: the hosted-events read runs', async () => {
    const { probe } = await run(person({ [LOC_A]: { role: 'owner', permissions: { races: true } }, [LOC_B]: { role: 'owner', permissions: { races: true } } }, LOC_A))
    expect(probe.tripped?.table).toBe('race_events')
    expect(probe.tripped.chain).toContainEqual(['not', 'host_id', 'is', null])
  })
})
gate('POST /api/events — races at body.location_id', {
  call: (loc) => events.POST(json('POST', EVENT_BODY(loc))),
  forbidden: RACES_OFF, hidden: FORBIDDEN_PLAIN, cases: permissionCases('races'),
})
gate('POST /api/events with a payee — ADMIN_ROLES at body.location_id', {
  call: (loc) => events.POST(json('POST', EVENT_BODY(loc, { host_id: HOST }))),
  gateReads: () => [{ data: null, error: null }], // the slug-clash pre-check runs first
  forbidden: { status: 403, body: { success: false, error: 'Assigning a payment host requires manager access.' } },
  hidden: FORBIDDEN_PLAIN, cases: roleCases(ADMIN_ROLES, 'races'),
})

// ── /api/events/[id] ──────────────────────────────────────────────────────
const EVENT_ROW = row({ id: EV, name: 'Open Day', host_id: null, registrations: [], waves: [] })
gate('GET /api/events/[id] — races at the event', {
  call: () => eventDetail.GET(bare('GET'), params({ id: EV })),
  gateReads: EVENT_ROW, forbidden: RACES_OFF, hidden: NOT_FOUND, cases: permissionCases('races'),
})
gate('PUT /api/events/[id] — races at the event', {
  call: () => eventDetail.PUT(json('PUT', { name: 'Renamed' }), params({ id: EV })),
  gateReads: EVENT_ROW, forbidden: RACES_OFF, hidden: NOT_FOUND, cases: permissionCases('races'),
})
gate('PUT /api/events/[id] changing the payee — ADMIN_ROLES at the event', {
  call: () => eventDetail.PUT(json('PUT', { host_id: HOST }), params({ id: EV })),
  gateReads: EVENT_ROW,
  forbidden: { status: 403, body: { success: false, error: 'Changing the payment host requires manager access.' } },
  hidden: NOT_FOUND, cases: roleCases(ADMIN_ROLES, 'races'),
})
gate('DELETE /api/events/[id] — Manager+ at the event', {
  call: () => eventDetail.DELETE(bare('DELETE'), params({ id: EV })),
  gateReads: EVENT_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES, 'races'),
})
gate('DELETE /api/events/[id] — races at the event', {
  call: () => eventDetail.DELETE(bare('DELETE'), params({ id: EV })),
  gateReads: EVENT_ROW, forbidden: RACES_OFF, hidden: NOT_FOUND, cases: permissionCases('races'),
})

// ── /api/events/[id], the HOST-EDIT.1 host path ───────────────────────────
// A hosted event lives on its host's own anchor location, which no staff
// belongs to, so the membership check refuses everyone and hostEventOrgAccess
// is the way in: ADMIN_ROLES at the ACTIVE studio, and the event's host in the
// ACTIVE organisation. On that path `races` is judged at the active studio
// (the `guard ? user.activeLocation?.id : …` branch) and a payee change is
// not re-judged (the `!guard` short-circuit). These rows pin that.
const HOST_ANCHOR = 'c0000000-0000-4000-8000-00000000000c'
const OTHER_ORG = 'f0000000-0000-4000-8000-0000000000f1'
const HOST_2 = '5e000000-0000-4000-8000-0000000000e6'
const hostedEvent = (hostOrg) => () => [
  { data: { id: EV, name: 'Hosted Open Day', location_id: HOST_ANCHOR, host_id: HOST, registrations: [], waves: [] }, error: null },
  { data: { id: HOST, organization_id: hostOrg }, error: null }, // hostEventOrgAccess's event_hosts read
]
const orgAdmin = person({ [LOC_A]: { role: 'owner', permissions: { races: true } } }, LOC_A)
const nonAdmin = person({ [LOC_A]: { role: 'head_coach', permissions: { races: true } } }, LOC_A)
const HOST_CASES = [
  ['an org admin who does not belong to the anchor, host in the active org', orgAdmin, HOST_ANCHOR, 'pass'],
  ['races off for them at the active studio (on at another)', keyOnAtBOnly('races'), HOST_ANCHOR, 'forbidden'],
  ['a head coach (not ADMIN_ROLES) at the active studio', nonAdmin, HOST_ANCHOR, 'hidden'],
]
for (const [name, call] of [
  ['GET /api/events/[id]', () => eventDetail.GET(bare('GET'), params({ id: EV }))],
  ['PUT /api/events/[id]', () => eventDetail.PUT(json('PUT', { name: 'Renamed' }), params({ id: EV }))],
  ['PUT /api/events/[id] changing the payee', () => eventDetail.PUT(json('PUT', { host_id: HOST_2 }), params({ id: EV }))],
]) {
  gate(`${name} — a hosted event, via the host path`, {
    call, gateReads: hostedEvent(ORG), forbidden: RACES_OFF, hidden: NOT_FOUND, cases: HOST_CASES,
  })
  gate(`${name} — a hosted event whose host is in another organisation`, {
    call, gateReads: hostedEvent(OTHER_ORG), forbidden: RACES_OFF, hidden: NOT_FOUND,
    cases: [['an org admin of the active organisation', orgAdmin, HOST_ANCHOR, 'hidden']],
  })
}

// ── event sub-routes: `races` at the event ────────────────────────────────
const REG_ROW = nested((loc) => ({ id: REG, race_event_id: EV, race_events: { id: EV, location_id: loc }, teams: { id: 'team-1', team_members: [{ id: TM, name: 'Runner One', email: null, contact_id: null }] } }))
const RACE_ROW = row({ id: EV, name: 'Open Day', slug: 'open-day', kind: 'race', active: true, race_date: '2026-10-10', allowed_team_sizes: [1], waves: [{ id: WAVE }], registrations: [], location: { name: 'Studio B' } })
const SUB = [
  ['POST /api/events/[id]/checkin', () => checkin.POST(json('POST', { team_member_id: TM, race_registration_id: REG }), params({ id: EV })), REG_ROW, EVENTS_OFF],
  ['DELETE /api/events/[id]/checkin', () => checkin.DELETE(bare('DELETE', `?team_member_id=${TM}&race_registration_id=${REG}`), params({ id: EV })), REG_ROW, EVENTS_OFF],
  ['GET /api/events/[id]/checkin', () => checkin.GET(bare('GET'), params({ id: EV })), RACE_ROW, EVENTS_OFF],
  ['POST /api/events/[id]/checkin/all', () => checkinAll.POST(json('POST', { race_registration_id: REG }), params({ id: EV })), REG_ROW, EVENTS_OFF],
  ['POST /api/events/[id]/checkin/scan', () => checkinScan.POST(json('POST', { token: signCheckinToken({ eventId: EV, registrationId: REG, memberId: TM }, SECRET) }), params({ id: EV })), REG_ROW, EVENTS_OFF],
  ['GET /api/events/[id]/control-board', () => controlBoard.GET(bare('GET'), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['POST /api/events/[id]/hero', () => hero.POST(form(), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['DELETE /api/events/[id]/hero', () => hero.DELETE(bare('DELETE'), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['POST /api/events/[id]/logo', () => logo.POST(form(), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['DELETE /api/events/[id]/logo', () => logo.DELETE(bare('DELETE', '?slot=0'), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['GET /api/events/[id]/qr-code', () => qrCode.GET(bare('GET'), params({ id: EV })), RACE_ROW, EVENTS_OFF],
  ['GET /api/events/[id]/teams', () => eventTeams.GET(bare('GET'), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['POST /api/events/[id]/teams', () => eventTeams.POST(json('POST', { team_name: 'Crew', team_size: 1, wave_id: WAVE, members: [{ name: 'Runner One' }] }), params({ id: EV })), RACE_ROW, RACES_OFF],
  ['GET /api/events/[id]/teams/export', () => teamsExport.GET(bare('GET'), params({ id: EV })), RACE_ROW, RACES_OFF],
]
for (const [name, call, gateReads, forbidden] of SUB) {
  gate(`${name} — races at the event`, { call, gateReads, forbidden, hidden: NOT_FOUND, cases: permissionCases('races') })
}

// ── registrations / team members: `races` at the registration's event ─────
const REG_EVENT = nested((loc) => ({ id: REG, status: 'confirmed', race_started_at: null, race_finished_at: null, race_events: { id: EV, location_id: loc, kind: 'race' } }))
const EVENT_REG = nested((loc) => ({ id: REG, status: 'confirmed', wave_id: WAVE, race_event_id: EV, team_id: 'team-1', race: { id: EV, location_id: loc, waves: [{ id: WAVE }] } }))
const MEMBER = nested((loc) => ({ id: TM, team_id: 'team-1', name: 'Runner One', email: null, role: 'member', contact_id: null, team: { id: 'team-1', location_id: loc } }))
const REGS = [
  ['PUT /api/event-registrations/[id]', () => eventReg.PUT(json('PUT', { status: 'confirmed' }), params({ id: REG })), EVENT_REG],
  ['DELETE /api/event-registrations/[id]', () => eventReg.DELETE(bare('DELETE'), params({ id: REG })), EVENT_REG],
  ['POST /api/registrations/[id]/penalties', () => penalties.POST(json('POST', { seconds: 30, reason: 'Missed a wall ball' }), params({ id: REG })), REG_EVENT],
  ['DELETE /api/registrations/[id]/penalties/[penaltyId]', () => penalty.DELETE(bare('DELETE'), params({ id: REG, penaltyId: 'pen-1' })), REG_EVENT],
  ['PATCH /api/registrations/[id]/race-edit', () => raceEdit.PATCH(json('PATCH', { started_at: '2026-10-10T09:00:00.000Z' }), params({ id: REG })), REG_EVENT],
  ['POST /api/registrations/[id]/race-finish', () => raceFinish.POST(bare('POST'), params({ id: REG })), REG_EVENT],
  ['POST /api/registrations/[id]/race-reset', () => raceReset.POST(bare('POST'), params({ id: REG })), REG_EVENT],
  ['POST /api/registrations/[id]/race-start', () => raceStart.POST(bare('POST'), params({ id: REG })), REG_EVENT],
  ['PUT /api/team-members/[id]', () => teamMember.PUT(json('PUT', { name: 'Runner Two' }), params({ id: TM })), MEMBER],
  ['DELETE /api/team-members/[id]', () => teamMember.DELETE(bare('DELETE'), params({ id: TM })), MEMBER],
  ['POST /api/teams/[id]/members', () => teamMembers.POST(json('POST', { name: 'Runner Three' }), params({ id: 'team-1' })), row({ id: 'team-1' })],
]
for (const [name, call, gateReads] of REGS) {
  gate(`${name} — races at the registration's location`, { call, gateReads, forbidden: ACCOUNT_OFF, hidden: NOT_FOUND, cases: permissionCases('races') })
}

gate('POST /api/registrations/[id]/cancel — Manager+ at the registration', {
  call: () => regCancel.POST(bare('POST'), params({ id: REG })),
  gateReads: nested((loc) => ({ id: REG, race_events: { location_id: loc } })),
  forbidden: FORBIDDEN_PLAIN, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES),
})

// ── the comms-sender picker ───────────────────────────────────────────────
gate('GET /api/locations/sendable?event_location_id= — races at the event location', {
  call: (loc) => sendable.GET(bare('GET', `?event_location_id=${loc}`)),
  forbidden: RACES_OFF, hidden: NOT_MEMBER, cases: permissionCases('races'),
})
