// ROLESWEEP.1c — per-contact detail routes judge the role / permission at
// the CONTACT's (or the row's) location, never at the caller's ACTIVE studio:
// the consultations family, notes, pipeline status + deal stage, identity
// linking and the duplicates queue, the app invite, app-account linking and
// marketing preferences. (devices and devices/[deviceId] were fixed by
// SECFIX.1, #1797, and are pinned by their own route tests.)
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
import { ADMIN_ROLES } from '@/lib/schemas'
import { describeGate } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases } from '../helpers/role-sweep-callers.js'
import { ownerCases } from '../helpers/role-sweep-callers-c.js'
import * as photos from '@/app/api/contacts/[id]/consultation-photos/route.js'
import * as photo from '@/app/api/contacts/[id]/consultation-photos/[pid]/route.js'
import * as consultations from '@/app/api/contacts/[id]/consultations/route.js'
import * as consultation from '@/app/api/contacts/[id]/consultations/[cid]/route.js'
import * as goals from '@/app/api/contacts/[id]/goals/route.js'
import * as goal from '@/app/api/contacts/[id]/goals/[gid]/route.js'
import * as kudos from '@/app/api/contacts/[id]/kudos/route.js'
import * as inbody from '@/app/api/contacts/[id]/inbody-sync/route.js'
import * as notes from '@/app/api/contacts/[id]/notes/route.js'
import * as pipelineStatus from '@/app/api/contacts/[id]/pipeline-status/route.js'
import * as dealStage from '@/app/api/deals/[id]/stage/route.js'
import * as link from '@/app/api/contacts/[id]/link/route.js'
import * as duplicate from '@/app/api/contacts/duplicates/[id]/route.js'
import * as detect from '@/app/api/contacts/duplicates/detect/route.js'
import * as inviteApp from '@/app/api/contacts/[id]/invite-app/route.js'
import * as linkAccount from '@/app/api/contacts/[id]/link-account/route.js'
import * as marketing from '@/app/api/contacts/[id]/marketing-preferences/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
// Real uuids: kudos / notes / pipeline-status / deal stage 404 a non-uuid id before auth.
const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'
const ROW_ID = 'c0000000-0000-4000-8000-000000000002'
const STAGE_ID = 'c0000000-0000-4000-8000-000000000003'
const AUTH_USER_ID = 'c0000000-0000-4000-8000-000000000004'
const row = (fields) => (loc) => [{ data: { id: CONTACT_ID, name: 'Member One', ...fields, location_id: loc }, error: null }]
const CONTACT = row({})

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const UNAUTHORIZED = { status: 403, body: { success: false, error: 'Unauthorized' } }
const FORBIDDEN = { status: 403, body: { success: false, error: 'Forbidden' } }

beforeEach(() => vi.clearAllMocks())

// ── consultations family (`consultations`) ────────────────────────────────
const CONSULT = permissionCases('consultations')
describeGate('POST /api/contacts/[id]/consultation-photos', {
  call: () => photos.POST(new Request('http://localhost/api/x', { method: 'POST', body: new FormData() }), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('DELETE /api/contacts/[id]/consultation-photos/[pid] (the photo row)', {
  call: () => photo.DELETE(bare('DELETE'), params({ id: CONTACT_ID, pid: ROW_ID })),
  gateReads: (loc) => [{ data: { id: ROW_ID, contact_id: CONTACT_ID, location_id: loc, storage_path: 'consultations/x.jpg' }, error: null }],
  forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('POST /api/contacts/[id]/consultations', {
  call: () => consultations.POST(json('POST', { notes: 'Intro chat' }), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('PUT /api/contacts/[id]/consultations/[cid]', {
  call: () => consultation.PUT(json('PUT', { notes: 'Updated' }), params({ id: CONTACT_ID, cid: ROW_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('DELETE /api/contacts/[id]/consultations/[cid]', {
  call: () => consultation.DELETE(bare('DELETE'), params({ id: CONTACT_ID, cid: ROW_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('POST /api/contacts/[id]/goals', {
  call: () => goals.POST(json('POST', { title: 'Run 5k' }), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('PUT /api/contacts/[id]/goals/[gid]', {
  call: () => goal.PUT(json('PUT', { title: 'Run 10k' }), params({ id: CONTACT_ID, gid: ROW_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('DELETE /api/contacts/[id]/goals/[gid]', {
  call: () => goal.DELETE(bare('DELETE'), params({ id: CONTACT_ID, gid: ROW_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('POST /api/contacts/[id]/kudos', {
  call: () => kudos.POST(json('POST', { message: 'Great session' }), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: CONSULT,
}, T)
describeGate('POST /api/contacts/[id]/inbody-sync', {
  call: () => inbody.POST(bare('POST'), params({ id: CONTACT_ID })),
  gateReads: row({ phone: '+353870000001', wa_phone: null }),
  forbidden: { status: 403, body: { success: false, error: 'Not permitted' } },
  hidden: { status: 403, body: { success: false, error: 'Location not in your scope' } },
  cases: CONSULT,
}, T)

// ── notes (`contacts`), pipeline status + deal stage (`pipeline`) ─────────
describeGate('POST /api/contacts/[id]/notes', {
  call: () => notes.POST(json('POST', { content: 'Called back' }), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: permissionCases('contacts'),
}, T)
describeGate('POST /api/contacts/[id]/pipeline-status', {
  call: () => pipelineStatus.POST(json('POST', { cold: true }), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: permissionCases('pipeline'),
}, T)
describeGate('POST /api/deals/[id]/stage (the deal row)', {
  call: () => dealStage.POST(json('POST', { stage_id: STAGE_ID }), params({ id: ROW_ID })),
  gateReads: (loc) => [{ data: { id: ROW_ID, location_id: loc, contact_id: CONTACT_ID, stage_id: null, pipeline_id: 'p-1' }, error: null }],
  forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: permissionCases('pipeline'),
}, T)

// ── contact_linking ───────────────────────────────────────────────────────
const LINKING = permissionCases('contact_linking')
describeGate('POST /api/contacts/[id]/link?action=set-primary', {
  call: () => link.POST(bare('POST', '?action=set-primary'), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: LINKING,
}, T)
describeGate('DELETE /api/contacts/[id]/link', {
  call: () => link.DELETE(bare('DELETE'), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: UNAUTHORIZED, hidden: NOT_FOUND, cases: LINKING,
}, T)
describeGate('PATCH /api/contacts/duplicates/[id] (the suggestion row)', {
  call: () => duplicate.PATCH(json('PATCH', { status: 'dismissed' }), params({ id: ROW_ID })),
  gateReads: (loc) => [{ data: { id: ROW_ID, location_id: loc, contact_a_id: CONTACT_ID, contact_b_id: ROW_ID }, error: null }],
  forbidden: FORBIDDEN, hidden: NOT_FOUND, cases: LINKING,
}, T)
describeGate('POST /api/contacts/duplicates/detect (body location_id)', {
  call: (loc) => detect.POST(json('POST', { location_id: loc })),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: LINKING,
}, T)

// ── admin-tier contact actions ────────────────────────────────────────────
const ADMIN_ONLY = { status: 403, body: { success: false, error: 'Admin only' } }
describeGate('POST /api/contacts/[id]/invite-app (owner / manager)', {
  call: () => inviteApp.POST(bare('POST'), params({ id: CONTACT_ID })),
  gateReads: row({ email: 'member.one@example.com', user_id: null }),
  forbidden: ADMIN_ONLY,
  hidden: { status: 403, body: { success: false, error: 'Location not in your scope' } },
  cases: roleCases(['owner', 'manager']),
}, T)

const LINK_ROW = row({ email: 'member.one@example.com', user_id: null })
describeGate('GET /api/contacts/[id]/link-account (owner)', {
  call: () => linkAccount.GET(bare('GET'), params({ id: CONTACT_ID })),
  gateReads: LINK_ROW, forbidden: ADMIN_ONLY, hidden: NOT_FOUND, cases: ownerCases(),
}, T)
describeGate('POST /api/contacts/[id]/link-account (owner)', {
  call: () => linkAccount.POST(json('POST', { userId: AUTH_USER_ID, confirm: true }), params({ id: CONTACT_ID })),
  gateReads: LINK_ROW, forbidden: ADMIN_ONLY, hidden: NOT_FOUND, cases: ownerCases(),
}, T)
describeGate('DELETE /api/contacts/[id]/link-account (owner)', {
  call: () => linkAccount.DELETE(json('DELETE', { confirm: true }), params({ id: CONTACT_ID })),
  gateReads: row({ email: 'member.one@example.com', user_id: AUTH_USER_ID }),
  forbidden: ADMIN_ONLY, hidden: NOT_FOUND, cases: ownerCases(),
}, T)

describeGate('PATCH /api/contacts/[id]/marketing-preferences (ADMIN_ROLES)', {
  call: () => marketing.PATCH(json('PATCH', { email_marketing: true }), params({ id: CONTACT_ID })),
  gateReads: (loc) => [{ data: { location_id: loc, email_status: 'active' }, error: null }],
  forbidden: ADMIN_ONLY, hidden: NOT_FOUND, cases: roleCases(ADMIN_ROLES),
}, T)
