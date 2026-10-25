// ROLESWEEP.1b — booking cancellation and event-type reminders judge
// MANAGER_ROLES at the booking's / event type's location, sale-offer
// fulfilment judges `approvals_offer_purchases` at the purchase, and ending a
// live session no longer pre-refuses a coach whose ACTIVE studio is another
// one (guardLiveSession already judged the session's studio).
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { describeGate } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases, person, MASTER, OUTSIDER, ORG, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as bookingCancel from '@/app/api/bookings/[id]/cancel/route.js'
import * as reminders from '@/app/api/bookings/event-types/[id]/reminders/route.js'
import * as fulfil from '@/app/api/offer-purchases/[id]/fulfil/route.js'
import * as sendConfirmation from '@/app/api/offer-purchases/[id]/send-confirmation/route.js'
import * as liveEnd from '@/app/api/live/sessions/[id]/end/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
// describeGate with each row's expected outcome in its title ("… (main: pass) → forbidden").
const gate = (title, spec) => describeGate(title, { ...spec, cases: spec.cases.map(([l, c, t, o]) => [`${l} → ${o}`, c, t, o]) }, T)
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method) => new Request('http://localhost/api/x', { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const FORBIDDEN_PLAIN = { status: 403, body: { success: false, error: 'Forbidden' } }

beforeEach(() => vi.clearAllMocks())

// ── bookings ──────────────────────────────────────────────────────────────
gate('POST /api/bookings/[id]/cancel — Manager+ at the booking', {
  call: () => bookingCancel.POST(json('POST', {}), params({ id: 'bk-1' })),
  gateReads: row({ id: 'bk-1', status: 'confirmed', customer_name: 'Pat', customer_email: null, booking_date: '2026-10-10', start_time: '09:00', end_time: '10:00', event_types: null, contacts: null }),
  forbidden: { status: 403, body: { success: false, error: 'Unauthorized' } },
  hidden: { status: 403, body: { success: false, error: 'Forbidden — not your location' } },
  cases: roleCases(MANAGER_ROLES),
})

// GET: the role refusal and the non-member refusal are the same 403 (both
// always were); the rows still pin WHO gets it. PUT's role refusal is its
// pre-check's 'Unauthorized', judged at the event type once it is loaded.
const ET_ROW = row({ id: 'et-1' })
gate('GET /api/bookings/event-types/[id]/reminders — Manager+ at the event type', {
  call: () => reminders.GET(bare('GET'), params({ id: 'et-1' })),
  gateReads: ET_ROW, forbidden: FORBIDDEN_PLAIN, hidden: FORBIDDEN_PLAIN, cases: roleCases(MANAGER_ROLES),
})
gate('PUT /api/bookings/event-types/[id]/reminders — Manager+ at the event type', {
  call: () => reminders.PUT(json('PUT', { reminders: [] }), params({ id: 'et-1' })),
  gateReads: ET_ROW, forbidden: { status: 403, body: { success: false, error: 'Unauthorized' } }, hidden: FORBIDDEN_PLAIN, cases: roleCases(MANAGER_ROLES),
})

// ── offer purchases ───────────────────────────────────────────────────────
// approvals_* keys ignore a per-key feature toggle; their location-level gate
// is the owning category's bundle (Money). So the "feature off at A" rows
// switch bundle_money off at A instead of the key itself.
const KEY = 'approvals_offer_purchases'
const moneyOffAtA = person({ [LOC_A]: { role: 'owner', permissions: { [KEY]: true }, features: { bundle_money: false } }, [LOC_B]: { role: 'owner', permissions: { [KEY]: true } } }, LOC_A)
const masterMoneyOffAtA = {
  ...MASTER,
  locations: [{ id: LOC_A, organization_id: ORG, active: true, features: { bundle_money: false } }, { id: LOC_B, organization_id: ORG, active: true, features: {} }],
  activeLocation: { id: LOC_A, organization_id: ORG, active: true, features: { bundle_money: false } },
}
const approvalCases = [
  ...permissionCases(KEY).filter(([label]) => !label.includes('feature')),
  ["bundle_money off at A's location, A active (main: forbidden)", moneyOffAtA, LOC_B, 'pass'],
  ['a master with bundle_money off at the active location (main: forbidden)', masterMoneyOffAtA, LOC_B, 'pass'],
]
const PURCHASE = row({ id: 'op-1', state: 'paid', fulfilled_at: null, contact_id: null, buyer_name: 'Pat', buyer_email: 'pat@example.com', amount_cents: 5000, offer: { name: 'Intro', bonus_headline: null, category: 'intro' } })
gate(`POST /api/offer-purchases/[id]/fulfil — ${KEY} at the purchase`, {
  call: () => fulfil.POST(bare('POST'), params({ id: 'op-1' })),
  gateReads: PURCHASE, forbidden: FORBIDDEN_PLAIN, hidden: NOT_FOUND, cases: approvalCases,
})
gate(`POST /api/offer-purchases/[id]/send-confirmation — ${KEY} at the purchase`, {
  call: () => sendConfirmation.POST(bare('POST'), params({ id: 'op-1' })),
  gateReads: PURCHASE, forbidden: FORBIDDEN_PLAIN, hidden: NOT_FOUND, cases: approvalCases,
})

// ── live session end ──────────────────────────────────────────────────────
// Too closed only: guardLiveSession already judged the role at the session's
// studio, so the only change is the pre-lookup "coach anywhere" check.
const coach = (roleA, roleB, active) => person({ [LOC_A]: { role: roleA, permissions: { studio_management: true } }, [LOC_B]: { role: roleB, permissions: { studio_management: true } } }, active)
gate('POST /api/live/sessions/[id]/end — a coach role at the session', {
  call: () => liveEnd.POST(bare('POST'), params({ id: 'hrs-1' })),
  gateReads: (loc) => [{ data: { id: 'hrs-1', location_id: loc }, error: null }],
  forbidden: { status: 403, body: { ok: false, error: 'Coach only' } },
  hidden: { status: 404, body: { ok: false, error: 'Session not found' } },
  cases: [
    ['staff at A, manager at B, A active (main: forbidden)', coach('staff', 'manager', LOC_A), LOC_B, 'pass'],
    ['staff at A, owner at B, A active (main: forbidden)', coach('staff', 'owner', LOC_A), LOC_B, 'pass'],
    ['staff at A, head coach at B, A active (main: forbidden)', coach('staff', 'head_coach', LOC_A), LOC_B, 'pass'],
    ['manager at A with B active, target A (main: forbidden)', coach('manager', 'staff', LOC_B), LOC_A, 'pass'],
    ['manager at A, staff at B, A active (main: hidden — guardLiveSession)', coach('manager', 'staff', LOC_A), LOC_B, 'hidden'],
    ['staff at both studios (main: forbidden)', coach('staff', 'staff', LOC_A), LOC_B, 'forbidden'],
    ['a master', MASTER, LOC_B, 'pass'],
    ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
  ],
})
