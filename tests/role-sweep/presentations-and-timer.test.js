// ROLESWEEP.1a — presentation decks and the class timer judge
// `presentations` / `class_timer` at the deck's, run's, template's or body's
// location, never at the caller's ACTIVE studio (`hasPermission(user, …)`).
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
import { permissionCases } from '../helpers/role-sweep-callers.js'
import * as advance from '@/app/api/presentations/[id]/advance/route.js'
import * as deck from '@/app/api/presentations/[id]/route.js'
import * as slide from '@/app/api/presentations/[id]/slides/[slideId]/route.js'
import * as reorder from '@/app/api/presentations/[id]/slides/reorder/route.js'
import * as slides from '@/app/api/presentations/[id]/slides/route.js'
import * as decks from '@/app/api/presentations/route.js'
import * as control from '@/app/api/timer/runs/[id]/control/route.js'
import * as runs from '@/app/api/timer/runs/route.js'
import * as template from '@/app/api/timer/templates/[id]/route.js'
import * as templates from '@/app/api/timer/templates/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]

const UUID = '9e000000-0000-4000-8000-000000000001'
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const NO_DECKS = { status: 403, body: { success: false, error: 'Not authorised for presentations' } }
const NO_TIMER = { status: 403, body: { success: false, error: 'Unauthorized' } }
const DECK = row({ id: 'deck-1', title: 'Deck', view_token: 't', current_index: 0, version: 1 })
const P = permissionCases('presentations')
const C = permissionCases('class_timer')

beforeEach(() => vi.clearAllMocks())

describeGate('POST /api/presentations/[id]/advance', {
  call: () => advance.POST(json('POST', { index: 0 }), params({ id: 'deck-1' })),
  gateReads: DECK, forbidden: NO_DECKS, hidden: NOT_FOUND, cases: P,
}, T)
describeGate('GET /api/presentations/[id]', {
  call: () => deck.GET(bare('GET'), params({ id: 'deck-1' })),
  gateReads: DECK, forbidden: NO_DECKS, hidden: NOT_FOUND, cases: P,
}, T)
describeGate('DELETE /api/presentations/[id]', {
  call: () => deck.DELETE(bare('DELETE'), params({ id: 'deck-1' })),
  gateReads: DECK, forbidden: NO_DECKS, hidden: NOT_FOUND, cases: P,
}, T)
describeGate('DELETE /api/presentations/[id]/slides/[slideId]', {
  call: () => slide.DELETE(bare('DELETE'), params({ id: 'deck-1', slideId: 'slide-1' })),
  gateReads: DECK, forbidden: NO_DECKS, hidden: NOT_FOUND, cases: P,
}, T)
describeGate('PUT /api/presentations/[id]/slides/reorder', {
  call: () => reorder.PUT(json('PUT', { order: [UUID] }), params({ id: 'deck-1' })),
  gateReads: DECK, forbidden: NO_DECKS, hidden: NOT_FOUND, cases: P,
}, T)
describeGate('POST /api/presentations/[id]/slides', {
  call: () => slides.POST(new Request('http://localhost/api/x', { method: 'POST', body: new FormData() }), params({ id: 'deck-1' })),
  gateReads: DECK, forbidden: NO_DECKS, hidden: NOT_FOUND, cases: P,
}, T)
describeGate('GET /api/presentations?location_id=', {
  call: (loc) => decks.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: NO_DECKS,
  hidden: { status: 403, body: { success: false, error: 'Location not in your scope' } }, cases: P,
}, T)
describeGate('POST /api/presentations', {
  call: (loc) => decks.POST(json('POST', { location_id: loc, title: 'Deck' })),
  forbidden: NO_DECKS, hidden: NOT_MEMBER, cases: P,
}, T)

describeGate('POST /api/timer/runs/[id]/control', {
  call: () => control.POST(json('POST', { action: 'pause' }), params({ id: 'run-1' })),
  gateReads: row({ id: 'run-1', status: 'running' }), forbidden: NO_TIMER, hidden: NOT_FOUND, cases: C,
}, T)
describeGate('POST /api/timer/runs', {
  call: (loc) => runs.POST(json('POST', { location_id: loc, template_id: UUID })),
  forbidden: NO_TIMER, hidden: NOT_MEMBER, cases: C,
}, T)
const TPL = row({ id: 'tpl-1', name: 'EMOM', structure: [], total_seconds: 0, glofox_program: null })
describeGate('GET /api/timer/templates/[id]', {
  call: () => template.GET(bare('GET'), params({ id: 'tpl-1' })),
  gateReads: TPL, forbidden: NO_TIMER, hidden: NOT_FOUND, cases: C,
}, T)
describeGate('PUT /api/timer/templates/[id]', {
  call: () => template.PUT(json('PUT', {}), params({ id: 'tpl-1' })),
  gateReads: TPL, forbidden: NO_TIMER, hidden: NOT_FOUND, cases: C,
}, T)
describeGate('DELETE /api/timer/templates/[id]', {
  call: () => template.DELETE(bare('DELETE'), params({ id: 'tpl-1' })),
  gateReads: TPL, forbidden: NO_TIMER, hidden: NOT_FOUND, cases: C,
}, T)
describeGate('GET /api/timer/templates?location_id=', {
  call: (loc) => templates.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: NO_TIMER, hidden: NOT_MEMBER, cases: C,
}, T)
describeGate('POST /api/timer/templates', {
  call: (loc) => templates.POST(json('POST', { location_id: loc, name: 'EMOM', structure: [{}] })),
  forbidden: NO_TIMER, hidden: NOT_MEMBER, cases: C,
}, T)
