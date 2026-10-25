// ROLESWEEP.1c — staff management, the audit log and the password override
// judge "owner" / ADMIN_ROLES at the location acted on (the new assignment's,
// the target staffer's, the member's), never at the caller's ACTIVE studio.
// staff POST / PUT / DELETE were too CLOSED only (their later checks were
// already per location): an owner at B whose active studio is A was refused.
// Also: a characterisation of schedule/contractor-spend's membership gate
// (SAFE-but-tidy; same answers before and after).
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
// password-override: the rate limiter reads the db BEFORE the gate, and the
// admin client is built from env AFTER it (reaching it = past the gate).
// runProbed stubs global fetch as its tripwire for the call; touching it here
// marks the probe `passed` (the harness counts 'pass' only on the tripwire or
// a non-refusal status), then PastGate stops the route.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true }),
  rateLimitResponse: () => null,
  getClientIp: () => null,
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    globalThis.fetch('supabase-admin:createClient').catch(() => {})
    const e = new Error('PastGate: createClient'); e.name = 'PastGate'; throw e
  },
}))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { person, roleCases, MASTER, OUTSIDER, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import { ownerCases } from '../helpers/role-sweep-callers-c.js'
import * as staff from '@/app/api/staff/route.js'
import * as staffMember from '@/app/api/staff/[id]/route.js'
import * as sendReset from '@/app/api/staff/[id]/send-password-reset/route.js'
import * as auditLog from '@/app/api/admin/audit-log/route.js'
import * as pwOverride from '@/app/api/admin/password-override/route.js'
import * as contractorSpend from '@/app/api/schedule/contractor-spend/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const two = (roleA, roleB, active) => person({ [LOC_A]: { role: roleA }, [LOC_B]: { role: roleB } }, active)
const STAFFER = 'c0000000-0000-4000-8000-0000000000aa'
const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'

beforeEach(() => vi.clearAllMocks())

// ── staff POST: owner SOMEWHERE, then owner AT each assignment's location ──
const OWNER_SOMEWHERE = { status: 403, body: { success: false, error: 'Forbidden — must be an owner at this location (or a master) to create staff' } }
const NOT_OWNER_THERE = { status: 403, body: { success: false, error: 'You can only assign staff at locations where you are an owner.' } }
describeGate('POST /api/staff (assignment location)', {
  call: (loc) => staff.POST(json('POST', { email: 'new.coach@example.com', full_name: 'New Coach', assignments: [{ location_id: loc, role: 'staff' }] })),
  forbidden: OWNER_SOMEWHERE, hidden: NOT_OWNER_THERE,
  cases: [
    ['staff at A, owner at B, A active, assigns at B (main: forbidden)', two('staff', 'owner', LOC_A), LOC_B, 'pass'],
    ['owner at A with B active, assigns at A (main: forbidden)', two('owner', 'staff', LOC_B), LOC_A, 'pass'],
    ['owner at A, staff at B, A active, assigns at A', two('owner', 'staff', LOC_A), LOC_A, 'pass'],
    ['owner at A, staff at B, A active, assigns at B', two('owner', 'staff', LOC_A), LOC_B, 'hidden'],
    ['manager at A and at B', two('manager', 'manager', LOC_A), LOC_B, 'forbidden'],
    ['a master', MASTER, LOC_B, 'pass'],
  ],
}, T)

// ── staff/[id] PUT / DELETE: the target staffer's locations ───────────────
const stafferAt = (loc) => [{ data: { id: STAFFER, role: 'staff', active: true, deleted_at: null, full_name: 'Coach Two', profile_locations: [{ location_id: loc, role: 'staff' }] }, error: null }]
const staffEditCases = (verb) => [
  ['staff at A, owner at B, A active, target at B (main: forbidden)', two('staff', 'owner', LOC_A), LOC_B, 'pass'],
  ['owner at A with B active, target at A (main: forbidden)', two('owner', 'staff', LOC_B), LOC_A, 'pass'],
  [`owner at A, staff at B, A active, target at B`, two('owner', 'staff', LOC_A), LOC_B, 'hidden'],
  ['manager at A and at B', two('manager', 'manager', LOC_A), LOC_B, 'forbidden'],
  ['a master', MASTER, LOC_B, 'pass'],
].map(([l, c, t, o]) => [`${verb}: ${l}`, c, t, o])
describeGate('PUT /api/staff/[id]', {
  call: () => staffMember.PUT(json('PUT', { full_name: 'Coach Two' }), params({ id: STAFFER })),
  gateReads: stafferAt,
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — must be an owner at this location (or a master) to edit staff' } },
  hidden: { status: 403, body: { success: false, error: 'Owners cannot edit other owners. Ask a master to make this change.' } },
  cases: staffEditCases('edit'),
}, T)
describeGate('DELETE /api/staff/[id]', {
  call: () => staffMember.DELETE(bare('DELETE'), params({ id: STAFFER })),
  gateReads: stafferAt,
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — must be an owner at this location (or a master) to deactivate staff' } },
  hidden: { status: 403, body: { success: false, error: 'You can only deactivate staff assigned to a location where you are an owner.' } },
  cases: staffEditCases('deactivate'),
}, T)

// ── send-password-reset: ADMIN_ROLES; the overlap counts admin locations only
// A caller who is an admin somewhere but not at the staffer's studio gets the
// route's non-member answer (404), as a non-member does.
const holdsAdmin = (c) => c.isMaster || Object.values(c.rolesByLocation || {}).some((r) => ADMIN_ROLES.includes(r))
describeGate('POST /api/staff/[id]/send-password-reset', {
  call: () => sendReset.POST(bare('POST'), params({ id: STAFFER })),
  // active: false — past the gate the route answers 409 (reactivate first)
  // before it reaches db.auth.resetPasswordForEmail, which the probe's auth
  // tripwire does not model; a 409 is neither refusal, so it reads as 'pass'.
  gateReads: (loc) => [{ data: { id: STAFFER, email: 'coach.two@example.com', full_name: 'Coach Two', active: false, profile_locations: [{ location_id: loc }] }, error: null }],
  forbidden: { status: 403, body: { success: false, error: 'Admin only' } },
  hidden: { status: 404, body: { success: false, error: 'Staff member not found' } },
  cases: roleCases(ADMIN_ROLES).map(([l, c, t, o]) => [l, c, t, o === 'forbidden' && holdsAdmin(c) ? 'hidden' : o]),
}, T)

// ── audit log: owner SOMEWHERE, scoped to the owner locations ─────────────
describe('GET /api/admin/audit-log — scoped to the locations where the caller is owner', () => {
  const run = async (caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe([])
    createServerClient.mockReturnValue(probe.db)
    const out = await runProbed(probe, () => auditLog.GET(bare('GET')))
    return { probe, ...out }
  }
  it('owner at A, staff at B, A active: A only (main: A and B)', async () => {
    const { probe } = await run(two('owner', 'staff', LOC_A))
    expect(probe.tripped.table).toBe('audit_events')
    expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_A]])
  })
  it('staff at A, owner at B, A active: B only (main: forbidden)', async () => {
    const { probe } = await run(two('staff', 'owner', LOC_A))
    expect(probe.passed).toBe(true)
    expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_B]])
  })
  it('manager at A and at B: refused', async () => {
    const { probe, status, body } = await run(two('manager', 'manager', LOC_A))
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual({ status: 403, body: { success: false, error: 'Master or owner only' } })
  })
  it('a master: unscoped', async () => {
    const { probe } = await run(MASTER)
    expect(probe.passed).toBe(true)
    expect(probe.tripped.chain.some(([m, col]) => m === 'in' && col === 'location_id')).toBe(false)
  })
})

// ── password override ─────────────────────────────────────────────────────
const PW_FORBIDDEN = { status: 403, body: { success: false, error: 'forbidden' } }
describeGate('POST /api/admin/password-override {targetType: member} (owner at the member\'s location)', {
  call: () => pwOverride.POST(json('POST', { targetType: 'member', targetId: CONTACT_ID, generateRandom: true })),
  gateReads: (loc) => [{ data: { id: CONTACT_ID, user_id: 'auth-9', location_id: loc, name: 'Member One' }, error: null }],
  forbidden: PW_FORBIDDEN,
  hidden: { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } },
  cases: ownerCases(),
}, T)
describeGate('POST /api/admin/password-override {targetType: staff} (owner at the staffer\'s location)', {
  call: () => pwOverride.POST(json('POST', { targetType: 'staff', targetId: STAFFER, generateRandom: true })),
  gateReads: (loc) => [
    { data: { id: STAFFER, full_name: 'Coach Two', role: 'staff' }, error: null },
    { data: [{ location_id: loc, role: 'staff' }], error: null },
  ],
  forbidden: PW_FORBIDDEN, hidden: PW_FORBIDDEN,
  cases: [
    ['staff at A, owner at B, A active, staffer at B (main: forbidden)', two('staff', 'owner', LOC_A), LOC_B, 'pass'],
    ['owner at A with B active, staffer at A (main: forbidden)', two('owner', 'staff', LOC_B), LOC_A, 'pass'],
    ['owner at A, staff at B, A active, staffer at B', two('owner', 'staff', LOC_A), LOC_B, 'forbidden'],
    ['owner at A, staffer at A', two('owner', 'staff', LOC_A), LOC_A, 'pass'],
    ['manager at A and at B', two('manager', 'manager', LOC_A), LOC_B, 'forbidden'],
    ['a master', MASTER, LOC_B, 'pass'],
    ['an owner who does not belong to B', OUTSIDER, LOC_B, 'forbidden'],
  ],
}, T)

// ── schedule/contractor-spend: characterisation (same answers before/after) ─
// SAFE-but-tidy: the hand-rolled `user.role !== 'master'` + getUserLocationIds
// membership check became assertLocationAccess with the same 403 body.
describeGate('GET /api/schedule/contractor-spend (characterisation: unchanged)', {
  call: (loc) => contractorSpend.GET(bare('GET', `?location_id=${loc}&reference_date=2026-09-01`)),
  forbidden: { status: 403, body: { success: false, error: 'Unauthorized' } },
  hidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  cases: [
    ['manager at A (a member), target A', person({ [LOC_A]: { role: 'manager' } }, LOC_A), LOC_A, 'pass'],
    ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
    ['a master', MASTER, LOC_B, 'pass'],
    ['staff at A, manager at B, A active, target B', two('staff', 'manager', LOC_A), LOC_B, 'pass'],
    ['manager at A, staff at B, A active, target B', two('manager', 'staff', LOC_A), LOC_B, 'forbidden'],
    ['staff at A only', person({ [LOC_A]: { role: 'staff' } }, LOC_A), LOC_A, 'forbidden'],
  ],
}, T)
