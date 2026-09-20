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
// COVERLOOP.1 — a table named here resolves { data: null, error } instead.
let tableErrors = {}
function makeBuilder(rows, error = null) {
  const b = {}
  for (const m of ['select', 'eq', 'not', 'lte', 'order', 'limit']) b[m] = () => b
  b.then = (resolve) => Promise.resolve(error ? { data: null, error } : { data: rows, error: null }).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(tables[t] ?? [], tableErrors[t] ?? null) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
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
// COVERLOOP.1 — the swap cover arm. Its behaviour is pinned in
// src/lib/swap-cover-server.test.js; here it is a spy.
vi.mock('@/lib/swap-cover-server', () => ({
  runSwapCoverSweep: vi.fn(async () => ({ open: 2, nudged: 1, expired: 1, skipped: 0, quiet: 0, errors: 0 })),
}))

import { GET } from './route.js'
import { logAuditEvent } from '@/lib/audit'
import { runSwapCoverSweep } from '@/lib/swap-cover-server'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { markIncomplete } from '@/lib/checklist-sweep'
import { sendPush } from '@/lib/push'
import { logError } from '@/lib/log'

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
  tableErrors = {}
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

// COVERLOOP.1 — the swap cover sweep rides this cron (see the route header for
// why). It must run every tick and report its counts, and the two arms must be
// ISOLATED in both directions: neither one failing may stop the other, and a
// failed swap arm must be visible in the response, never a silent success.
describe('GET /api/cron/checklist-sweep — swap cover arm', () => {
  it('runs the swap cover sweep with the cron\'s db and reports its counts', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(runSwapCoverSweep).toHaveBeenCalledTimes(1)
    expect(runSwapCoverSweep).toHaveBeenCalledWith(fakeDb)
    expect(body.swap_cover).toEqual({ open: 2, nudged: 1, expired: 1, skipped: 0, quiet: 0, errors: 0 })
    expect(body.swap_sweep_failed).toBe(0)
    // The arm shares the checklist heartbeat row (a row of its own needs a
    // seed migration), so its outcome rides in last_outcome, where ops and
    // Sentinel can see "ran but the swap arm is broken".
    expect(stampHeartbeat).toHaveBeenCalledWith('checklist-sweep', {
      ...body.stats,
      swap_cover: { open: 2, nudged: 1, expired: 1, skipped: 0, quiet: 0, errors: 0 },
      swap_sweep_failed: 0,
    })
  })

  it('runs it even when no checklist was overdue', async () => {
    tables = { checklist_instances: [] }
    await GET(req())
    expect(runSwapCoverSweep).toHaveBeenCalledTimes(1)
  })

  it('a THROWING swap arm cannot stop the checklist arm: it is logged, flagged in the response, and the heartbeat is still stamped', async () => {
    runSwapCoverSweep.mockRejectedValueOnce(new Error('boom'))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, swap_cover: null, swap_sweep_failed: 1, stats: expect.objectContaining({ swept: 1 }) })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('cron-checklist-sweep', expect.any(String), expect.objectContaining({ err: 'boom' }))
    // The failure is written where a heartbeat reader sees it...
    expect(stampHeartbeat).toHaveBeenCalledWith('checklist-sweep', expect.objectContaining({ swap_cover: null, swap_sweep_failed: 1 }))
    // ...and NOT into the CHECKLIST arm's own error count.
    expect(body.stats.errors).toBe(0)
  })

  it('a swap arm that RETURNS errors (it could not read the open swaps) is flagged too', async () => {
    runSwapCoverSweep.mockResolvedValueOnce({ open: 0, nudged: 0, expired: 0, skipped: 0, quiet: 0, errors: 1 })
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, swap_sweep_failed: 1, swap_cover: expect.objectContaining({ errors: 1 }) })
    expect(stampHeartbeat).toHaveBeenCalledWith('checklist-sweep', expect.objectContaining({ swap_sweep_failed: 1 }))
    expect(body.stats.errors).toBe(0)
  })

  it('an unreadable checklist table cannot stop the swap arm: still a 500, no heartbeat, but the swaps were swept', async () => {
    tableErrors = { checklist_instances: { message: 'checklists down' } }
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toMatchObject({ success: false, error: 'checklists down', swap_sweep_failed: 0 })
    expect(body.swap_cover).toMatchObject({ open: 2 })
    expect(runSwapCoverSweep).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a THROWING checklist arm cannot stop the swap arm either', async () => {
    markIncomplete.mockRejectedValueOnce(new Error('network reset'))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toMatchObject({ success: false, error: 'network reset' })
    expect(body.swap_cover).toMatchObject({ open: 2 })
    expect(runSwapCoverSweep).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron-checklist-sweep', expect.any(String), expect.objectContaining({ err: 'network reset' }))
  })

  it('does not run for an unauthorised caller', async () => {
    await GET(req('Bearer nope'))
    expect(runSwapCoverSweep).not.toHaveBeenCalled()
  })
})
