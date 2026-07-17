// Route test for the checklist-sweep cron.
//
// Focus: the checklist.incomplete audit event. audit_events.target_profile_id
// has an FK to profiles — the old shape passed the checklist_instance UUID as
// target.id, which violated audit_events_target_profile_id_fkey and silently
// dropped every sweep audit row. This is a system action (no actor), so the
// responsible coach's profile id is promoted to target.id (the audit-log UI's
// "Affected user" column/filter) and the instance identity rides in
// target.resource.
//
// The DB and side-effect helpers are stubbed per the cron route-test
// convention (see ac-external-rule).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// One thenable builder per from() call: chain methods no-op, awaiting
// resolves the table's rows.
let tables = {}
function makeBuilder(rows) {
  const b = {}
  for (const m of ['select', 'eq', 'not', 'lte', 'order', 'limit']) b[m] = () => b
  b.then = (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(tables[t] ?? []) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/push', () => ({
  sendPush: vi.fn(async () => ({ sent: 1 })),
  sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 1 })),
}))
vi.mock('@/lib/checklist-sweep', () => ({
  COMPLIANCE_ROLES: ['head_coach', 'owner', 'master'],
  listMissedItems: vi.fn(() => []),
  buildOverdueBody: vi.fn(() => ''),
  isEligibleForSweep: vi.fn(() => ({ eligible: true })),
  markIncomplete: vi.fn(async () => true),
}))

import { GET } from './route.js'
import { logAuditEvent } from '@/lib/audit'

const INSTANCE = {
  id: 'inst-1',
  profile_id: 'prof-coach',
  location_id: 'loc-1',
  template_id: 'tmpl-1',
  date: '2026-07-17',
  status: 'pending',
  deadline_at: '2026-07-17T10:00:00.000Z',
  items: [{ id: 'a' }, { id: 'b' }],
  items_checked: { a: true },
  locations: { id: 'loc-1', name: 'Stillorgan' },
  profiles: { id: 'prof-coach', full_name: 'Casey Coach', role: 'head_coach' },
}

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  tables = { checklist_instances: [INSTANCE] }
  vi.clearAllMocks()
})

describe('GET /api/cron/checklist-sweep', () => {
  it('rejects a missing/wrong bearer', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
  })

  it('audits checklist.incomplete with the coach as target profile and the instance as resource', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, stats: expect.objectContaining({ swept: 1 }) })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'checklist.incomplete',
      // System action → the coach who missed the checklist is the
      // affected user. target.id MUST be a profiles id (FK), and here
      // it genuinely is one — the instance UUID stays in resource.
      target: expect.objectContaining({
        id: 'prof-coach',
        label: 'Casey Coach',
        resource: 'checklist_instance/inst-1',
      }),
      locationId: 'loc-1',
      details: expect.objectContaining({ profile_id: 'prof-coach', items_missed: 1 }),
    }))
  })
})
