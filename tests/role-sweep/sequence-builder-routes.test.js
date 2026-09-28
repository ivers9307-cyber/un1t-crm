// SEQROUTEGATE.1 — every /api/sequences builder route checks the builder's
// permission (email OR whatsapp, the /automations/[id] page's own gate) AT the
// sequence's location, after membership. Before this, the routes checked
// membership only: any member of a studio, plain staff included, could create,
// rewrite, publish, activate or delete its sequences, and the two GETs returned
// webhook_token / webhook_secret to them.
// Harness: tests/helpers/role-gate-probe.js (a refused caller never reaches a
// DB/network call past the gate reads; an allowed one gets past the gate).
// Synthetic data only.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import {
  person, LOC_A, LOC_B, MASTER, OUTSIDER, MANAGER_A_STAFF_B, STAFF_A_MANAGER_B,
} from '../helpers/role-sweep-callers.js'
import * as list from '@/app/api/sequences/route.js'
import * as detail from '@/app/api/sequences/[id]/route.js'
import * as graph from '@/app/api/sequences/[id]/graph/route.js'
import * as publish from '@/app/api/sequences/[id]/graph/publish/route.js'
import * as agent from '@/app/api/sequences/[id]/graph/agent/route.js'
import * as steps from '@/app/api/sequences/[id]/steps/route.js'
import * as step from '@/app/api/sequences/[id]/steps/[stepId]/route.js'
import * as seqTest from '@/app/api/sequences/[id]/test/route.js'
import * as runs from '@/app/api/sequences/[id]/runs/route.js'
import * as stats from '@/app/api/sequences/[id]/stats/route.js'
import * as fromTemplate from '@/app/api/sequences/from-template/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs ? `?${qs}` : ''}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })

const SEQ_ID = '5e000000-0000-4000-8000-0000000000a1'
const STEP_ID = '5e000000-0000-4000-8000-0000000000a2'
const SEQ_ROW = (loc) => [{
  data: { id: SEQ_ID, location_id: loc, name: 'Welcome', status: 'draft', trigger_type: 'manual', trigger_config: {}, graph: null, draft_graph: null, sequence_steps: [] },
  error: null,
}]

const NO_PERMISSION = { status: 403, body: { success: false, error: 'Email or WhatsApp permission required' } }
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const MANAGER_REQUIRED = { status: 403, body: { success: false, error: 'Manager+ required' } }

// ── callers (target LOC_B) ─────────────────────────────────────────────────
const STAFF_BOTH = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff' } }, LOC_A)
const OWNER_A_BOTH_OFF_AT_B = person({
  [LOC_A]: { role: 'owner' },
  [LOC_B]: { role: 'owner', permissions: { email: false, whatsapp: false } },
}, LOC_A)
const OWNER_B_WHATSAPP_ONLY = person({
  [LOC_A]: { role: 'staff' },
  [LOC_B]: { role: 'owner', permissions: { email: false, whatsapp: true } },
}, LOC_A)
const RECEPTION_B = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'reception' } }, LOC_A)

// The builder rule alone (routes with no role floor).
const CASES = [
  ['staff at B, manager at A, A active (main: pass)', MANAGER_A_STAFF_B, LOC_B, 'forbidden'],
  ['staff at both studios (main: pass)', STAFF_BOTH, LOC_B, 'forbidden'],
  ['owner at B with email and whatsapp both off (main: pass)', OWNER_A_BOTH_OFF_AT_B, LOC_B, 'forbidden'],
  ['manager at B, staff at A, A active', STAFF_A_MANAGER_B, LOC_B, 'pass'],
  ['owner at B with whatsapp only (the page admits it)', OWNER_B_WHATSAPP_ONLY, LOC_B, 'pass'],
  ['reception at B (whatsapp by default)', RECEPTION_B, LOC_B, 'pass'],
  ['a master', MASTER, LOC_B, 'pass'],
  ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
]
// test / runs / stats keep Manager+ (ROLESWEEP.1a, pinned in
// email-and-sequences.test.js) and now also need the builder rule.
const MANAGER_CASES = [
  ['owner at B with email and whatsapp both off (main: pass)', OWNER_A_BOTH_OFF_AT_B, LOC_B, 'forbidden'],
  ['reception at B (below Manager+)', RECEPTION_B, LOC_B, 'managerOnly'],
  ['manager at B, staff at A, A active', STAFF_A_MANAGER_B, LOC_B, 'pass'],
  ['owner at B with whatsapp only', OWNER_B_WHATSAPP_ONLY, LOC_B, 'pass'],
  ['a master', MASTER, LOC_B, 'pass'],
  ['an owner who does not belong to B', OUTSIDER, LOC_B, 'hidden'],
]

beforeEach(() => vi.clearAllMocks())

// ── routes on a sequence row (detail → 404 for outsiders) ─────────────────
const id = { id: SEQ_ID }
const ROW_ROUTES = [
  ['GET /api/sequences/[id]', () => detail.GET(bare('GET'), params(id))],
  ['PUT /api/sequences/[id]', () => detail.PUT(json('PUT', { name: 'Renamed' }), params(id))],
  ['PUT /api/sequences/[id] (activate)', () => detail.PUT(json('PUT', { status: 'active' }), params(id))],
  ['DELETE /api/sequences/[id]', () => detail.DELETE(bare('DELETE'), params(id))],
  ['GET /api/sequences/[id]/graph', () => graph.GET(bare('GET'), params(id))],
  ['PUT /api/sequences/[id]/graph', () => graph.PUT(json('PUT', { graph: { nodes: [], edges: [] } }), params(id))],
  ['DELETE /api/sequences/[id]/graph', () => graph.DELETE(bare('DELETE'), params(id))],
  ['POST /api/sequences/[id]/graph/publish', () => publish.POST(json('POST', {}), params(id))],
  ['POST /api/sequences/[id]/graph/agent', () => agent.POST(json('POST', { prompt: '' }), params(id))],
  ['GET /api/sequences/[id]/steps', () => steps.GET(bare('GET'), params(id))],
  ['POST /api/sequences/[id]/steps', () => steps.POST(json('POST', { step_type: 'email', subject: 'Hi' }), params(id))],
  ['PUT /api/sequences/[id]/steps', () => steps.PUT(json('PUT', { steps: [{ id: STEP_ID, step_order: 1 }] }), params(id))],
  ['PUT /api/sequences/[id]/steps/[stepId]', () => step.PUT(json('PUT', { subject: 'Hello' }), params({ id: SEQ_ID, stepId: STEP_ID }))],
  ['DELETE /api/sequences/[id]/steps/[stepId]', () => step.DELETE(bare('DELETE'), params({ id: SEQ_ID, stepId: STEP_ID }))],
]
for (const [title, call] of ROW_ROUTES) {
  describeGate(`${title} (email or whatsapp at the sequence)`, {
    call, gateReads: SEQ_ROW, forbidden: NO_PERMISSION, hidden: NOT_FOUND, cases: CASES,
  }, T)
}

for (const [title, call] of [
  ['POST /api/sequences/[id]/test', () => seqTest.POST(bare('POST'), params(id))],
  ['GET /api/sequences/[id]/runs', () => runs.GET(bare('GET'), params(id))],
  ['GET /api/sequences/[id]/stats', () => stats.GET(bare('GET'), params(id))],
]) {
  describeGate(`${title} (Manager+ and email or whatsapp at the sequence)`, {
    call, gateReads: SEQ_ROW, forbidden: NO_PERMISSION, managerOnly: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: MANAGER_CASES,
  }, T)
}

// ── routes on a query/body location (403 for outsiders) ───────────────────
describeGate('GET /api/sequences?location_id= (email or whatsapp there)', {
  call: (loc) => list.GET(bare('GET', `location_id=${loc}`)),
  forbidden: NO_PERMISSION, hidden: NOT_MEMBER, cases: CASES,
}, T)
describeGate('POST /api/sequences (email or whatsapp at body.location_id)', {
  call: (loc) => list.POST(json('POST', { name: 'New flow', location_id: loc })),
  forbidden: NO_PERMISSION, hidden: NOT_MEMBER, cases: CASES,
}, T)
describeGate('POST /api/sequences/from-template (email or whatsapp at body.location_id)', {
  call: (loc) => fromTemplate.POST(json('POST', { template_id: 'first_booking_welcome', location_id: loc })),
  forbidden: NO_PERMISSION, hidden: NOT_MEMBER, cases: CASES,
}, T)

// ── the edges ──────────────────────────────────────────────────────────────
async function probed(caller, handler, gateReads = []) {
  getCurrentUser.mockResolvedValue(caller)
  const probe = gateProbe(gateReads)
  createServerClient.mockReturnValue(probe.db)
  const out = await runProbed(probe, handler)
  return { probe, ...out }
}

describe('GET /api/sequences with no location_id', () => {
  it('lists only the member studios where the caller may build sequences', async () => {
    const caller = person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, LOC_B)
    const { probe } = await probed(caller, () => list.GET(bare('GET')))
    expect(probe.passed).toBe(true)
    expect(probe.tripped.chain.find((c) => c[0] === 'in')).toEqual(['in', 'location_id', [LOC_A]])
  })

  it('refuses staff everywhere before reading anything', async () => {
    const { probe, status, body } = await probed(STAFF_BOTH, () => list.GET(bare('GET')))
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual(NO_PERMISSION)
  })
})

describe('POST /api/sequences with no location at all', () => {
  it('is refused (400), never a location-less sequence', async () => {
    const caller = { ...STAFF_A_MANAGER_B, activeLocation: null }
    const { probe, status, body } = await probed(caller, () => list.POST(json('POST', { name: 'New flow' })))
    expect(probe.passed).toBe(false)
    expect({ status, body }).toEqual({ status: 400, body: { success: false, error: 'location_id required' } })
  })
})

describe('GET /api/sequences/from-template (the template list)', () => {
  it('needs a session', async () => {
    const { status } = await probed(null, () => fromTemplate.GET(bare('GET')))
    expect(status).toBe(401)
  })

  it('refuses staff everywhere', async () => {
    const { status, body } = await probed(STAFF_BOTH, () => fromTemplate.GET(bare('GET')))
    expect({ status, body }).toEqual(NO_PERMISSION)
  })

  it('lists the templates for someone who may build sequences', async () => {
    const { status, body } = await probed(STAFF_A_MANAGER_B, () => fromTemplate.GET(bare('GET')))
    expect(status).toBe(200)
    expect(body.data.length).toBeGreaterThan(0)
  })
})
