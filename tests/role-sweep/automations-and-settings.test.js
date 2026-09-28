// ROLESWEEP.1a — automations, agent knowledge, segments, class categories,
// the Pulse journey lane and the ads refresh judge the role / permission at
// the location they act on (a row's, the body's or the query's), never at the
// caller's ACTIVE studio (`user.role`, `hasPermission(user, …)`).
// Harness: tests/helpers/role-gate-probe.js (a refused caller never reaches a
// DB/network call past the gate reads; an allowed one gets past the gate).

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
import { roleCases, permissionCases } from '../helpers/role-sweep-callers.js'
import * as toggle from '@/app/api/automations/[key]/route.js'
import * as backfill from '@/app/api/automations/[key]/backfill/route.js'
import * as history from '@/app/api/automations/[key]/history/route.js'
import * as runNow from '@/app/api/automations/[key]/run-now/route.js'
import * as schedule from '@/app/api/automations/[key]/schedule/route.js'
import * as knowledge from '@/app/api/agent/knowledge/[id]/route.js'
import * as segments from '@/app/api/segments/route.js'
import * as classCategories from '@/app/api/settings/class-categories/route.js'
import * as journey from '@/app/api/pulse/journey/route.js'
import * as adsRefresh from '@/app/api/dashboard/ads/refresh/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const get = (qs) => new Request(`http://localhost/api/x?${qs}`)
const key = (k) => ({ params: Promise.resolve({ key: k }) })

const FORBIDDEN = { status: 403, body: { success: false, error: 'Unauthorized' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const CASES = roleCases(MANAGER_ROLES)

beforeEach(() => vi.clearAllMocks())

describeGate('PUT /api/automations/[key]', {
  call: (loc) => toggle.PUT(json('PUT', { location_id: loc, enabled: true }), key('class_climate')),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

describeGate('GET /api/automations/[key]/backfill', {
  call: (loc) => backfill.GET(get(`location_id=${loc}`), key('glofox_lead_provisioning')),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

describeGate('POST /api/automations/[key]/backfill', {
  call: (loc) => backfill.POST(json('POST', { location_id: loc }), key('glofox_lead_provisioning')),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

describeGate('GET /api/automations/[key]/history', {
  call: (loc) => history.GET(get(`location_id=${loc}`), key('class_climate')),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

describeGate('POST /api/automations/[key]/run-now', {
  call: (loc) => runNow.POST(json('POST', { location_id: loc, dry_run: true }), key('class_climate')),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

describeGate('GET /api/automations/[key]/schedule', {
  call: (loc) => schedule.GET(get(`location_id=${loc}`), key('class_climate')),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

// ── agent knowledge: the row's location ───────────────────────────────────
const KNOWLEDGE_ROW = (loc) => [{ data: { id: 'kb-1', location_id: loc }, error: null }]
const KNOWLEDGE_REFUSED = { status: 403, body: { success: false, error: 'Forbidden' } }
const idParams = (id) => ({ params: Promise.resolve({ id }) })

describeGate('PUT /api/agent/knowledge/[id]', {
  call: () => knowledge.PUT(json('PUT', { title: 'Opening hours' }), idParams('kb-1')),
  gateReads: KNOWLEDGE_ROW,
  forbidden: KNOWLEDGE_REFUSED, hidden: KNOWLEDGE_REFUSED, cases: CASES,
}, T)

describeGate('DELETE /api/agent/knowledge/[id]', {
  call: () => knowledge.DELETE(new Request('http://localhost/api/x', { method: 'DELETE' }), idParams('kb-1')),
  gateReads: KNOWLEDGE_ROW,
  forbidden: KNOWLEDGE_REFUSED, hidden: KNOWLEDGE_REFUSED, cases: CASES,
}, T)

// ── segments: ?location_id (the AudienceBuilder passes the editor's) ──────
describeGate('GET /api/segments?location_id=', {
  call: (loc) => segments.GET(get(`location_id=${loc}`)),
  forbidden: { status: 403, body: { success: false, error: 'Manager+ required' } },
  hidden: NOT_MEMBER, cases: CASES,
}, T)

// ── class categories: ?location_id / body.location_id ─────────────────────
describeGate('GET /api/settings/class-categories', {
  call: (loc) => classCategories.GET(get(`location_id=${loc}`)),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

describeGate('PUT /api/settings/class-categories', {
  call: (loc) => classCategories.PUT(json('PUT', { location_id: loc, entries: [] })),
  forbidden: FORBIDDEN, hidden: NOT_MEMBER, cases: CASES,
}, T)

// ── Pulse journey lane: permission pulse_admin at ?location_id ────────────
describeGate('GET /api/pulse/journey?location_id=', {
  call: (loc) => journey.GET(get(`location_id=${loc}`)),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_MEMBER, cases: permissionCases('pulse_admin'),
}, T)

// ── ads refresh: permission dashboard_ads at body.locationId ──────────────
describeGate('POST /api/dashboard/ads/refresh', {
  call: (loc) => adsRefresh.POST(json('POST', { locationId: loc })),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_MEMBER, cases: permissionCases('dashboard_ads'),
}, T)
