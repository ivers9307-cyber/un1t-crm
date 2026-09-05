// SAAS-10 — cross-tenant boundary harness: the session (cookie-auth)
// route surface.
//
// Same posture as api-key-routes.test.js: real handlers + real guard
// helpers (assertLocationAccess and friends run un-mocked from
// @/lib/auth) against the two-tenant world; only getCurrentUser is
// swapped for the persona under test. The double serves BOTH tenants'
// rows, so a handler that forgets its location/org filter receives org
// B's data and fails the assertion.
//
// Personas: staff/manager/owner at A1, owner at B1 (the adversary for
// owner-gated org resources), the SAAS-4 org-admin of A (reaches A1+A2,
// never B), and master (reaches everything).
//
// Every boundary here HOLDS against current code. A case may carry a
// `leak: '<why>'` note, which flips its runner to it.fails — used to pin
// a KNOWN-still-open leak (the assertion states the CORRECT boundary and
// is expected to fail until the route is fixed, at which point you delete
// the `leak` note to promote it to a live `it`). None are open right now:
// the SAAS-1..12 remediation closed the batch this harness first found.
// Do NOT weaken an assertion to make it pass.
//
// ADDING A ROUTE: one spec entry (call + cases) in SESSION_SPECS.

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
vi.mock('@/lib/sequences', () => ({
  triggerSequencesForTagsAdded: vi.fn(async () => {}),
  triggerSequencesForPipelineStageChange: vi.fn(async () => {}),
}))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => {}) }))
// DELBLOCK.1 — DELETE /api/contacts/[id] now runs a blocker check before the
// scrubs and FAILS CLOSED (503) when it cannot answer. This file is about the
// TENANT boundary, not the FK boundary, so the impact is stubbed clean; the
// blocker behaviour is pinned in src/app/api/contacts/[id]/route.test.js.
vi.mock('@/lib/contact-merge', () => ({
  redactWhatsAppForContact: vi.fn(async () => {}),
  redactInBodyForContact: vi.fn(async () => {}),
  getContactImpact: vi.fn(async () => ({
    cascade_on_delete: [], keep_on_delete: [], redact_on_delete: [], block_delete: [],
    total_rows: 0, partial: false,
  })),
}))
// MAIL-GDPR.1 — the mail scrub runs on the DELETE path too; stubbed for the
// same reason contact-merge is: this suite proves the tenant boundary, and the
// scrub's own behaviour is pinned in src/lib/contact-mail-erasure.test.js.
vi.mock('@/lib/contact-mail-erasure', () => ({
  redactMailForContact: vi.fn(async () => ({ ok: true, failures: [], tickets: 0, messages: 0, attachments: 0 })),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: vi.fn(async ({ query }) => ({ query })),
  InvalidAudienceFilterError: class InvalidAudienceFilterError extends Error {},
}))
vi.mock('@/lib/contact-crossovers', () => ({ crossoverContactIds: vi.fn(async () => []), fetchCrossoverContext: vi.fn(async () => ({})) }))
vi.mock('@/lib/person-links', () => ({ attachLinkedCounts: vi.fn(async (_db, rows) => rows) }))
vi.mock('@/lib/staff-write', () => ({ sparsifyAssignmentPermissions: vi.fn((x) => x) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'http://localhost:3000') }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  makeWorld, makeTenantDb, makeReq, jsonOf, propsOf, idsOf, users,
  ORG_A, ORG_B,
  LOC_A1, LOC_A2, LOC_B1,
  C_A1, C_A2, C_B1,
  STG_A1, STG_A2, STG_B1, STG_B2,
  TPL_A, TPL_B,
  ET_B1,
  SHD_A1, SHD_B1,
  SHELLY_KEY_A1, SHELLY_KEY_B1, SHELLY_FP_A1, SHELLY_FP_B1, SHELLY_HOST_A1, SHELLY_HOST_B1,
  P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_STAFF_B1, P_OWNER_B1, P_STAFF_B2,
} from './fixture.js'

import * as contactsSearchRoute from '@/app/api/contacts/search/route.js'
import * as contactDetailRoute from '@/app/api/contacts/[id]/route.js'
import * as staffRoute from '@/app/api/staff/route.js'
import * as contractTemplatesRoute from '@/app/api/contract-templates/route.js'
import * as contractTemplateDetailRoute from '@/app/api/contract-templates/[id]/route.js'
import * as chooserSettingsRoute from '@/app/api/chooser-settings/route.js'
import * as stagesRoute from '@/app/api/stages/route.js'
import * as eventTypeDetailRoute from '@/app/api/bookings/event-types/[id]/route.js'
// SHELLY-UI.9 — the three /api/shelly handlers that make NO cloud call at all
// (verified against the route sources: the list, the PATCH and the connection
// GET touch only the database), so the db double alone exercises them and
// neither @/lib/shelly/client nor @/lib/shelly/connections needs stubbing.
// The adopt/discover/toggle/run-now/refresh handlers DO call the cloud and are
// pinned in their own colocated route tests; adding one here would be a test
// of a mock rather than of the tenant boundary.
import * as shellyConnectionRoute from '@/app/api/shelly/connection/route.js'
import * as shellyDevicesRoute from '@/app/api/shelly/devices/route.js'
import * as shellyDeviceDetailRoute from '@/app/api/shelly/devices/[id]/route.js'

// A pristine second copy of the world, never handed to a route. The blocked
// mutation cases below diff the live row against this to assert BYTE
// identity — stronger than checking the one field the attacker sent, which
// would pass a route that wrote `updated_at` (or anything else) before
// noticing the row was not its own.
const PRISTINE = makeWorld()
const pristineJson = (table, id) => JSON.stringify(PRISTINE[table].find((r) => r.id === id))

let world
let db

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(getCurrentUser).mockReset()
  delete process.env.CRM_API_KEY // cookie path only — no bearer fallthrough
  world = makeWorld()
  db = makeTenantDb(world)
  vi.mocked(createServerClient).mockReturnValue(db)
})

// ─── spec table ──────────────────────────────────────────────────────
// One entry per route; each case is { title, persona, expectStatus?
// (default 200), expectIds?, verify?, leak? }. `leak` pins a CURRENTLY
// FAILING boundary (see header) via it.fails.

const SESSION_SPECS = [
  {
    name: 'POST /api/contacts/search (session contacts list)',
    call: (c) => contactsSearchRoute.POST(makeReq('/api/contacts/search', { method: 'POST', body: c.body ?? {} })),
    ids: (json) => idsOf(json?.contacts),
    cases: [
      { title: 'staff at A1 sees only A1 contacts (defaults to active location)', persona: 'staffA1', expectIds: [C_A1] },
      { title: 'staff at A1 requesting an org-B location is refused (403)', persona: 'staffA1', body: { location_id: LOC_B1 }, expectStatus: 403 },
      { title: 'org admin of A reaches its second location A2', persona: 'orgAdminA', body: { location_id: LOC_A2 }, expectIds: [C_A2] },
      { title: 'org admin of A cannot reach org B (403)', persona: 'orgAdminA', body: { location_id: LOC_B1 }, expectStatus: 403 },
      { title: 'master reaches org B', persona: 'master', body: { location_id: LOC_B1 }, expectIds: [C_B1] },
    ],
  },
  {
    name: 'GET /api/staff (staff list)',
    call: () => staffRoute.GET(),
    ids: (json) => idsOf(json?.data),
    cases: [
      { title: 'staff at A1 sees only A1 colleagues, never org B', persona: 'staffA1', expectIds: [P_STAFF_A1, P_MGR_A1, P_OWNER_A1] },
      { title: 'owner at B1 sees only B1 staff (mirror)', persona: 'ownerB1', expectIds: [P_STAFF_B1, P_OWNER_B1] },
      { title: 'org admin of A sees A1+A2 staff, never org B', persona: 'orgAdminA', expectIds: [P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2] },
      { title: 'master sees every location’s staff', persona: 'master', expectIds: [P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_STAFF_B1, P_OWNER_B1, P_STAFF_B2] },
    ],
  },
  {
    name: 'GET /api/contract-templates (org-scoped list)',
    call: () => contractTemplatesRoute.GET(),
    ids: (json) => idsOf(json?.data),
    cases: [
      { title: 'owner of A sees only org-A templates', persona: 'ownerA1', expectIds: [TPL_A] },
      { title: 'owner of B sees only org-B templates (mirror)', persona: 'ownerB1', expectIds: [TPL_B] },
      { title: 'org admin of A sees org-A templates', persona: 'orgAdminA', expectIds: [TPL_A] },
      { title: 'master sees every org’s templates', persona: 'master', expectIds: [TPL_A, TPL_B] },
      { title: 'staff is refused outright (403)', persona: 'staffA1', expectStatus: 403 },
    ],
  },
  {
    name: 'GET /api/contract-templates/[id] (org-scoped detail)',
    call: (c) => contractTemplateDetailRoute.GET(makeReq(`/api/contract-templates/${c.id}`), propsOf({ id: c.id })),
    cases: [
      { title: 'owner of A reads their own template', persona: 'ownerA1', id: TPL_A, verify: ({ json }) => expect(json.data.id).toBe(TPL_A) },
      {
        title: 'owner of B fetching an org-A template must get 404',
        persona: 'ownerB1', id: TPL_A, expectStatus: 404,
        verify: ({ json }) => expect(JSON.stringify(json)).not.toContain('ORG A SALARY TERMS'),
      },
    ],
  },
  {
    name: 'PATCH /api/contract-templates/[id] (org-scoped update)',
    call: (c) => contractTemplateDetailRoute.PATCH(makeReq(`/api/contract-templates/${c.id}`, { method: 'PATCH', body: { name: 'Hacked Template' } }), propsOf({ id: c.id })),
    cases: [
      {
        title: 'owner of B patching an org-A template must get 404 and the row must be untouched',
        persona: 'ownerB1', id: TPL_A, expectStatus: 404,
        verify: ({ world: w }) => expect(w.contract_templates.find((t) => t.id === TPL_A).name).toBe('Org A Contract'),
      },
    ],
  },
  {
    name: 'DELETE /api/contract-templates/[id] (org-scoped soft delete)',
    call: (c) => contractTemplateDetailRoute.DELETE(makeReq(`/api/contract-templates/${c.id}`, { method: 'DELETE' }), propsOf({ id: c.id })),
    cases: [
      {
        title: 'owner of B soft-deleting an org-A template must get 404 and the template must stay active',
        persona: 'ownerB1', id: TPL_A, expectStatus: 404,
        verify: ({ world: w }) => expect(w.contract_templates.find((t) => t.id === TPL_A).active).toBe(true),
      },
    ],
  },
  {
    name: 'GET /api/stages (session list)',
    call: () => stagesRoute.GET(makeReq('/api/stages')),
    ids: (json) => idsOf(json?.data),
    cases: [
      {
        title: 'a manager’s session must not see another tenant’s pipeline stages',
        persona: 'managerA1',
        verify: ({ json }) => {
          const ids = idsOf(json?.data)
          expect(ids).not.toContain(STG_B1)
          expect(ids).not.toContain(STG_B2)
        },
      },
      { title: 'master sees every tenant’s stages', persona: 'master', expectIds: [STG_A1, STG_A2, STG_B1, STG_B2] },
    ],
  },
  {
    name: 'PUT /api/contacts/[id] (session contact update)',
    call: (c) => contactDetailRoute.PUT(makeReq(`/api/contacts/${c.id}`, { method: 'PUT', body: { name: 'Hacked Name' } }), propsOf({ id: c.id })),
    cases: [
      {
        title: 'manager at A1 updating a cross-tenant contact gets 404 and the row is untouched',
        persona: 'managerA1', id: C_B1, expectStatus: 404,
        verify: ({ world: w }) => expect(w.contacts.find((r) => r.id === C_B1).name).toBe('Bob B-One Lead'),
      },
      {
        title: 'manager at A1 updating their own contact succeeds (positive control)',
        persona: 'managerA1', id: C_A1,
        verify: ({ world: w }) => expect(w.contacts.find((r) => r.id === C_A1).name).toBe('Hacked Name'),
      },
      {
        title: 'master may update any tenant’s contact (platform tier, pinned)',
        persona: 'master', id: C_B1,
        verify: ({ world: w }) => expect(w.contacts.find((r) => r.id === C_B1).name).toBe('Hacked Name'),
      },
    ],
  },
  {
    name: 'DELETE /api/contacts/[id] (session contact delete)',
    call: (c) => contactDetailRoute.DELETE(makeReq(`/api/contacts/${c.id}`, { method: 'DELETE' }), propsOf({ id: c.id })),
    cases: [
      {
        title: 'manager at A1 deleting a cross-tenant contact is refused and the row survives',
        persona: 'managerA1', id: C_B1, expectStatus: 403,
        verify: ({ world: w }) => expect(w.contacts.some((r) => r.id === C_B1)).toBe(true),
      },
      { title: 'plain staff cannot delete at all (role gate)', persona: 'staffA1', id: C_A1, expectStatus: 403 },
      {
        title: 'master may delete any tenant’s contact (platform tier, pinned)',
        persona: 'master', id: C_B1,
        verify: ({ world: w }) => expect(w.contacts.some((r) => r.id === C_B1)).toBe(false),
      },
    ],
  },
  {
    name: 'GET /api/bookings/event-types/[id] (session detail)',
    call: (c) => eventTypeDetailRoute.GET(makeReq(`/api/bookings/event-types/${c.id}`), propsOf({ id: c.id })),
    cases: [
      {
        title: 'a manager’s session fetching another tenant’s event type must get 404',
        persona: 'managerA1', id: ET_B1, expectStatus: 404,
      },
    ],
  },
  {
    name: 'PUT /api/bookings/event-types/[id] (session update)',
    call: (c) => eventTypeDetailRoute.PUT(makeReq(`/api/bookings/event-types/${c.id}`, { method: 'PUT', body: { name: 'Hacked Type' } }), propsOf({ id: c.id })),
    cases: [
      {
        title: 'a manager’s session updating another tenant’s event type must get 404 and the row must be untouched',
        persona: 'managerA1', id: ET_B1, expectStatus: 404,
        verify: ({ world: w }) => expect(w.event_types.find((r) => r.id === ET_B1).name).toBe('Consult B1'),
      },
    ],
  },
  {
    name: 'GET /api/chooser-settings (per-org — SAAS-6)',
    // SAAS-6 (mig 414) made the chooser per-ORGANIZATION: read = org
    // membership, and an explicit ?organization_id for a FOREIGN org is
    // 404. A caller with no param resolves their own activeOrganization.
    call: (c) => chooserSettingsRoute.GET(
      makeReq('/api/chooser-settings' + (c.orgParam ? `?organization_id=${c.orgParam}` : '')),
    ),
    cases: [
      // Read tier is org membership, so staff read their OWN org's
      // chooser (pre-SAAS-6 this route was role-gated and 403'd staff).
      { title: 'staff at A1 reads their own org’s chooser', persona: 'staffA1', verify: ({ json }) => expect(json.data.chooser.organization_id).toBe(ORG_A) },
      // The per-org boundary SAAS-6 added: owner of B may not read org A's.
      { title: 'owner of B targeting org A’s chooser gets 404', persona: 'ownerB1', orgParam: ORG_A, expectStatus: 404 },
      { title: 'master may read any org’s chooser', persona: 'master', orgParam: ORG_B, verify: ({ json }) => expect(json.data.chooser.organization_id).toBe(ORG_B) },
    ],
  },
  {
    name: 'PUT /api/chooser-settings (tile writes are per-location)',
    call: () => chooserSettingsRoute.PUT(makeReq('/api/chooser-settings', {
      method: 'PUT',
      body: { tile_order: [], tiles: [{ location_id: LOC_A1, public_path: 'a-one', chooser_label: 'Hacked by B' }] },
    })),
    cases: [
      {
        title: 'owner of B must not be able to rewrite an org-A location’s tile',
        persona: 'ownerB1',
        expectStatus: null, // status is not the boundary here — the write is
        verify: ({ world: w }) => expect(
          w.landing_page_settings.find((t) => t.location_id === LOC_A1).chooser_label
        ).toBe('A One Original'),
      },
    ],
  },
  {
    // SHELLY-UI.9 — the smart-plug surface. Every /api/shelly route scopes by
    // the SESSION's active location (no route accepts a location_id at all),
    // so the boundary here is entirely the WHERE clause: the double serves
    // both tenants' shelly_devices rows, and a handler that dropped its
    // .eq('location_id', …) would receive org B's plugs and fail.
    name: 'GET /api/shelly/devices (session list)',
    call: () => shellyDevicesRoute.GET(makeReq('/api/shelly/devices')),
    ids: (json) => idsOf(json?.devices),
    cases: [
      {
        title: 'manager at A1 sees only A1’s adopted plugs',
        persona: 'managerA1', expectIds: [SHD_A1],
        verify: ({ json }) => {
          expect(JSON.stringify(json)).not.toContain('bb11cc22dd31') // B1's relay MAC
          expectNoShellySecrets(json)
        },
      },
      {
        title: 'owner at B1 sees only B1’s adopted plugs (mirror)',
        persona: 'ownerB1', expectIds: [SHD_B1],
        verify: ({ json }) => {
          expect(JSON.stringify(json)).not.toContain('aa11bb22cc31') // A1's relay MAC
          expectNoShellySecrets(json)
        },
      },
      // Not a tenant boundary but the gate that stands in front of it:
      // device_control is false for staff by default (shared/permissions.js),
      // so a front-desk session never reaches the query at all.
      { title: 'staff at A1 holds no device_control and is refused (403)', persona: 'staffA1', expectStatus: 403 },
    ],
  },
  {
    name: 'PATCH /api/shelly/devices/[id] (session device update)',
    call: (c) => shellyDeviceDetailRoute.PATCH(
      makeReq(`/api/shelly/devices/${c.id}`, { method: 'PATCH', body: { name: 'Hacked Plug', enabled: false } }),
      propsOf({ id: c.id }),
    ),
    cases: [
      {
        title: 'owner of B patching an A1 device gets 404, the row is byte-identical, and no write was issued',
        persona: 'ownerB1', id: SHD_A1, expectStatus: 404,
        verify: ({ world: w, db: d, json }) => {
          expect(JSON.stringify(w.shelly_devices.find((r) => r.id === SHD_A1)))
            .toBe(pristineJson('shelly_devices', SHD_A1))
          // The tenant filter is on the WRITE as well as the read, so the
          // route must not even have issued an UPDATE it then found matched
          // nothing — a zero-row UPDATE is not an error in PostgREST.
          expect(d._writesTo('shelly_devices')).toHaveLength(0)
          // 404 for a foreign id and 404 for a malformed one carry the same
          // body — the property that makes ids un-enumerable.
          expect(json).toEqual({ success: false, error: 'Not found' })
        },
      },
      {
        title: 'owner of A1 patching their own device succeeds (positive control)',
        persona: 'ownerA1', id: SHD_A1,
        verify: ({ world: w }) => {
          expect(w.shelly_devices.find((r) => r.id === SHD_A1).name).toBe('Hacked Plug')
          expect(w.shelly_devices.find((r) => r.id === SHD_B1).name).toBe('B One Heater')
        },
      },
    ],
  },
  {
    name: 'DELETE /api/shelly/devices/[id] (session un-adopt)',
    call: (c) => shellyDeviceDetailRoute.DELETE(
      makeReq(`/api/shelly/devices/${c.id}`, { method: 'DELETE' }),
      propsOf({ id: c.id }),
    ),
    cases: [
      {
        // DELETE is the destructive half of the same loader, and it CASCADES
        // the device's energy history (mig 562) — so a cross-tenant delete
        // that got through would not merely un-adopt another business's plug,
        // it would destroy months of their kWh readings with no way back.
        title: 'owner of B deleting an A1 device gets 404, the row survives byte-identical, and no delete was issued',
        persona: 'ownerB1', id: SHD_A1, expectStatus: 404,
        verify: ({ world: w, db: d, json }) => {
          expect(w.shelly_devices.some((r) => r.id === SHD_A1)).toBe(true)
          expect(JSON.stringify(w.shelly_devices.find((r) => r.id === SHD_A1)))
            .toBe(pristineJson('shelly_devices', SHD_A1))
          expect(d._writesTo('shelly_devices')).toHaveLength(0)
          expect(json).toEqual({ success: false, error: 'Not found' })
        },
      },
      {
        title: 'owner of A1 removing their own device succeeds, and B1’s is untouched (positive control)',
        persona: 'ownerA1', id: SHD_A1,
        verify: ({ world: w }) => {
          expect(w.shelly_devices.some((r) => r.id === SHD_A1)).toBe(false)
          expect(w.shelly_devices.some((r) => r.id === SHD_B1)).toBe(true)
        },
      },
    ],
  },
  {
    name: 'GET /api/shelly/connection (session connection view)',
    call: () => shellyConnectionRoute.GET(makeReq('/api/shelly/connection')),
    cases: [
      {
        title: 'manager at A1 reads A1’s connection but may not manage it',
        persona: 'managerA1',
        verify: ({ json }) => {
          expect(json.connection.host).toBe(SHELLY_HOST_A1)
          expect(json.connection.has_auth_key).toBe(true)
          // The affordance, not the enforcement: PUT/DELETE are additionally
          // master-or-owner gated inside the handlers.
          expect(json.can_manage).toBe(false)
          expect(json.device_count).toBe(1)
          expectNoShellySecrets(json)
        },
      },
      {
        title: 'owner at A1 may manage the same connection',
        persona: 'ownerA1',
        verify: ({ json }) => {
          expect(json.can_manage).toBe(true)
          expectNoShellySecrets(json)
        },
      },
      {
        title: 'owner of B sees only B1’s connection — never A1’s host, key or fingerprint',
        persona: 'ownerB1',
        verify: ({ json }) => {
          expect(json.connection.host).toBe(SHELLY_HOST_B1)
          expect(json.device_count).toBe(1)
          const body = JSON.stringify(json)
          expect(body).not.toContain(SHELLY_HOST_A1)
          expect(body).not.toContain('aaa1') // A1's key_hint
          expectNoShellySecrets(json)
        },
      },
    ],
  },
]

// Neither the auth key NOR its fingerprint may appear in any Shelly response.
// The fingerprint is a sha256 OF the key, so publishing it would turn "is this
// the account?" into an offline check anyone holding a candidate key can run —
// connections.js treats the two as equally secret. The double hands the route
// the WHOLE row regardless of the columns it selects, so the only thing
// standing between these strings and the response is publicConnectionView's
// allowlist, which is exactly what this asserts.
function expectNoShellySecrets(json) {
  const body = JSON.stringify(json)
  for (const secret of [SHELLY_KEY_A1, SHELLY_KEY_B1, SHELLY_FP_A1, SHELLY_FP_B1]) {
    expect(body).not.toContain(secret)
  }
}

// ─── shared assertion loop ───────────────────────────────────────────
for (const spec of SESSION_SPECS) {
  describe(`${spec.name} — tenant boundary`, () => {
    for (const c of spec.cases) {
      const runner = c.leak ? it.fails : it
      const title = c.leak ? `KNOWN LEAK (${c.leak}) — ${c.title}` : c.title
      runner(title, async () => {
        vi.mocked(getCurrentUser).mockResolvedValue(users[c.persona]())
        const { status, json } = await jsonOf(await spec.call(c))
        if (c.expectStatus !== null) expect(status).toBe(c.expectStatus ?? 200)
        if (c.expectIds) expect(spec.ids(json)).toEqual([...c.expectIds].sort())
        if (c.verify) c.verify({ world, db, json, status })
      })
    }
  })
}
