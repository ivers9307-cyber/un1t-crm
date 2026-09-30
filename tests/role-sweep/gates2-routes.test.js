// C116 GATES-2 — routes that took no channel permission at all.
//
// Each was membership-only (any member of the row's studio passed), so the
// "(main: …)" notes permissionCases carries are dropped: on main every one of
// these callers passed. Each route now asks the channel the way its send
// sibling does: at SOME studio first (a cheap 403), then at the row's studio.
//   • /api/templates and /api/templates/[id] (email templates) → `email`
//   • /api/whatsapp/broadcasts/[id] GET/PUT/DELETE and /pause → `whatsapp`
//     (the rule of /api/whatsapp/broadcasts/[id]/send)
//   • /api/campaigns/[id]/resend DELETE → `email` (the rule of /send)
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
import { describeGate } from '../helpers/role-gate-probe.js'
import { permissionCases, person, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as templates from '@/app/api/templates/route.js'
import * as template from '@/app/api/templates/[id]/route.js'
import * as broadcast from '@/app/api/whatsapp/broadcasts/[id]/route.js'
import * as pause from '@/app/api/whatsapp/broadcasts/[id]/pause/route.js'
import * as resend from '@/app/api/campaigns/[id]/resend/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]
// On main these routes had no permission check: every member passed.
const noMainNotes = (key) => permissionCases(key)
  .map(([label, ...rest]) => [label.replace(/ \(main: [a-z]+\)$/, ''), ...rest])

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const EMAIL_FORBIDDEN = { status: 403, body: { success: false, error: 'No email permission at this location' } }
const WA_FORBIDDEN = { status: 403, body: { success: false, error: 'Forbidden — WhatsApp not enabled' } }
const BODY_HIDDEN = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }

beforeEach(() => vi.clearAllMocks())

// ── email templates ────────────────────────────────────────────────────────
describeGate('GET /api/templates/[id] (email at the template)', {
  call: () => template.GET(bare('GET'), params({ id: 'et-1' })),
  gateReads: row({ id: 'et-1' }),
  forbidden: EMAIL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('email'),
}, T)
describeGate('PUT /api/templates/[id] (email at the template)', {
  call: () => template.PUT(json('PUT', { name: 'Welcome' }), params({ id: 'et-1' })),
  gateReads: row({}),
  forbidden: EMAIL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('email'),
}, T)
describeGate('DELETE /api/templates/[id] (email at the template)', {
  call: () => template.DELETE(bare('DELETE'), params({ id: 'et-1' })),
  gateReads: row({}),
  forbidden: EMAIL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('email'),
}, T)
describeGate('GET /api/templates?location_id= (email at that studio)', {
  call: (loc) => templates.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: EMAIL_FORBIDDEN, hidden: BODY_HIDDEN, cases: noMainNotes('email'),
}, T)
describeGate('POST /api/templates (email at the studio it creates at)', {
  call: (loc) => templates.POST(json('POST', { name: 'Welcome', location_id: loc })),
  forbidden: EMAIL_FORBIDDEN, hidden: BODY_HIDDEN, cases: noMainNotes('email'),
}, T)

// ── WhatsApp broadcasts ────────────────────────────────────────────────────
describeGate('GET /api/whatsapp/broadcasts/[id] (whatsapp at the broadcast)', {
  call: () => broadcast.GET(bare('GET'), params({ id: 'wb-1' })),
  gateReads: row({ id: 'wb-1' }),
  forbidden: WA_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)
describeGate('PUT /api/whatsapp/broadcasts/[id] (whatsapp at the broadcast)', {
  call: () => broadcast.PUT(json('PUT', { name: 'Spring' }), params({ id: 'wb-1' })),
  gateReads: row({ status: 'draft', scheduled_at: null }),
  forbidden: WA_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)
describeGate('DELETE /api/whatsapp/broadcasts/[id] (whatsapp at the broadcast)', {
  call: () => broadcast.DELETE(bare('DELETE'), params({ id: 'wb-1' })),
  gateReads: row({ status: 'draft', scheduled_at: null }),
  forbidden: WA_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)
describeGate('POST /api/whatsapp/broadcasts/[id]/pause (whatsapp at the broadcast)', {
  call: () => pause.POST(json('POST', { paused: true }), params({ id: 'wb-1' })),
  gateReads: row({ id: 'wb-1' }),
  forbidden: WA_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('whatsapp'),
}, T)

// ── campaign resend ────────────────────────────────────────────────────────
describeGate('DELETE /api/campaigns/[id]/resend (email at the campaign)', {
  call: () => resend.DELETE(bare('DELETE'), params({ id: 'camp-1' })),
  gateReads: row({ id: 'camp-1', resend_enabled: true }),
  forbidden: EMAIL_FORBIDDEN, hidden: NOT_FOUND, cases: noMainNotes('email'),
}, T)

// The coarse pre-check: holding the channel NOWHERE is refused before any
// read, so it cannot confirm that an id exists.
describe('the channel held nowhere is refused before any read', () => {
  const nowhere = (key) => person({ [LOC_A]: { role: 'owner', permissions: { [key]: false } }, [LOC_B]: { role: 'owner', permissions: { [key]: false } } }, LOC_A)
  const cases = [
    ['GET /api/templates/[id]', 'email', () => template.GET(bare('GET'), params({ id: 'et-1' })), EMAIL_FORBIDDEN],
    ['PUT /api/whatsapp/broadcasts/[id]', 'whatsapp', () => broadcast.PUT(json('PUT', { name: 'x' }), params({ id: 'wb-1' })), WA_FORBIDDEN],
    ['POST /api/whatsapp/broadcasts/[id]/pause', 'whatsapp', () => pause.POST(json('POST', { paused: true }), params({ id: 'wb-1' })), WA_FORBIDDEN],
    ['DELETE /api/campaigns/[id]/resend', 'email', () => resend.DELETE(bare('DELETE'), params({ id: 'camp-1' })), EMAIL_FORBIDDEN],
  ]
  it.each(cases)('%s', async (_label, key, call, expected) => {
    getCurrentUser.mockResolvedValue(nowhere(key))
    const from = vi.fn()
    createServerClient.mockReturnValue({ from })
    const res = await call()
    expect({ status: res.status, body: await res.json() }).toEqual(expected)
    expect(from).not.toHaveBeenCalled()
  })
})
