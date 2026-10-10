// ROLESWEEP.2 — the four routes behind requireApiKeyOrManager (src/lib/api-auth.js)
// judge the cookie caller's role at the location they act on, never at the
// caller's ACTIVE studio. The helper's cookie branch is now a COARSE pre-check
// (Manager+ somewhere); each route decides at the target after its membership
// check. The per-org unitk_ key path never reaches getCurrentUser
// (src/lib/api-auth.test.js); the retired shared key is no credential at all
// (APIKEYS.4) and is refused below.
// Harness: tests/helpers/role-gate-probe.js (a refused caller never reaches a
// DB/network call past the gate reads; an allowed one gets past the gate).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import {
  roleCases, person, LOC_A, LOC_B, MASTER, MANAGER_A_STAFF_B, STAFF_A_MANAGER_B,
} from '../helpers/role-sweep-callers.js'
import * as contact from '@/app/api/contacts/[id]/route.js'
import * as contacts from '@/app/api/contacts/route.js'
import * as stages from '@/app/api/stages/route.js'
import * as eventType from '@/app/api/bookings/event-types/[id]/route.js'
import * as eventTypes from '@/app/api/bookings/event-types/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const RETIRED_SHARED_KEY = 'a'.repeat(64)
const json = (method, body, headers = {}) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const get = (qs = '', headers = {}) => new Request(`http://localhost/api/x${qs ? `?${qs}` : ''}`, { headers })
const bare = (method) => new Request('http://localhost/api/x', { method })
const idParams = (id) => ({ params: Promise.resolve({ id }) })

const CONTACT_ID = 'c0000000-0000-4000-8000-0000000000c1'
const EVENT_TYPE_ID = 'e0000000-0000-4000-8000-0000000000e1'

// The shared helper's refusal: nobody is Manager+ anywhere.
const UNAUTHORIZED = { status: 401, body: { success: false, error: 'Unauthorized' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const STAFF_BOTH = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff' } }, LOC_A)
// Every roleCases row, plus "Manager+ nowhere", which the helper refuses.
const CASES = [
  ...roleCases(MANAGER_ROLES),
  ['staff at both studios (main: unauth)', STAFF_BOTH, LOC_B, 'unauth'],
]

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllEnvs())

// ── PUT /api/contacts/[id]: the contact's location (detail route → 404) ────
const CONTACT_ROW = (loc) => [{ data: { tags: [], location_id: loc, email: 'member.one@example.com', email_status: 'active', glofox_member_id: null }, error: null }]
const PUT_NOT_FOUND = { status: 404, body: { success: false, error: 'not_found' } }
describeGate('PUT /api/contacts/[id] (MANAGER_ROLES at the contact)', {
  call: () => contact.PUT(json('PUT', { label: 'VIP' }), idParams(CONTACT_ID)),
  gateReads: CONTACT_ROW,
  forbidden: PUT_NOT_FOUND, hidden: PUT_NOT_FOUND, unauth: UNAUTHORIZED,
  cases: CASES,
}, T)

// ── POST /api/contacts: the body's location, else the active one ──────────
const NEW_CONTACT = (loc) => ({ name: 'Member One', email: 'member.one@example.com', ...(loc ? { location_id: loc } : {}) })
describeGate('POST /api/contacts (MANAGER_ROLES at body.location_id)', {
  call: (loc) => contacts.POST(json('POST', NEW_CONTACT(loc))),
  forbidden: UNAUTHORIZED, hidden: NOT_MEMBER, unauth: UNAUTHORIZED,
  cases: CASES,
}, T)

describe('POST /api/contacts — no location_id in the body', () => {
  const run = async (caller, body) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe()
    createServerClient.mockReturnValue(probe.db)
    const out = await runProbed(probe, () => contacts.POST(json('POST', body)))
    return { probe, ...out }
  }

  it('defaults to the active studio and is judged there (manager at A, A active → created at A)', async () => {
    const { probe } = await run(MANAGER_A_STAFF_B, NEW_CONTACT(null))
    expect(probe.passed).toBe(true)
    const insert = probe.tripped.chain.find((c) => c[0] === 'insert')
    expect(insert[1].location_id).toBe(LOC_A)
  })

  it('defaults to the active studio and is judged there (staff at A, A active → refused, never created at B)', async () => {
    const { probe, status, body } = await run(STAFF_A_MANAGER_B, NEW_CONTACT(null))
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(UNAUTHORIZED)
  })

  it('a cookie caller with no location at all is refused (400), never a location-less contact', async () => {
    const { probe, status, body } = await run({ ...MANAGER_A_STAFF_B, activeLocation: null }, NEW_CONTACT(null))
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual({ status: 400, body: { success: false, error: 'location_id required' } })
  })
})

// ── GET /api/stages ────────────────────────────────────────────────────────
describeGate('GET /api/stages?location_id= (MANAGER_ROLES at the location)', {
  call: (loc) => stages.GET(get(`location_id=${loc}`)),
  forbidden: UNAUTHORIZED, hidden: NOT_MEMBER, unauth: UNAUTHORIZED,
  cases: CASES,
}, T)

describe('GET /api/stages with no location_id lists only the studios where the caller is Manager+', () => {
  const listed = async (caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe()
    createServerClient.mockReturnValue(probe.db)
    await runProbed(probe, () => stages.GET(get()))
    expect(probe.passed, 'refused').toBe(true)
    return probe.tripped.chain.find((c) => c[0] === 'in' && c[1] === 'location_id')?.[2]
  }

  it('staff at A (active), manager at B → B only (main: refused)', async () => {
    expect(await listed(STAFF_A_MANAGER_B)).toEqual([LOC_B])
  })
  it('manager at A (active), staff at B → A only (main: A and B)', async () => {
    expect(await listed(MANAGER_A_STAFF_B)).toEqual([LOC_A])
  })
  it('a master → every location they can see', async () => {
    expect(await listed(MASTER)).toEqual([LOC_A, LOC_B])
  })
})

// ── GET/PUT/DELETE /api/bookings/event-types/[id]: the row's location ─────
const EVENT_TYPE_ROW = (loc) => [{ data: { id: EVENT_TYPE_ID, location_id: loc }, error: null }]
const ET_NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
describeGate('GET /api/bookings/event-types/[id] (MANAGER_ROLES at the event type)', {
  call: () => eventType.GET(bare('GET'), idParams(EVENT_TYPE_ID)),
  gateReads: EVENT_TYPE_ROW, forbidden: ET_NOT_FOUND, hidden: ET_NOT_FOUND, unauth: UNAUTHORIZED, cases: CASES,
}, T)
describeGate('PUT /api/bookings/event-types/[id] (MANAGER_ROLES at the event type)', {
  call: () => eventType.PUT(json('PUT', { name: 'Consult' }), idParams(EVENT_TYPE_ID)),
  gateReads: EVENT_TYPE_ROW, forbidden: ET_NOT_FOUND, hidden: ET_NOT_FOUND, unauth: UNAUTHORIZED, cases: CASES,
}, T)
describeGate('DELETE /api/bookings/event-types/[id] (MANAGER_ROLES at the event type)', {
  call: () => eventType.DELETE(bare('DELETE'), idParams(EVENT_TYPE_ID)),
  gateReads: EVENT_TYPE_ROW, forbidden: ET_NOT_FOUND, hidden: ET_NOT_FOUND, unauth: UNAUTHORIZED, cases: CASES,
}, T)

describe('event-types/[id]: a missing or unreadable row is never let through', () => {
  const run = async (answer) => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const probe = gateProbe([answer])
    createServerClient.mockReturnValue(probe.db)
    const out = await runProbed(probe, () => eventType.PUT(json('PUT', { name: 'Consult' }), idParams(EVENT_TYPE_ID)))
    return { probe, ...out }
  }
  it('no such id → 404 Not found, nothing written', async () => {
    const { probe, status, body } = await run({ data: null, error: null })
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(ET_NOT_FOUND)
  })
  it('a failed read → 500, nothing written (main: fell through to the write)', async () => {
    const { probe, status, body } = await run({ data: null, error: { message: 'boom' } })
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual({ status: 500, body: { success: false, error: 'Could not load event type' } })
  })
})

// ── POST /api/bookings/event-types: the body's location (EVENTTYPERLS.1) ──
// Main: API-key only, every cookie caller 401 — the form created through RLS
// instead, which let any member of the studio do it.
describeGate('POST /api/bookings/event-types (MANAGER_ROLES at body.location_id)', {
  call: (loc) => eventTypes.POST(json('POST', { name: 'Consult', location_id: loc })),
  forbidden: UNAUTHORIZED, hidden: NOT_MEMBER, unauth: UNAUTHORIZED, cases: CASES,
}, T)

// ── APIKEYS.4: the retired shared key is no credential ─────────────────────
// The shared integration key's branch was removed, so the old key is
// just an unrecognised Bearer: the helper falls through to the cookie branch,
// finds no session, and the route answers 401 before reading anything.
describe('the retired shared integration key is refused (401)', () => {
  const auth = { authorization: `Bearer ${RETIRED_SHARED_KEY}` }
  it.each([
    ['PUT /api/contacts/[id]', () => contact.PUT(json('PUT', { label: 'VIP' }, auth), idParams(CONTACT_ID))],
    ['POST /api/contacts', () => contacts.POST(json('POST', NEW_CONTACT(LOC_B), auth))],
    ['GET /api/stages', () => stages.GET(get(`location_id=${LOC_B}`, auth))],
    ['GET /api/bookings/event-types/[id]', () => eventType.GET(new Request('http://localhost/api/x', { headers: auth }), idParams(EVENT_TYPE_ID))],
  ])('%s', async (_label, call) => {
    getCurrentUser.mockResolvedValue(null)
    const probe = gateProbe([])
    createServerClient.mockReturnValue(probe.db)
    const { status } = await runProbed(probe, call)
    expect(status).toBe(401)
    expect(probe.passed).toBe(false)
  })
})
