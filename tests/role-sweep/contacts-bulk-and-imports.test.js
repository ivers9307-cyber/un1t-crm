// ROLESWEEP.1c — the MANAGER_ROLES contact routes (export, impact, push to
// Glofox, contact DELETE, bulk delete, the import history) and the
// owner-only merge judge the role at the contact's / batch's / query's
// location, never at the caller's ACTIVE studio (`user.role`).
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
import { roleCases } from '../helpers/role-sweep-callers.js'
import { ownerCases } from '../helpers/role-sweep-callers-c.js'
import * as contactExport from '@/app/api/contacts/[id]/export/route.js'
import * as impact from '@/app/api/contacts/[id]/impact/route.js'
import * as pushToGlofox from '@/app/api/contacts/[id]/push-to-glofox/route.js'
import * as contact from '@/app/api/contacts/[id]/route.js'
import * as bulkDelete from '@/app/api/contacts/bulk-delete/route.js'
import * as imports from '@/app/api/contacts/imports/route.js'
import * as importBatch from '@/app/api/contacts/imports/[id]/route.js'
import * as errorCsv from '@/app/api/contacts/imports/[id]/error-csv/route.js'
import * as merge from '@/app/api/contacts/merge/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'
const OTHER_ID = 'c0000000-0000-4000-8000-000000000002'
const BATCH_ID = 'c0000000-0000-4000-8000-000000000003'
const CONTACT = (loc) => [{ data: { id: CONTACT_ID, name: 'Member One', email: 'member.one@example.com', location_id: loc, glofox_member_id: null }, error: null }]

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const CASES = roleCases(MANAGER_ROLES)
const HC_PLUS = { status: 403, body: { success: false, error: 'Head coach, manager, owner, or master required' } }
const DIFFERENT_LOCATION = { status: 403, body: { success: false, error: 'Contact is at a different location' } }
const MANAGER_REQUIRED = { status: 403, body: { success: false, error: 'Manager+ required' } }

beforeEach(() => vi.clearAllMocks())

describeGate('GET /api/contacts/[id]/export', {
  call: () => contactExport.GET(bare('GET'), params({ id: CONTACT_ID })),
  gateReads: CONTACT,
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_FOUND, cases: CASES,
}, T)
describeGate('GET /api/contacts/[id]/impact', {
  call: () => impact.GET(bare('GET'), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: MANAGER_REQUIRED,
  hidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  cases: CASES,
}, T)
describeGate('POST /api/contacts/[id]/push-to-glofox', {
  call: () => pushToGlofox.POST(bare('POST'), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: HC_PLUS, hidden: DIFFERENT_LOCATION, cases: CASES,
}, T)
describeGate('DELETE /api/contacts/[id]', {
  call: () => contact.DELETE(bare('DELETE'), params({ id: CONTACT_ID })),
  gateReads: CONTACT, forbidden: HC_PLUS, hidden: DIFFERENT_LOCATION, cases: CASES,
}, T)

// PUT /api/contacts/[id] is pinned, every row, in tests/role-sweep/api-key-or-manager.test.js
// (ROLESWEEP.2: the shared requireApiKeyOrManager is now a coarse pre-check).

// Bulk delete answers 200 with a per-row breakdown: a row whose location the
// caller does not belong to lands in forbidden[] as 'Different location'; a
// row where they lack MANAGER_ROLES now lands there as 'Role'. A row that is
// let through reaches the GDPR scrub (the first db call past the gate). The
// coarse pre-check still answers 403 for a caller who is a manager+ nowhere.
describe('POST /api/contacts/bulk-delete (MANAGER_ROLES judged per row)', () => {
  const skipped = (reason) => ({
    status: 200,
    body: { success: true, data: { requested: 1, deleted: 0, blocked: [], forbidden: [{ id: CONTACT_ID, name: 'Member One', reason }], missing: [] } },
  })
  const want = { forbidden: skipped('Role'), hidden: skipped('Different location') }
  it.each(CASES)('%s', async (_label, caller, target, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe([{ data: [{ id: CONTACT_ID, name: 'Member One', location_id: target }], error: null }])
    createServerClient.mockReturnValue(probe.db)
    const { status, body } = await runProbed(probe, () => bulkDelete.POST(json('POST', { contact_ids: [CONTACT_ID] })))
    if (outcome === 'pass') {
      expect(probe.passed, `refused: ${status} ${JSON.stringify(body)}`).toBe(true)
      return
    }
    expect(probe.passed, `got past the gate (${probe.tripped?.kind} ${probe.tripped?.table})`).toBe(false)
    expect({ status, body }).toEqual(want[outcome])
  })
})

describeGate('GET /api/contacts/imports?location_id=', {
  call: (loc) => imports.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: MANAGER_REQUIRED,
  hidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  cases: CASES,
}, T)
const BATCH = (loc) => [{ data: { id: BATCH_ID, location_id: loc, source_filename: 'members.csv', created_at: '2026-09-01T00:00:00Z' }, error: null }]
const IMPORT_NOT_FOUND = NOT_FOUND
describeGate('GET /api/contacts/imports/[id]', {
  call: () => importBatch.GET(bare('GET'), params({ id: BATCH_ID })),
  gateReads: BATCH, forbidden: MANAGER_REQUIRED, hidden: IMPORT_NOT_FOUND, cases: CASES,
}, T)
describeGate('GET /api/contacts/imports/[id]/error-csv', {
  call: () => errorCsv.GET(bare('GET'), params({ id: BATCH_ID })),
  gateReads: BATCH, forbidden: MANAGER_REQUIRED, hidden: IMPORT_NOT_FOUND, cases: CASES,
}, T)

describeGate('POST /api/contacts/merge (owner at the contacts\' location)', {
  call: () => merge.POST(json('POST', { survivor_id: CONTACT_ID, loser_id: OTHER_ID })),
  gateReads: (loc) => [{ data: [
    { id: CONTACT_ID, location_id: loc, name: 'Member One' },
    { id: OTHER_ID, location_id: loc, name: 'Member One (dup)' },
  ], error: null }],
  forbidden: { status: 403, body: { success: false, error: 'Owner or master required' } },
  hidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  cases: ownerCases(),
}, T)
