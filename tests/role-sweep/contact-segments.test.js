// SEGMENTROUTE.1: the saved-segment routes check a permission AT the
// segment's studio, after membership, and the PUT validates its filter.
//
// Before this, /api/contacts/segments* checked studio membership only, so any
// member (a plain staff member with Contacts switched off included) could list,
// create, rename, rewrite or delete that studio's saved segments, and PUT
// stored a filter the POST would refuse. Since mig 672 these routes are the
// only way to write a segment.
//
// The rules (src/lib/segment-access.js):
//   read  (GET)               contacts OR email OR whatsapp at the studio (the
//                             gates of the four screens that list segments);
//   write (POST, PUT, DELETE) contacts at the studio (/contacts is the only
//                             screen that saves or deletes one);
//   a segment a sequence's trigger names: PUT/DELETE also need the sequence
//                             builder's rule (email OR whatsapp), because
//                             rewriting it changes who that sequence enrols.
// Harness: tests/helpers/role-gate-probe.js. Synthetic data only.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logError } from '@/lib/log'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import {
  person, LOC_A, LOC_B, MASTER, OUTSIDER, keyOnAtBOnly, featureOffAtA,
} from '../helpers/role-sweep-callers.js'
import * as list from '@/app/api/contacts/segments/route.js'
import * as detail from '@/app/api/contacts/segments/[id]/route.js'
import {
  SEGMENT_READ_PERMISSIONS, SEGMENT_WRITE_PERMISSION, canReadSegmentsAt, canWriteSegmentsAt,
} from '@/lib/segment-access'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/contacts/segments', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/contacts/segments${qs ? `?${qs}` : ''}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })

const SEG_ID = '5e000000-0000-4000-8000-0000000000c1'
const GOOD_FILTER = { logic: 'and', filters: [{ field: 'glofox_membership_state', op: 'eq', value: 'locked' }] }
// Zod's audienceFilterSchema accepts it (field is any string); the audience
// validator refuses it (not an AUDIENCE_FIELDS key). POST 400s it; PUT on main
// stored it.
const TYPO_FILTER = { logic: 'and', filters: [{ field: 'glofox_membership_stat', op: 'eq', value: 'locked' }] }
const OR_TAG_FILTER = { logic: 'or', filters: [{ field: 'tag', op: 'eq', value: 'synthetic_tag' }, { field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

const SEG_ROW = (loc) => ({ data: { id: SEG_ID, location_id: loc }, error: null })
const UNWIRED = { data: null, count: 0, error: null }
const WIRED = { data: null, count: 1, error: null }

const NO_READ = { status: 403, body: { success: false, error: 'Contacts, Email or WhatsApp permission required' } }
const NO_WRITE = { status: 403, body: { success: false, error: 'Contacts permission required' } }
const WIRED_NEEDS_BUILDER = { status: 403, body: { success: false, error: 'This segment starts a sequence: changing it needs the Email or WhatsApp permission' } }
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }

// ── callers (target LOC_B) ─────────────────────────────────────────────────
// The live shape (30 Sep): 6 of 7 Stillorgan staff have Contacts off.
const STAFF_B_CONTACTS_OFF = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff', permissions: { contacts: false } } }, LOC_A)
const MANAGER_A_STAFF_B_CONTACTS_OFF = person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff', permissions: { contacts: false } } }, LOC_A)
// Contacts on by default; no email, no whatsapp (the staff default).
const STAFF_B = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff' } }, LOC_A)
// Stillorgan's head-coach template: Email and WhatsApp off.
const HEAD_COACH_B_NO_MESSAGING = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'head_coach', template: { email: false, whatsapp: false } } }, LOC_A)
const OWNER_B_CONTACTS_OFF = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner', permissions: { contacts: false } } }, LOC_A)
const RECEPTION_B = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'reception' } }, LOC_A)
const MANAGER_B = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A)

const READ_CASES = [
  ['staff at B with Contacts off (main: pass)', STAFF_B_CONTACTS_OFF, LOC_B, 'forbidden'],
  ['manager at A, staff at B with Contacts off, A active (main: pass)', MANAGER_A_STAFF_B_CONTACTS_OFF, LOC_B, 'forbidden'],
  ['staff at B (Contacts on by default)', STAFF_B, LOC_B, 'pass'],
  ['owner at B with Contacts off (Email still on: the composer lists segments)', OWNER_B_CONTACTS_OFF, LOC_B, 'pass'],
  ['Contacts off at A only, A active', keyOnAtBOnly('contacts'), LOC_B, 'pass'],
  ["feature Contacts off at A's location, A active", featureOffAtA('contacts'), LOC_B, 'pass'],
  ['a master', MASTER, LOC_B, 'pass'],
  ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
]
const WRITE_CASES = [
  ['staff at B with Contacts off (main: pass)', STAFF_B_CONTACTS_OFF, LOC_B, 'forbidden'],
  ['manager at A, staff at B with Contacts off, A active (main: pass)', MANAGER_A_STAFF_B_CONTACTS_OFF, LOC_B, 'forbidden'],
  ['owner at B with Contacts off (main: pass)', OWNER_B_CONTACTS_OFF, LOC_B, 'forbidden'],
  ['staff at B (Contacts on by default: /contacts shows them Save)', STAFF_B, LOC_B, 'pass'],
  ['head coach at B with Email and WhatsApp off', HEAD_COACH_B_NO_MESSAGING, LOC_B, 'pass'],
  ['Contacts off at A only, A active', keyOnAtBOnly('contacts'), LOC_B, 'pass'],
  ["feature Contacts off at A's location, A active", featureOffAtA('contacts'), LOC_B, 'pass'],
  ['a master', MASTER, LOC_B, 'pass'],
  ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
]
const WIRED_CASES = [
  ['staff at B (Contacts only) on a segment a sequence uses (main: pass)', STAFF_B, LOC_B, 'wired'],
  ['head coach at B with Email and WhatsApp off (main: pass)', HEAD_COACH_B_NO_MESSAGING, LOC_B, 'wired'],
  ['staff at B with Contacts off (main: pass)', STAFF_B_CONTACTS_OFF, LOC_B, 'forbidden'],
  ['reception at B (Contacts + WhatsApp by default)', RECEPTION_B, LOC_B, 'pass'],
  ['manager at B', MANAGER_B, LOC_B, 'pass'],
  ['a master', MASTER, LOC_B, 'pass'],
  ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
]

beforeEach(() => vi.clearAllMocks())

// ── list + create (query/body location → 403 for outsiders) ───────────────
describeGate('GET /api/contacts/segments?location_id= (contacts, email or whatsapp there)', {
  call: (loc) => list.GET(bare('GET', `location_id=${loc}`)),
  forbidden: NO_READ, hidden: NOT_MEMBER, cases: READ_CASES,
}, T)
describeGate('POST /api/contacts/segments (contacts at body.location_id)', {
  call: (loc) => list.POST(json('POST', { name: 'Locked members', filter: GOOD_FILTER, location_id: loc })),
  forbidden: NO_WRITE, hidden: NOT_MEMBER, cases: WRITE_CASES,
}, T)

// ── the segment row (detail → 404 for outsiders) ──────────────────────────
const id = { id: SEG_ID }
const ROW_ROUTES = [
  ['PUT /api/contacts/segments/[id]', () => detail.PUT(json('PUT', { name: 'Renamed', filter: GOOD_FILTER }), params(id))],
  ['DELETE /api/contacts/segments/[id]', () => detail.DELETE(bare('DELETE'), params(id))],
]
for (const [title, call] of ROW_ROUTES) {
  describeGate(`${title} (contacts at the segment's studio)`, {
    call, gateReads: (loc) => [SEG_ROW(loc), UNWIRED], forbidden: NO_WRITE, hidden: NOT_FOUND, cases: WRITE_CASES,
  }, T)
  describeGate(`${title} on a segment a sequence uses (+ email or whatsapp)`, {
    call, gateReads: (loc) => [SEG_ROW(loc), WIRED], forbidden: NO_WRITE, wired: WIRED_NEEDS_BUILDER, hidden: NOT_FOUND, cases: WIRED_CASES,
  }, T)
}

async function probed(caller, call, reads) {
  getCurrentUser.mockResolvedValue(caller)
  const probe = gateProbe(reads)
  createServerClient.mockReturnValue(probe.db)
  return { probe, ...(await runProbed(probe, call)) }
}

// ── a missing segment answers exactly like another studio's ───────────────
describe("a missing segment answers exactly like another studio's (404 Not found)", () => {
  it.each(ROW_ROUTES)('%s', async (_title, call) => {
    const { probe, status, body } = await probed(MANAGER_B, call, [{ data: null, error: null }])
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(NOT_FOUND)
  })
  it.each([
    ['PUT', () => detail.PUT(json('PUT', { name: 'x' }), params({ id: 'not-a-uuid' }))],
    ['DELETE', () => detail.DELETE(bare('DELETE'), params({ id: 'not-a-uuid' }))],
  ])('%s with a non-uuid id: 404, no read', async (_m, call) => {
    const { probe, status, body } = await probed(MANAGER_B, call, [])
    expect(probe.passed).toBe(false)
    expect(probe.reads).toEqual([])
    expect({ status, body }).toEqual(NOT_FOUND)
  })
})

// ── a failed read is a logged 500, never "not found" or "not used" ────────
describe('a failed read fails closed', () => {
  const failed = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
  it.each(ROW_ROUTES)('%s: the segment read fails → 500, not 404', async (_title, call) => {
    const { probe, status, body } = await probed(MANAGER_B, call, [failed])
    expect(probe.passed).toBe(false)
    expect(status).toBe(500)
    expect(body).toEqual({ success: false, error: 'Could not load the segment' })
    expect(logError).toHaveBeenCalledWith('contacts', expect.any(String), expect.objectContaining({ segmentId: SEG_ID }))
  })
  it.each(ROW_ROUTES)('%s: the sequences read fails → 500, not "unused"', async (_title, call) => {
    const { probe, status, body } = await probed(STAFF_B, call, [SEG_ROW(LOC_B), { data: null, count: null, error: failed.error }])
    expect(probe.passed).toBe(false)
    expect(status).toBe(500)
    expect(body).toEqual({ success: false, error: 'Could not check which sequences use this segment' })
    expect(logError).toHaveBeenCalledWith('contacts', expect.any(String), expect.objectContaining({ segmentId: SEG_ID }))
  })
})

// ── PUT validates its filter exactly as POST does ─────────────────────────
describe('PUT /api/contacts/segments/[id] validates the filter (FILTER-P1.5 missed it)', () => {
  it('POST refuses the typo filter (the rule PUT must match)', async () => {
    const { probe, status, body } = await probed(MANAGER_B, () => list.POST(json('POST', { name: 'x', filter: TYPO_FILTER, location_id: LOC_B })), [])
    expect(probe.passed).toBe(false)
    expect(status).toBe(400)
    expect(body).toEqual({ success: false, error: 'Unknown audience field: glofox_membership_stat' })
  })
  it('PUT refuses it with the same 400, and writes nothing', async () => {
    const { probe, status, body } = await probed(MANAGER_B, () => detail.PUT(json('PUT', { filter: TYPO_FILTER }), params(id)), [SEG_ROW(LOC_B), UNWIRED])
    expect(probe.passed).toBe(false)
    expect(status).toBe(400)
    expect(body).toEqual({ success: false, error: 'Unknown audience field: glofox_membership_stat' })
  })
  it('PUT refuses OR + a tag row (a sequence on it would enrol nobody)', async () => {
    const { probe, status, body } = await probed(MANAGER_B, () => detail.PUT(json('PUT', { filter: OR_TAG_FILTER }), params(id)), [SEG_ROW(LOC_B), UNWIRED])
    expect(probe.passed).toBe(false)
    expect(status).toBe(400)
    expect(body.error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })
  it('PUT refuses a tag row with no tag', async () => {
    const { probe, status, body } = await probed(MANAGER_B, () => detail.PUT(json('PUT', { filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: '' }] } }), params(id)), [SEG_ROW(LOC_B), UNWIRED])
    expect(probe.passed).toBe(false)
    expect(status).toBe(400)
    expect(body.error).toMatch(/tag filter requires a non-empty string value/)
  })
  it('PUT with a valid filter, or with no filter (a rename), reaches the update', async () => {
    for (const body of [{ filter: GOOD_FILTER }, { name: 'Renamed' }]) {
      const { probe } = await probed(MANAGER_B, () => detail.PUT(json('PUT', body), params(id)), [SEG_ROW(LOC_B), UNWIRED])
      expect(probe.passed).toBe(true)
      expect(probe.tripped).toMatchObject({ kind: 'from', table: 'contact_segments' })
      expect(probe.tripped.chain.map((c) => c[0])).toContain('update')
    }
  })
  it('a refused caller gets the refusal, not the filter error (gate before validation)', async () => {
    const { status, body } = await probed(STAFF_B_CONTACTS_OFF, () => detail.PUT(json('PUT', { filter: TYPO_FILTER }), params(id)), [SEG_ROW(LOC_B), UNWIRED])
    expect({ status, body }).toEqual(NO_WRITE)
    const post = await probed(STAFF_B_CONTACTS_OFF, () => list.POST(json('POST', { name: 'x', filter: TYPO_FILTER, location_id: LOC_B })), [])
    expect({ status: post.status, body: post.body }).toEqual(NO_WRITE)
  })
})

// ── the sequence-use read is THIS segment's, at ITS studio ────────────────
describe('the sequences read is scoped to the segment', () => {
  it('filters email_sequences by the segment studio, the two segment triggers and trigger_config->>segment_id', async () => {
    let seqChain = null
    getCurrentUser.mockResolvedValue(STAFF_B)
    const probe = gateProbe([SEG_ROW(LOC_B), (chain) => { seqChain = chain; return UNWIRED }])
    createServerClient.mockReturnValue(probe.db)
    await runProbed(probe, () => detail.DELETE(bare('DELETE'), params(id)))
    expect(probe.reads.map((r) => r.table)).toEqual(['contact_segments', 'email_sequences'])
    expect(seqChain).toEqual(expect.arrayContaining([
      ['eq', 'location_id', LOC_B],
      ['in', 'trigger_type', ['segment_added', 'segment_removed']],
      ['eq', 'trigger_config->>segment_id', SEG_ID],
    ]))
    expect(probe.tripped).toMatchObject({ kind: 'from', table: 'contact_segments' })
  })
})

// ── who the rules admit, pinned (nobody who can open /contacts loses Save) ─
// /contacts opens on `contacts` at the studio and shows Save and delete to
// everyone it lets in, so the write rule must be exactly `contacts` there.
// Requiring Email as well (DECISION R1, not taken) would take Save and delete
// from head coaches whose template switches Email off and from staff: that
// change must fail here first.
describe('who the segment rules admit (pinned)', () => {
  it('the rule constants: write = contacts; read = contacts, email or whatsapp', () => {
    expect(SEGMENT_WRITE_PERMISSION).toBe('contacts')
    expect([...SEGMENT_READ_PERMISSIONS]).toEqual(['contacts', 'email', 'whatsapp'])
  })
  // Each role on the code defaults (no override, no template) at B.
  it.each(['owner', 'manager', 'head_coach', 'staff', 'reception'])('%s at B on the defaults may list, save and delete there', (role) => {
    const caller = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role } }, LOC_A)
    expect(canReadSegmentsAt(caller, LOC_B)).toBe(true)
    expect(canWriteSegmentsAt(caller, LOC_B)).toBe(true)
  })
  it('a master may list, save and delete anywhere', () => {
    expect(canReadSegmentsAt(MASTER, LOC_B)).toBe(true)
    expect(canWriteSegmentsAt(MASTER, LOC_B)).toBe(true)
  })
  it.each([
    ['a head coach whose template switches Email and WhatsApp off', HEAD_COACH_B_NO_MESSAGING],
    ['staff with Contacts on and no Email or WhatsApp', STAFF_B],
  ])('%s keeps Save and delete (R1 not taken)', (_label, caller) => {
    expect(canWriteSegmentsAt(caller, LOC_B)).toBe(true)
  })
  it.each([
    ['staff with Contacts switched off', STAFF_B_CONTACTS_OFF],
    ['an owner at a studio whose Contacts feature is off (the CCF Autos shape)', person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner', features: { contacts: false, email: false, whatsapp: false } } }, LOC_A)],
    ['someone with no membership at B', OUTSIDER],
  ])('%s may neither list nor save there', (_label, caller) => {
    expect(canReadSegmentsAt(caller, LOC_B)).toBe(false)
    expect(canWriteSegmentsAt(caller, LOC_B)).toBe(false)
  })
})
