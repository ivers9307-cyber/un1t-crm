// Route test for the ac-auto-off cron (C7 remainder).
//
// Focus: failed rows retry on a BACKOFF (not every 5-minute tick) via
// `updated_at < failedRetryCutoffIso(now)` on a separate pickup query, and a
// vendor failure raises a sendOpsAlert (org email / master-push fallback)
// instead of a bare console.warn. The DB, vendor adapters and side-effect
// helpers are stubbed per the cron route-test convention (see
// ac-external-rule); the builders RECORD their filter calls so the backoff
// predicate itself is assertable.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FAILED_RETRY_BACKOFF_MS, FAST_RETRY_BACKOFF_MS } from '@/lib/ac-auto-off'

// One recording builder per from() call. Selects on a table consume rowsets
// from a per-table queue (the route issues TWO ac_sessions selects — live
// then failed); updates and overflow selects resolve empty. Every chained
// method is recorded on builder.ops so tests can assert the exact filters.
let queues = {}
let builders = []
function makeBuilder(table, rows) {
  const b = { table, ops: [] }
  for (const m of ['select', 'eq', 'not', 'order', 'limit', 'in', 'lte', 'lt', 'gt', 'update']) {
    b[m] = (...args) => { b.ops.push([m, ...args]); return b }
  }
  b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
  b.then = (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve)
  builders.push(b)
  return b
}
const fakeDb = { from: (t) => makeBuilder(t, (queues[t] && queues[t].shift()) || []) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: vi.fn(async () => ({ channel: 'email', recipients: 1 })) }))
vi.mock('@/lib/ac-devices', () => ({
  loadDeviceWithLocation: vi.fn(),
  vendorTurnOff: vi.fn(),
}))

import { GET } from './route.js'
import { loadDeviceWithLocation, vendorTurnOff } from '@/lib/ac-devices'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const DEVICE = { id: 'dev-1', label: 'Studio AC', provider: 'sensibo', provider_device_id: 'pod-1' }
const LOCATION = { id: 'loc-1', name: 'Stillorgan', organization_id: 'org-1' }
const SESSION = {
  id: 'sess-1', location_id: 'loc-1', device_id: 'dev-1',
  sensibo_pod_id: null, auto_off_at: '2026-08-04T09:00:00.000Z', status: 'on',
}

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}
const sessionSelects = () =>
  builders.filter((b) => b.table === 'ac_sessions' && b.ops.some(([m]) => m === 'select'))
const sessionUpdates = () =>
  builders.filter((b) => b.table === 'ac_sessions' && b.ops.some(([m]) => m === 'update'))

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  queues = {}
  builders = []
  vi.clearAllMocks()
  loadDeviceWithLocation.mockResolvedValue({ ok: true, device: DEVICE, location: LOCATION })
  vendorTurnOff.mockResolvedValue({ ok: true })
})

describe('GET /api/cron/ac-auto-off', () => {
  it('rejects a missing/wrong bearer', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
  })

  it('turns off an expired live session and stamps the heartbeat, no alert', async () => {
    queues = { ac_sessions: [[SESSION], []] } // live pickup, failed pickup
    const res = await GET(req())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, stats: expect.objectContaining({ found: 1, off: 1, failed: 0 }) })
    expect(vendorTurnOff).toHaveBeenCalledTimes(1)
    expect(sendOpsAlert).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('ac-auto-off')
    const upd = sessionUpdates().at(0)
    expect(upd.ops.find(([m]) => m === 'update')[1]).toMatchObject({ status: 'auto_off' })
  })

  it('picks up failed rows on a SEPARATE query gated by updated_at < now − FAST backoff (the hourly lane is applied per row)', async () => {
    const before = Date.now()
    queues = { ac_sessions: [[], []] }
    await GET(req())
    const selects = sessionSelects()
    expect(selects).toHaveLength(2)

    // Live pickup: only the live statuses — failed is NOT in the every-tick set.
    const liveIn = selects[0].ops.find(([m]) => m === 'in')
    expect(liveIn[2]).toEqual(['on', 'extended'])

    // Failed pickup: status=failed AND updated_at older than the backoff window.
    const failedOps = selects[1].ops
    expect(failedOps).toContainEqual(['eq', 'status', 'failed'])
    const lt = failedOps.find(([m, col]) => m === 'lt' && col === 'updated_at')
    expect(lt).toBeTruthy()
    const cutoffMs = new Date(lt[2]).getTime()
    expect(before - cutoffMs).toBeGreaterThanOrEqual(FAST_RETRY_BACKOFF_MS - 1000)
    expect(Date.now() - cutoffMs).toBeLessThanOrEqual(FAST_RETRY_BACKOFF_MS + 1000)
  })

  it('SENSIBO-RATE.1: skips a row a NEWER active session has superseded — no vendor call', async () => {
    // A failed row waits out an hour of backoff. By the time it is
    // retried the device may legitimately be running again (a class
    // fired it, or a staff member did). Turning off on the stale
    // row's behalf would kill a live session mid-class. Exactly this
    // was queued against a live session on 2026-08-31.
    const stale = { ...SESSION, id: 'sess-stale', status: 'failed', started_at: '2026-08-04T07:00:00.000Z' }
    queues = {
      ac_sessions: [
        [],           // live pickup: nothing
        [stale],      // failed pickup: the stale row
        [{ id: 'sess-newer' }],  // supersession probe: a newer active session exists
      ],
    }
    const res = await GET(req())
    const body = await res.json()

    expect(vendorTurnOff).not.toHaveBeenCalled()
    expect(body.stats).toMatchObject({ found: 1, off: 0, failed: 0, skipped: 1 })
    // It must be CLOSED, not left to be retried forever.
    const upd = sessionUpdates().at(-1)
    const patch = upd.ops.find(([m]) => m === 'update')[1]
    expect(patch.status).toBe('auto_off')
    expect(patch.ended_at).toBeTruthy()
    expect(patch.failure_reason).toMatch(/superseded/i)
  })

  it('still self-heals: a due failed row is retried and turned off', async () => {
    const dueHourly = {
      ...SESSION, status: 'failed', failure_reason: 'Pod not found',
      updated_at: new Date(Date.now() - FAILED_RETRY_BACKOFF_MS - 60_000).toISOString(),
    }
    queues = { ac_sessions: [[], [dueHourly]] }
    const res = await GET(req())
    const body = await res.json()
    expect(body.stats).toMatchObject({ found: 1, off: 1, failed: 0 })
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('vendor failure (persistent): row stays failed, attempt counter = 1, AND an org-routed ops alert fires on the FIRST miss', async () => {
    vendorTurnOff.mockResolvedValue({ ok: false, error: 'pod offline' })
    queues = { ac_sessions: [[SESSION], []] }
    const res = await GET(req())
    const body = await res.json()
    expect(body.stats).toMatchObject({ found: 1, off: 0, failed: 1 })

    const upd = sessionUpdates().at(0)
    const payload = upd.ops.find(([m]) => m === 'update')[1]
    expect(payload.status).toBe('failed')
    expect(payload.failure_reason).toContain('pod offline')
    expect(payload.auto_off_attempts).toBe(1)
    expect(payload.auto_off_alerted_at).toBeTruthy()

    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    const [alert, deps] = sendOpsAlert.mock.calls[0]
    expect(alert).toMatchObject({
      organizationId: 'org-1',
      locationId: 'loc-1',
      subject: 'AC auto-off failing at Stillorgan',
    })
    expect(alert.htmlBody).toContain('Studio AC')
    expect(alert.htmlBody).toContain('pod offline')
    expect(deps.db).toBe(fakeDb)
    // The cron still finishes and stamps its heartbeat despite the failure.
    expect(stampHeartbeat).toHaveBeenCalledWith('ac-auto-off')
  })

  // ── AC-RETRY.1 ────────────────────────────────────────────────────
  const TIMEOUT = 'AC vendor refused the request: Sensibo network error: The operation was aborted due to timeout'
  const agoIso = (ms) => new Date(Date.now() - ms).toISOString()

  it('AC-RETRY.1: a transient failure on a live row is counted but NOT alerted (miss #1)', async () => {
    vendorTurnOff.mockResolvedValue({ ok: false, error: TIMEOUT })
    queues = { ac_sessions: [[SESSION], []] }
    const res = await GET(req())
    expect((await res.json()).stats).toMatchObject({ failed: 1 })
    const payload = sessionUpdates().at(0).ops.find(([m]) => m === 'update')[1]
    expect(payload.status).toBe('failed')
    expect(payload.auto_off_attempts).toBe(1)
    expect(payload.auto_off_alerted_at).toBeUndefined()
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('AC-RETRY.1: a transient failed row written one tick ago is retried on THIS tick (fast lane)', async () => {
    const fast = {
      ...SESSION, status: 'failed', failure_reason: TIMEOUT, auto_off_attempts: 1,
      updated_at: agoIso(FAST_RETRY_BACKOFF_MS + 46_000), // written at :05:46, now :10:32
    }
    queues = { ac_sessions: [[], [fast]] }
    const res = await GET(req())
    const body = await res.json()
    expect(vendorTurnOff).toHaveBeenCalledTimes(1)
    expect(body.stats).toMatchObject({ found: 1, off: 1, waiting: 0 })
  })

  it('AC-RETRY.1: a PERSISTENT failed row written one tick ago is left waiting — hourly lane, no vendor call', async () => {
    const slow = {
      ...SESSION, status: 'failed', failure_reason: 'Pod not found', auto_off_attempts: 1,
      updated_at: agoIso(FAST_RETRY_BACKOFF_MS + 46_000),
    }
    queues = { ac_sessions: [[], [slow]] }
    const res = await GET(req())
    const body = await res.json()
    expect(vendorTurnOff).not.toHaveBeenCalled()
    expect(body.stats).toMatchObject({ found: 0, off: 0, failed: 0, waiting: 1 })
  })

  it('AC-RETRY.1: the THIRD consecutive transient miss alerts, stamps auto_off_alerted_at, and names the count', async () => {
    vendorTurnOff.mockResolvedValue({ ok: false, error: TIMEOUT })
    const third = {
      ...SESSION, status: 'failed', failure_reason: TIMEOUT, auto_off_attempts: 2, auto_off_alerted_at: null,
      updated_at: agoIso(FAST_RETRY_BACKOFF_MS + 46_000),
    }
    queues = { ac_sessions: [[], [third]] }
    await GET(req())
    const payload = sessionUpdates().at(-1).ops.find(([m]) => m === 'update')[1]
    expect(payload.auto_off_attempts).toBe(3)
    expect(payload.auto_off_alerted_at).toBeTruthy()
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    const [alert] = sendOpsAlert.mock.calls[0]
    expect(alert.htmlBody).toContain('3 attempts so far')
    expect(alert.htmlBody).toMatch(/every 5 minutes/)
  })

  it('AC-RETRY.1: a miss within an hour of the last alert is counted but stays quiet', async () => {
    vendorTurnOff.mockResolvedValue({ ok: false, error: TIMEOUT })
    const fourth = {
      ...SESSION, status: 'failed', failure_reason: TIMEOUT, auto_off_attempts: 3,
      auto_off_alerted_at: agoIso(5 * 60_000),
      updated_at: agoIso(FAST_RETRY_BACKOFF_MS + 46_000),
    }
    queues = { ac_sessions: [[], [fourth]] }
    await GET(req())
    const payload = sessionUpdates().at(-1).ops.find(([m]) => m === 'update')[1]
    expect(payload.auto_off_attempts).toBe(4)
    expect(payload.auto_off_alerted_at).toBeUndefined()
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('AC-RETRY.1: a success leaves the attempt history on the row (counter is not reset)', async () => {
    const recovered = {
      ...SESSION, status: 'failed', failure_reason: TIMEOUT, auto_off_attempts: 2,
      updated_at: agoIso(FAST_RETRY_BACKOFF_MS + 46_000),
    }
    queues = { ac_sessions: [[], [recovered]] }
    await GET(req())
    const payload = sessionUpdates().at(-1).ops.find(([m]) => m === 'update')[1]
    expect(payload.status).toBe('auto_off')
    expect(payload).not.toHaveProperty('auto_off_attempts')
  })
})
