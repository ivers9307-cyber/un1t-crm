// ROLESWEEP.1a — campaign test sends, email drafts, list-health decisions and
// every sequence route judge the role / permission at the location they act
// on (the campaign's, the sequence's, the escalation's, the body's), never at
// the caller's ACTIVE studio (`user.role`, `hasPermission(user, …)`).
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
import { ADMIN_ROLES, MANAGER_ROLES } from '@/lib/schemas'
import { describeGate, gateProbe } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases, OUTSIDER, LOC_B } from '../helpers/role-sweep-callers.js'
import * as sendTest from '@/app/api/campaigns/[id]/send-test/route.js'
import * as emailDraft from '@/app/api/communications/email-draft/route.js'
import * as release from '@/app/api/communications/list-health/[id]/release/route.js'
import * as suppress from '@/app/api/communications/list-health/[id]/suppress/route.js'
import * as seed from '@/app/api/sequences/[id]/audience/seed/route.js'
import * as clone from '@/app/api/sequences/[id]/clone/route.js'
import * as enrol from '@/app/api/sequences/[id]/enrol/route.js'
import * as exit from '@/app/api/sequences/[id]/enrollments/[enrollmentId]/exit/route.js'
import * as resume from '@/app/api/sequences/[id]/enrollments/[enrollmentId]/resume/route.js'
import * as runs from '@/app/api/sequences/[id]/runs/route.js'
import * as stats from '@/app/api/sequences/[id]/stats/route.js'
import * as seqTest from '@/app/api/sequences/[id]/test/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method) => new Request('http://localhost/api/x', { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]

const SEQ_ID = '5e000000-0000-4000-8000-000000000001'
const ENROL_ID = '5e000000-0000-4000-8000-000000000002'
const ESC_ID = '5e000000-0000-4000-8000-000000000003'
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const FORBIDDEN_PLAIN = { status: 403, body: { success: false, error: 'Forbidden' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const MANAGER_REQUIRED = { status: 403, body: { success: false, error: 'Manager+ required' } }
const EMAIL_REQUIRED = { status: 403, body: { success: false, error: 'Email permission required' } }

beforeEach(() => vi.clearAllMocks())

describeGate('POST /api/campaigns/[id]/send-test (ADMIN_ROLES at the campaign)', {
  call: () => sendTest.POST(json('POST', {}), params({ id: 'cam-1' })),
  gateReads: row({ id: 'cam-1', subject: 'Hello', html_content: '<p>Hi</p>', locations: { name: 'Studio' } }),
  forbidden: { status: 403, body: { success: false, error: 'Admin only' } },
  hidden: NOT_FOUND, cases: roleCases(ADMIN_ROLES),
}, T)

describeGate('POST /api/communications/email-draft (email at body.location_id)', {
  call: (loc) => emailDraft.POST(json('POST', { location_id: loc, name: 'Autumn' })),
  forbidden: { status: 403, body: { success: false, error: 'No email permission at this location' } },
  hidden: NOT_MEMBER, cases: permissionCases('email'),
}, T)

for (const [name, mod] of [['release', release], ['suppress', suppress]]) {
  describeGate(`POST /api/communications/list-health/[id]/${name} (email at the escalation)`, {
    call: () => mod.POST(bare('POST'), params({ id: ESC_ID })),
    gateReads: row({ id: ESC_ID, contact_id: 'c-1', decision: 'review', released_at: null }),
    forbidden: FORBIDDEN_PLAIN, hidden: NOT_FOUND, cases: permissionCases('email'),
  }, T)
}

const SEQ_ROW = row({ id: SEQ_ID, name: 'Welcome', status: 'active', trigger_type: 'audience_match', audience_filter: { logic: 'and', filters: [] }, audience_seeded_at: null, sequence_steps: [] })

describeGate('POST /api/sequences/[id]/audience/seed — role at the sequence', {
  call: () => seed.POST(json('POST', { confirm_count: 0 }), params({ id: SEQ_ID })),
  gateReads: SEQ_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES, 'email'),
}, T)
describeGate('POST /api/sequences/[id]/audience/seed — email at the sequence', {
  call: () => seed.POST(json('POST', { confirm_count: 0 }), params({ id: SEQ_ID })),
  gateReads: SEQ_ROW, forbidden: EMAIL_REQUIRED, hidden: NOT_FOUND, cases: permissionCases('email'),
}, T)
describeGate('DELETE /api/sequences/[id]/audience/seed', {
  call: () => seed.DELETE(bare('DELETE'), params({ id: SEQ_ID })),
  gateReads: SEQ_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES),
}, T)

describeGate('POST /api/sequences/[id]/clone (email at the source)', {
  call: () => clone.POST(bare('POST'), params({ id: SEQ_ID })),
  gateReads: SEQ_ROW, forbidden: EMAIL_REQUIRED, hidden: NOT_FOUND, cases: permissionCases('email'),
}, T)

describeGate('POST /api/sequences/[id]/enrol (email at the sequence)', {
  call: () => enrol.POST(json('POST', { contact_ids: ['11111111-1111-4111-8111-111111111111'] }), params({ id: SEQ_ID })),
  // SEQPAGEGATE.1 — another studio's sequence is 404 Not found, like a missing one (was 403).
  gateReads: SEQ_ROW, forbidden: EMAIL_REQUIRED, hidden: NOT_FOUND, cases: permissionCases('email'),
}, T)

for (const [name, mod] of [['exit', exit], ['resume', resume]]) {
  describeGate(`POST /api/sequences/[id]/enrollments/[enrollmentId]/${name}`, {
    call: () => mod.POST(bare('POST'), params({ id: SEQ_ID, enrollmentId: ENROL_ID })),
    gateReads: SEQ_ROW, forbidden: EMAIL_REQUIRED, hidden: NOT_FOUND, cases: permissionCases('email'),
  }, T)
}

// SEQPAGEGATE.1 — a missing sequence and another studio's must be the same
// answer, or the status confirms that an id exists.
describe('enrol / exit / resume: missing and foreign sequences are indistinguishable', () => {
  const cases = [
    ['enrol', () => enrol.POST(json('POST', { contact_ids: ['11111111-1111-4111-8111-111111111111'] }), params({ id: SEQ_ID }))],
    ['exit', () => exit.POST(bare('POST'), params({ id: SEQ_ID, enrollmentId: ENROL_ID }))],
    ['resume', () => resume.POST(bare('POST'), params({ id: SEQ_ID, enrollmentId: ENROL_ID }))],
  ]
  it.each(cases)('%s', async (_name, call) => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    createServerClient.mockReturnValue(gateProbe([{ data: null, error: null }]).db)
    const missing = await call()
    createServerClient.mockReturnValue(gateProbe([{ data: { id: SEQ_ID, location_id: LOC_B, name: 'x' }, error: null }]).db)
    const foreign = await call()
    expect(missing.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
  })

  it.each(cases)('%s: a failed sequence read is a 500, not "not found"', async (_name, call) => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    createServerClient.mockReturnValue(gateProbe([{ data: null, error: { code: '57014', message: 'timeout' } }]).db)
    expect((await call()).status).toBe(500)
  })

  it.each([
    ['enrol', () => enrol.POST(json('POST', { contact_ids: ['11111111-1111-4111-8111-111111111111'] }), params({ id: 'not-a-uuid' }))],
    ['exit', () => exit.POST(bare('POST'), params({ id: 'not-a-uuid', enrollmentId: ENROL_ID }))],
    ['resume', () => resume.POST(bare('POST'), params({ id: 'not-a-uuid', enrollmentId: ENROL_ID }))],
  ])('%s: a non-uuid sequence id is 404 Not found without a read', async (_name, call) => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const probe = gateProbe([])
    createServerClient.mockReturnValue(probe.db)
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND.body)
    expect(probe.reads).toEqual([])
    expect(probe.passed).toBe(false)
  })
})

for (const [name, handler] of [['runs', () => runs.GET(bare('GET'), params({ id: SEQ_ID }))],
                               ['stats', () => stats.GET(bare('GET'), params({ id: SEQ_ID }))],
                               ['test', () => seqTest.POST(bare('POST'), params({ id: SEQ_ID }))]]) {
  describeGate(`/api/sequences/[id]/${name} (MANAGER_ROLES at the sequence)`, {
    call: handler, gateReads: SEQ_ROW, forbidden: MANAGER_REQUIRED, hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES),
  }, T)
}
