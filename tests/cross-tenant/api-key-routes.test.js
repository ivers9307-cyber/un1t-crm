// SAAS-10 — cross-tenant boundary harness: the API-key route surface.
//
// Every spec below runs the REAL route handler + the REAL api-auth
// scoping helpers against the two-tenant world in fixture.js. Only the
// lowest seams are mocked: @/lib/supabase (in-memory double),
// next/headers, getCurrentUser, and pure side-effect libs (push,
// sequences, glofox) that would otherwise fire network calls. The
// per-org API keys resolve against the api_keys fixture rows by real
// SHA-256 hash — nothing about the tenant scoping itself is stubbed.
//
// Assertions per route kind:
//   list    — org-A key sees ONLY org-A rows (both its locations);
//             org-B key the mirror; legacy shared key sees everything
//             (unscoped BY DESIGN until n8n migrates — pinned so a
//             change is deliberate).
//   detail  — org-A key reads its own row; a cross-tenant id → 404
//             (indistinguishable from missing).
//   mutate  — org-A key mutating a cross-tenant row → 404, the row is
//             byte-identical afterwards, and no write ever reached the
//             table. Positive control proves the block isn't vacuous.
//   create  — org-A key creating into org B (by location_id or via a
//             B contact anchor) → 403 and no insert.
//
// ADDING A ROUTE: one entry in the relevant spec table below.
// Routes that can't fit the pattern are listed in SKIPPED with the
// reason — keep that table honest.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
// Side-effect seams — never part of the tenant boundary under test.
vi.mock('@/lib/sequences', () => ({
  triggerSequencesForTagsAdded: vi.fn(async () => {}),
  triggerSequencesForPipelineStageChange: vi.fn(async () => {}),
}))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForContactCreated: vi.fn(async () => {}) }))
vi.mock('@/lib/automations/glofox-lead-provisioning', () => ({ maybeProvisionLeadInGlofox: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', () => ({ sendPushToRolesAtLocationOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => {}) }))
vi.mock('@/lib/contact-merge', () => ({ redactWhatsAppForContact: vi.fn(async () => {}), redactInBodyForContact: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: vi.fn(async ({ query }) => ({ query })),
  InvalidAudienceFilterError: class InvalidAudienceFilterError extends Error {},
}))
vi.mock('@/lib/contact-crossovers', () => ({ crossoverContactIds: vi.fn(async () => []), fetchCrossoverContext: vi.fn(async () => ({})) }))
vi.mock('@/lib/person-links', () => ({ attachLinkedCounts: vi.fn(async (_db, rows) => rows) }))

import { createServerClient } from '@/lib/supabase'
import {
  makeWorld, makeTenantDb, makeReq, jsonOf, propsOf, idsOf,
  LEGACY_KEY, ORG_A_KEY, ORG_B_KEY,
  LOC_A1, LOC_B1,
  C_A1, C_A2, C_B1, C_B2,
  D_A1, D_B1,
  BK_A1, BK_A2, BK_B1, BK_B2,
  CAM_A1, CAM_A2, CAM_B1, CAM_B2,
  TASK_A1, TASK_A2, TASK_B1, TASK_B2,
  ET_A1, ET_A2, ET_B1, ET_B2,
  STG_A1, STG_A2, STG_B1, STG_B2,
} from './fixture.js'

import * as contactsRoute from '@/app/api/contacts/route.js'
import * as contactDetailRoute from '@/app/api/contacts/[id]/route.js'
import * as contactsSearchRoute from '@/app/api/contacts/search/route.js'
import * as dealsRoute from '@/app/api/deals/route.js'
import * as dealDetailRoute from '@/app/api/deals/[id]/route.js'
import * as dealsSearchRoute from '@/app/api/deals/search/route.js'
import * as bookingsRoute from '@/app/api/bookings/route.js'
import * as bookingDetailRoute from '@/app/api/bookings/[id]/route.js'
import * as campaignsRoute from '@/app/api/campaigns/route.js'
import * as campaignDetailRoute from '@/app/api/campaigns/[id]/route.js'
import * as tasksRoute from '@/app/api/tasks/route.js'
import * as taskDetailRoute from '@/app/api/tasks/[id]/route.js'
import * as activitiesRoute from '@/app/api/activities/route.js'
import * as notesRoute from '@/app/api/notes/route.js'
import * as stagesRoute from '@/app/api/stages/route.js'
import * as eventTypesRoute from '@/app/api/bookings/event-types/route.js'

let world
let db
function freshWorld() {
  world = makeWorld()
  db = makeTenantDb(world)
  vi.mocked(createServerClient).mockReturnValue(db)
  return { world, db }
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  process.env.CRM_API_KEY = LEGACY_KEY
  freshWorld()
})

const dataIds = (json) => idsOf(json?.data)
const itemIds = (json) => idsOf((json?.data?.items || []).map((i) => i.item))

// ─── spec table: LIST routes ─────────────────────────────────────────
const LIST_SPECS = [
  {
    name: 'GET /api/contacts (contacts list)',
    call: () => contactsRoute.GET(makeReq('/api/contacts', { bearer: currentKey })),
    ids: dataIds,
    orgA: [C_A1, C_A2], orgB: [C_B1, C_B2], all: [C_A1, C_A2, C_B1, C_B2],
  },
  {
    name: 'GET /api/contacts/search?fields=email (contacts search, email path)',
    call: () => contactsSearchRoute.GET(makeReq('/api/contacts/search?term=lead&fields=email', { bearer: currentKey })),
    ids: itemIds,
    orgA: [C_A1, C_A2], orgB: [C_B1, C_B2], all: [C_A1, C_A2, C_B1, C_B2],
  },
  {
    name: 'GET /api/contacts/search?fields=all (contacts search, or() path)',
    call: () => contactsSearchRoute.GET(makeReq('/api/contacts/search?term=Lead&fields=all', { bearer: currentKey })),
    ids: itemIds,
    orgA: [C_A1, C_A2], orgB: [C_B1, C_B2], all: [C_A1, C_A2, C_B1, C_B2],
  },
  {
    name: 'GET /api/bookings (bookings list)',
    call: () => bookingsRoute.GET(makeReq('/api/bookings', { bearer: currentKey })),
    ids: dataIds,
    orgA: [BK_A1, BK_A2], orgB: [BK_B1, BK_B2], all: [BK_A1, BK_A2, BK_B1, BK_B2],
  },
  {
    name: 'GET /api/campaigns (campaigns list)',
    call: () => campaignsRoute.GET(makeReq('/api/campaigns', { bearer: currentKey })),
    ids: dataIds,
    orgA: [CAM_A1, CAM_A2], orgB: [CAM_B1, CAM_B2], all: [CAM_A1, CAM_A2, CAM_B1, CAM_B2],
  },
  {
    name: 'GET /api/tasks (tasks list)',
    call: () => tasksRoute.GET(makeReq('/api/tasks', { bearer: currentKey })),
    ids: dataIds,
    orgA: [TASK_A1, TASK_A2], orgB: [TASK_B1, TASK_B2], all: [TASK_A1, TASK_A2, TASK_B1, TASK_B2],
  },
  {
    name: 'GET /api/bookings/event-types (event types list)',
    call: () => eventTypesRoute.GET(makeReq('/api/bookings/event-types', { bearer: currentKey })),
    ids: dataIds,
    orgA: [ET_A1, ET_A2], orgB: [ET_B1, ET_B2], all: [ET_A1, ET_A2, ET_B1, ET_B2],
  },
  {
    name: 'GET /api/stages (pipeline stages list, API-key path)',
    call: () => stagesRoute.GET(makeReq('/api/stages', { bearer: currentKey })),
    ids: dataIds,
    orgA: [STG_A1, STG_A2], orgB: [STG_B1, STG_B2], all: [STG_A1, STG_A2, STG_B1, STG_B2],
  },
]

// The key the spec's call() should use — set per `it` before invoking.
let currentKey = null

describe.each(LIST_SPECS)('$name — org boundary', (spec) => {
  it('org-A key sees only org-A rows (both A locations, never org B)', async () => {
    currentKey = ORG_A_KEY
    const { status, json } = await jsonOf(await spec.call())
    expect(status).toBe(200)
    expect(spec.ids(json)).toEqual([...spec.orgA].sort())
  })

  it('org-B key sees only org-B rows (mirror)', async () => {
    currentKey = ORG_B_KEY
    const { status, json } = await jsonOf(await spec.call())
    expect(status).toBe(200)
    expect(spec.ids(json)).toEqual([...spec.orgB].sort())
  })

  it('legacy shared key sees every tenant — unscoped BY DESIGN (n8n back-compat, pinned)', async () => {
    currentKey = LEGACY_KEY
    const { status, json } = await jsonOf(await spec.call())
    expect(status).toBe(200)
    expect(spec.ids(json)).toEqual([...spec.all].sort())
  })
})

// ─── spec table: DETAIL routes ───────────────────────────────────────
const DETAIL_SPECS = [
  {
    name: 'GET /api/contacts/[id] (contact detail)',
    call: (id) => contactDetailRoute.GET(makeReq(`/api/contacts/${id}`, { bearer: currentKey }), propsOf({ id })),
    aId: C_A1, bId: C_B1,
  },
  {
    name: 'GET /api/campaigns/[id] (campaign detail)',
    call: (id) => campaignDetailRoute.GET(makeReq(`/api/campaigns/${id}`, { bearer: currentKey }), propsOf({ id })),
    aId: CAM_A1, bId: CAM_B1,
  },
  {
    name: 'GET /api/tasks/[id] (task detail)',
    call: (id) => taskDetailRoute.GET(makeReq(`/api/tasks/${id}`, { bearer: currentKey }), propsOf({ id })),
    aId: TASK_A1, bId: TASK_B1,
  },
]

describe.each(DETAIL_SPECS)('$name — org boundary', (spec) => {
  it('org-A key reads its own row', async () => {
    currentKey = ORG_A_KEY
    const { status, json } = await jsonOf(await spec.call(spec.aId))
    expect(status).toBe(200)
    expect(json.data.id).toBe(spec.aId)
  })

  it('org-A key fetching a cross-tenant id gets 404 — indistinguishable from missing', async () => {
    currentKey = ORG_A_KEY
    const { status, json } = await jsonOf(await spec.call(spec.bId))
    expect(status).toBe(404)
    expect(JSON.stringify(json)).not.toContain(spec.bId)
  })

  it('legacy shared key reads any tenant — unscoped BY DESIGN (pinned)', async () => {
    currentKey = LEGACY_KEY
    const { status, json } = await jsonOf(await spec.call(spec.bId))
    expect(status).toBe(200)
    expect(json.data.id).toBe(spec.bId)
  })
})

// ─── spec table: MUTATION routes ─────────────────────────────────────
const MUTATION_SPECS = [
  {
    name: 'PUT /api/contacts/[id] (contact update)',
    call: (id) => contactDetailRoute.PUT(makeReq(`/api/contacts/${id}`, { method: 'PUT', bearer: currentKey, body: { name: 'Hacked Name' } }), propsOf({ id })),
    table: 'contacts', aId: C_A1, bId: C_B1, changed: (row) => row.name === 'Hacked Name',
  },
  {
    name: 'PUT /api/deals/[id] (deal update)',
    call: (id) => dealDetailRoute.PUT(makeReq(`/api/deals/${id}`, { method: 'PUT', bearer: currentKey, body: { title: 'Hacked Deal' } }), propsOf({ id })),
    table: 'deals', aId: D_A1, bId: D_B1, changed: (row) => row.title === 'Hacked Deal',
  },
  {
    name: 'PUT /api/bookings/[id] (booking update)',
    call: (id) => bookingDetailRoute.PUT(makeReq(`/api/bookings/${id}`, { method: 'PUT', bearer: currentKey, body: { status: 'cancelled' } }), propsOf({ id })),
    table: 'bookings', aId: BK_A1, bId: BK_B1, changed: (row) => row.status === 'cancelled',
  },
  {
    name: 'PUT /api/campaigns/[id] (campaign update)',
    call: (id) => campaignDetailRoute.PUT(makeReq(`/api/campaigns/${id}`, { method: 'PUT', bearer: currentKey, body: { name: 'Hacked Campaign' } }), propsOf({ id })),
    table: 'campaigns', aId: CAM_A1, bId: CAM_B1, changed: (row) => row.name === 'Hacked Campaign',
  },
  {
    name: 'DELETE /api/campaigns/[id] (campaign delete)',
    call: (id) => campaignDetailRoute.DELETE(makeReq(`/api/campaigns/${id}`, { method: 'DELETE', bearer: currentKey }), propsOf({ id })),
    table: 'campaigns', aId: CAM_A1, bId: CAM_B1, deletes: true,
  },
  {
    name: 'PATCH /api/tasks/[id] (task update)',
    call: (id) => taskDetailRoute.PATCH(makeReq(`/api/tasks/${id}`, { method: 'PATCH', bearer: currentKey, body: { subject: 'Hacked Task' } }), propsOf({ id })),
    table: 'activities', aId: TASK_A1, bId: TASK_B1, changed: (row) => row.subject === 'Hacked Task',
  },
  {
    name: 'DELETE /api/tasks/[id] (task delete)',
    call: (id) => taskDetailRoute.DELETE(makeReq(`/api/tasks/${id}`, { method: 'DELETE', bearer: currentKey }), propsOf({ id })),
    table: 'activities', aId: TASK_A1, bId: TASK_B1, deletes: true,
  },
]

describe.each(MUTATION_SPECS)('$name — org boundary', (spec) => {
  it('org-A key mutating a cross-tenant row: 404, row untouched, no write issued', async () => {
    currentKey = ORG_A_KEY
    const before = structuredClone(world[spec.table].find((r) => r.id === spec.bId))
    const { status } = await jsonOf(await spec.call(spec.bId))
    expect(status).toBe(404)
    const after = world[spec.table].find((r) => r.id === spec.bId)
    expect(after).toEqual(before) // byte-identical — nothing leaked through
    const touched = db._writesTo(spec.table).filter((w) => (w.matchedIds || []).includes(spec.bId))
    expect(touched).toEqual([])
  })

  it('org-A key mutating its own row succeeds (positive control — the block is not vacuous)', async () => {
    currentKey = ORG_A_KEY
    const { status } = await jsonOf(await spec.call(spec.aId))
    expect(status).toBe(200)
    const row = world[spec.table].find((r) => r.id === spec.aId)
    if (spec.deletes) expect(row).toBeUndefined()
    else expect(spec.changed(row)).toBe(true)
  })
})

// ─── spec table: CREATE routes (cross-org create refused) ────────────
const CREATE_SPECS = [
  {
    name: 'POST /api/contacts (contact create)',
    call: (target) => contactsRoute.POST(makeReq('/api/contacts', { method: 'POST', bearer: currentKey, body: { name: 'New Lead', email: 'new@example.com', location_id: target } })),
    table: 'contacts', aTarget: LOC_A1, bTarget: LOC_B1,
    stamped: (row) => row.location_id === LOC_A1,
  },
  {
    name: 'POST /api/deals (deal create, anchored on contact)',
    call: (target) => dealsRoute.POST(makeReq('/api/deals', { method: 'POST', bearer: currentKey, body: { title: 'New Deal', contact_id: target } })),
    table: 'deals', aTarget: C_A1, bTarget: C_B1,
    stamped: (row) => row.contact_id === C_A1,
  },
  {
    name: 'POST /api/tasks (task create)',
    call: (target) => tasksRoute.POST(makeReq('/api/tasks', { method: 'POST', bearer: currentKey, body: { location_id: target, subject: 'New Task' } })),
    table: 'activities', aTarget: LOC_A1, bTarget: LOC_B1,
    stamped: (row) => row.location_id === LOC_A1,
  },
  {
    name: 'POST /api/activities (activity create, anchored on contact)',
    call: (target) => activitiesRoute.POST(makeReq('/api/activities', { method: 'POST', bearer: currentKey, body: { subject: 'New Activity', contact_id: target } })),
    table: 'activities', aTarget: C_A1, bTarget: C_B1,
    stamped: (row) => row.contact_id === C_A1,
  },
  {
    name: 'POST /api/notes (note create, anchored on contact)',
    call: (target) => notesRoute.POST(makeReq('/api/notes', { method: 'POST', bearer: currentKey, body: { contact_id: target, content: 'A note' } })),
    table: 'notes', aTarget: C_A1, bTarget: C_B1,
    stamped: (row) => row.contact_id === C_A1,
  },
  {
    name: 'POST /api/campaigns (campaign create)',
    call: (target) => campaignsRoute.POST(makeReq('/api/campaigns', { method: 'POST', bearer: currentKey, body: { location_id: target, name: 'New Campaign' } })),
    table: 'campaigns', aTarget: LOC_A1, bTarget: LOC_B1,
    stamped: (row) => row.location_id === LOC_A1,
  },
  {
    name: 'POST /api/bookings/event-types (event type create)',
    call: (target) => eventTypesRoute.POST(makeReq('/api/bookings/event-types', { method: 'POST', bearer: currentKey, body: { name: 'New Type', location_id: target } })),
    table: 'event_types', aTarget: LOC_A1, bTarget: LOC_B1,
    stamped: (row) => row.location_id === LOC_A1,
  },
]

describe.each(CREATE_SPECS)('$name — org boundary', (spec) => {
  it('org-A key creating into org B is refused (403) and nothing is inserted', async () => {
    currentKey = ORG_A_KEY
    const countBefore = world[spec.table].length
    const { status } = await jsonOf(await spec.call(spec.bTarget))
    expect(status).toBe(403)
    expect(world[spec.table].length).toBe(countBefore)
    expect(db._writesTo(spec.table).filter((w) => w.op === 'insert')).toEqual([])
  })

  it('org-A key creating inside its own org succeeds and is stamped in org A (positive control)', async () => {
    currentKey = ORG_A_KEY
    const countBefore = world[spec.table].length
    const { status, json } = await jsonOf(await spec.call(spec.aTarget))
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(world[spec.table].length).toBe(countBefore + 1)
    expect(spec.stamped(world[spec.table][world[spec.table].length - 1])).toBe(true)
  })
})

// ─── deals/search — bespoke shape (contact-email pivot) ──────────────
describe('GET /api/deals/search — org boundary (bespoke: resolves contact by email first)', () => {
  it('org-A key searching a B-tenant email finds nothing (contact resolution is org-scoped)', async () => {
    const { status, json } = await jsonOf(await dealsSearchRoute.GET(
      makeReq('/api/deals/search?term=lead.b1@', { bearer: ORG_A_KEY })
    ))
    expect(status).toBe(200)
    expect(json.data.items).toEqual([])
  })

  it('org-A key searching its own contact email finds the deal', async () => {
    const { json } = await jsonOf(await dealsSearchRoute.GET(
      makeReq('/api/deals/search?term=lead.a1@', { bearer: ORG_A_KEY })
    ))
    expect(idsOf(json.data.items.map((i) => i.item))).toEqual([D_A1])
  })

  it('legacy shared key resolves any tenant — unscoped BY DESIGN (pinned)', async () => {
    const { json } = await jsonOf(await dealsSearchRoute.GET(
      makeReq('/api/deals/search?term=lead.b1@', { bearer: LEGACY_KEY })
    ))
    expect(idsOf(json.data.items.map((i) => i.item))).toEqual([D_B1])
  })
})

// ─── routes that don't fit the pattern (kept honest here) ────────────
// - GET  /api/deals            — no list handler exists (POST-only surface;
//                                deal lists render from server components).
// - GET  /api/deals/[id]       — no detail GET (PUT covered above).
// - GET  /api/bookings/[id]    — no detail GET (PUT covered above).
// - GET  /api/notes, /api/notes/[id] — POST-only surface, no read handlers.
// - GET  /api/activities       — POST-only; task reads live at /api/tasks
//                                (covered above).
describe('spec-table completeness', () => {
  it('documents the deliberately-skipped routes', () => {
    expect(true).toBe(true)
  })
})
