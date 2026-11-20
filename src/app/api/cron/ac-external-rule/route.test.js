// Route test for the ac-external-rule cron.
//
// Focus: when the rule FIRES (external start past its expected_off_at), the
// audit event must carry the device as a resource target WITHOUT a target.id.
// audit_events.target_profile_id has an FK to profiles — passing the device
// UUID there violates audit_events_target_profile_id_fkey and the audit row
// is silently dropped, so every automated auto-off vanished from the trail.
//
// planExternalRule is the real implementation (pure decision logic); the
// vendor adapters, DB and side-effect helpers are stubbed per the cron
// route-test convention (see auto-end-stale-hr-sessions).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// One thenable builder per from() call: chain methods no-op, awaiting
// resolves the table's rows, maybeSingle resolves the first row or null.
let tables = {}
let tableErrors = {}
function makeBuilder(rows, error = null) {
  const b = {}
  for (const m of ['select', 'eq', 'not', 'order', 'limit', 'in']) b[m] = () => b
  b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
  b.then = (resolve) => Promise.resolve({ data: error ? null : rows, error }).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(tables[t] ?? [], tableErrors[t] ?? null) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/ac-devices', () => ({
  loadDeviceWithLocation: vi.fn(),
  vendorGetState: vi.fn(),
  vendorTurnOff: vi.fn(),
  // SENSIBO-RATE.1 — this cron now banks each poll into
  // ac_devices.last_state so the AC panel can read the DB instead of
  // polling the vendor every 30s per open card.
  cacheDeviceState: vi.fn(async () => {}),
}))
vi.mock('@/lib/ac-external-rule', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    upsertExternalStart: vi.fn(async () => ({ ok: true })),
    clearExternalStart: vi.fn(async () => ({ ok: true })),
  }
})

import { GET } from './route.js'
import { logAuditEvent } from '@/lib/audit'
import { loadDeviceWithLocation, vendorGetState, vendorTurnOff } from '@/lib/ac-devices'
import { clearExternalStart } from '@/lib/ac-external-rule'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const DEVICE = {
  id: 'dev-1', location_id: 'loc-1', label: 'Studio AC',
  provider: 'sensibo', provider_device_id: 'pod-1',
  enabled: true, external_auto_off_minutes: 60,
}

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  tables = {}
  tableErrors = {}
  vi.clearAllMocks()
  loadDeviceWithLocation.mockResolvedValue({ ok: true, device: DEVICE, location: { id: 'loc-1' } })
  vendorGetState.mockResolvedValue({ ok: true, state: { on: true } })
  vendorTurnOff.mockResolvedValue({ ok: true })
})

describe('GET /api/cron/ac-external-rule', () => {
  it('rejects a missing/wrong bearer', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run with nothing to do stamps the heartbeat', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).stats).toMatchObject({ devices_checked: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('ac-external-rule')
  })

  it('a failed device read answers 500 with a fixed line, does not stamp, and leaks no DB text', async () => {
    tableErrors = { ac_devices: { message: 'permission denied for table ac_devices' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read AC devices' })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(vendorGetState).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('fire path: audits ac.external_auto_off with a device resource target and no target.id', async () => {
    tables = {
      ac_devices: [DEVICE],
      ac_sessions: [],
      ac_external_starts: [{
        device_id: 'dev-1',
        first_seen_at: '2026-07-17T09:00:00.000Z',
        expected_off_at: '2026-07-17T10:00:00.000Z', // long past → fire
      }],
    }
    const res = await GET(req())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, stats: expect.objectContaining({ fired: 1 }) })
    expect(vendorTurnOff).toHaveBeenCalledTimes(1)
    expect(clearExternalStart).toHaveBeenCalledWith(fakeDb, 'dev-1')

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'ac.external_auto_off',
      target: expect.objectContaining({ label: 'Studio AC', resource: 'ac_device/dev-1' }),
      locationId: 'loc-1',
    }))
    // Device ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
    expect(stampHeartbeat).toHaveBeenCalledWith('ac-external-rule')
  })
})
