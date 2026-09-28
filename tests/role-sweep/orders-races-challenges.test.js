// ROLESWEEP.1b — orders, races and challenges judge Manager+ and their
// feature key (`orders` / `races` / `challenges`) at the order's / race's /
// challenge's / body's / query's location, never at the caller's ACTIVE
// studio (`user.role`, `hasPermission(user, …)`). The list GETs narrow
// "every location I belong to" to the ones where the caller passes THERE.
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
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases, keyOffAtB, MANAGER_A_STAFF_B, LOC_A } from '../helpers/role-sweep-callers.js'
import * as orderDetail from '@/app/api/orders/[id]/route.js'
import * as orderCancel from '@/app/api/orders/[id]/cancel/route.js'
import * as orderRefund from '@/app/api/orders/[id]/refund/route.js'
import * as races from '@/app/api/races/route.js'
import * as raceDetail from '@/app/api/races/[id]/route.js'
import * as raceTeams from '@/app/api/races/[id]/teams/route.js'
import * as racesToday from '@/app/api/races/today/route.js'
import * as challenges from '@/app/api/challenges/route.js'
import * as challengeDetail from '@/app/api/challenges/[id]/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
// describeGate with each row's expected outcome in its title ("… (main: pass) → forbidden").
const gate = (title, spec) => describeGate(title, { ...spec, cases: spec.cases.map(([l, c, t, o]) => [`${l} → ${o}`, c, t, o]) }, T)
const json = (method, body, qs = '') => new Request(`http://localhost/api/x${qs}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]

const WAVE = '5e000000-0000-4000-8000-0000000000a1'
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const FORBIDDEN_PLAIN = { status: 403, body: { success: false, error: 'Forbidden' } }
const MANAGER_REQUIRED = { status: 403, body: { success: false, error: 'Manager+ required' } }
const ORDERS_OFF = { status: 403, body: { success: false, error: 'Orders feature is disabled at this location' } }
const RACES_OFF = { status: 403, body: { success: false, error: 'Races feature is disabled at this location' } }
const CHALLENGES_OFF = { status: 403, body: { success: false, error: 'Challenges feature is disabled at this location' } }

beforeEach(() => vi.clearAllMocks())

// ── orders ────────────────────────────────────────────────────────────────
const ORDER_ROW = row({ id: 'ord-1', status: 'pending', amount_cents: 1000, currency: 'EUR', created_at: '2026-09-01T10:00:00Z', contact_email: 'buyer@example.com', source_type: 'race_registration', source_id: 'src-1', payment_provider: 'revolut' })
for (const [name, call] of [
  ['GET /api/orders/[id]', () => orderDetail.GET(bare('GET'), params({ id: 'ord-1' }))],
  ['POST /api/orders/[id]/cancel', () => orderCancel.POST(json('POST', {}), params({ id: 'ord-1' }))],
  ['POST /api/orders/[id]/refund', () => orderRefund.POST(json('POST', {}), params({ id: 'ord-1' }))],
]) {
  gate(`${name} — Manager+ at the order`, {
    call, gateReads: ORDER_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES, 'orders'),
  })
  gate(`${name} — orders at the order`, {
    call, gateReads: ORDER_ROW, forbidden: ORDERS_OFF, hidden: NOT_FOUND, cases: permissionCases('orders'),
  })
}

// ── races ─────────────────────────────────────────────────────────────────
const RACE_BODY = (loc) => ({ location_id: loc, name: 'Autumn Race', race_date: '2026-10-10', waves: [{ start_time: '09:00' }] })
for (const [name, call, hidden] of [
  ['GET /api/races?location_id=', (loc) => races.GET(bare('GET', `?location_id=${loc}`)), FORBIDDEN_PLAIN],
  ['POST /api/races', (loc) => races.POST(json('POST', RACE_BODY(loc))), FORBIDDEN_PLAIN],
]) {
  gate(`${name} — Manager+ at the location`, { call, forbidden: MANAGER_REQUIRED, hidden, cases: roleCases(MANAGER_ROLES, 'races') })
  gate(`${name} — races at the location`, { call, forbidden: RACES_OFF, hidden, cases: permissionCases('races') })
}

describe('GET /api/races (no location_id) lists only locations where the caller passes both halves', () => {
  for (const [label, caller] of [
    ['drops B where they are staff (main listed A and B)', MANAGER_A_STAFF_B],
    ['drops B where races is switched off for them (main listed A and B)', keyOffAtB('races')],
  ]) {
    it(label, async () => {
      getCurrentUser.mockResolvedValue(caller)
      const probe = gateProbe([])
      createServerClient.mockReturnValue(probe.db)
      await runProbed(probe, () => races.GET(bare('GET')))
      expect(probe.tripped.table).toBe('race_events')
      expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_A]])
    })
  }
})

const RACE_ROW = row({ id: 'race-1', name: 'Autumn Race', allowed_team_sizes: [1], waves: [{ id: WAVE }], registrations: [] })
for (const [name, call] of [
  ['GET /api/races/[id]', () => raceDetail.GET(bare('GET'), params({ id: 'race-1' }))],
  ['PUT /api/races/[id]', () => raceDetail.PUT(json('PUT', { name: 'Renamed' }), params({ id: 'race-1' }))],
  ['DELETE /api/races/[id]', () => raceDetail.DELETE(bare('DELETE'), params({ id: 'race-1' }))],
  ['GET /api/races/[id]/teams', () => raceTeams.GET(bare('GET'), params({ id: 'race-1' }))],
  ['POST /api/races/[id]/teams', () => raceTeams.POST(json('POST', { team_name: 'Crew', team_size: 1, wave_id: WAVE, members: [{ name: 'Runner One' }] }), params({ id: 'race-1' }))],
]) {
  gate(`${name} — Manager+ at the race`, { call, gateReads: RACE_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES, 'races') })
  gate(`${name} — races at the race`, { call, gateReads: RACE_ROW, forbidden: RACES_OFF, hidden: NOT_FOUND, cases: permissionCases('races') })
}

// races/today re-judged the target already (hasPermissionForLocation); only
// its pre-check read the active studio, so it was too closed, never too open.
const alreadyJudged = (cases) => cases.map(([l, c, t, o]) => [l.replace('(main: pass)', '(main: forbidden — the target check already ran)'), c, t, o])
gate('GET /api/races/today?location_id= — races pre-check at any location', {
  call: (loc) => racesToday.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: RACES_OFF, hidden: NOT_FOUND, cases: alreadyJudged(permissionCases('races')),
})

// ── challenges ────────────────────────────────────────────────────────────
const CH_BODY = (loc) => ({ location_id: loc, name: 'October Classes', mode: 'individual', metric: 'classes', starts_on: '2026-10-01', ends_on: '2026-10-31' })
for (const [name, call] of [
  ['GET /api/challenges?location_id=', (loc) => challenges.GET(bare('GET', `?location_id=${loc}`))],
  ['POST /api/challenges', (loc) => challenges.POST(json('POST', CH_BODY(loc)))],
]) {
  gate(`${name} — Manager+ at the location`, { call, forbidden: MANAGER_REQUIRED, hidden: FORBIDDEN_PLAIN, cases: roleCases(MANAGER_ROLES, 'challenges') })
  gate(`${name} — challenges at the location`, { call, forbidden: CHALLENGES_OFF, hidden: FORBIDDEN_PLAIN, cases: permissionCases('challenges') })
}

describe('GET /api/challenges (no location_id) lists only locations where the caller passes both halves', () => {
  for (const [label, caller] of [
    ['drops B where they are staff (main listed A and B)', MANAGER_A_STAFF_B],
    ['drops B where challenges is switched off for them (main listed A and B)', keyOffAtB('challenges')],
  ]) {
    it(label, async () => {
      getCurrentUser.mockResolvedValue(caller)
      const probe = gateProbe([])
      createServerClient.mockReturnValue(probe.db)
      await runProbed(probe, () => challenges.GET(bare('GET')))
      expect(probe.tripped.table).toBe('challenges')
      expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_A]])
    })
  }
})

const CH_ROW = row({ id: 'ch-1', name: 'October Classes', mode: 'individual', metric: 'classes', starts_on: '2099-10-01', ends_on: '2099-10-31', target: null, is_flagship: false })
for (const [name, call] of [
  ['PUT /api/challenges/[id]', () => challengeDetail.PUT(json('PUT', { name: 'Renamed' }), params({ id: 'ch-1' }))],
  ['DELETE /api/challenges/[id]', () => challengeDetail.DELETE(bare('DELETE'), params({ id: 'ch-1' }))],
]) {
  gate(`${name} — Manager+ at the challenge`, { call, gateReads: CH_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES, 'challenges') })
  gate(`${name} — challenges at the challenge`, { call, gateReads: CH_ROW, forbidden: { status: 403, body: { success: false, error: 'Disabled' } }, hidden: NOT_FOUND, cases: permissionCases('challenges') })
}
