// Route test for the shelly-reconcile cron (SHELLY.9).
//
// The sweep itself is tested in src/lib/shelly/reconcile.test.js; the only
// things that live in the route are the CRON_SECRET gate, the heartbeat stamp
// (which must carry the counters, not just the timestamp), and the
// `out.ok !== false` mapping onto `success`. Sonos ships no route test, so
// these three are new rather than mirrored.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeDb = { __brand: 'db' }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/shelly/reconcile', () => ({ runShellyReconcile: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { GET } from './route.js'
import { runShellyReconcile } from '@/lib/shelly/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  runShellyReconcile.mockResolvedValue({ ok: true, locations: 0 })
})

describe('GET /api/cron/shelly-reconcile', () => {
  it('rejects a missing or wrong bearer without running the sweep', async () => {
    expect((await GET(req('Bearer nope'))).status).toBe(401)
    expect((await GET(req(''))).status).toBe(401)
    expect(runShellyReconcile).not.toHaveBeenCalled()
  })

  it('stamps the heartbeat with the run outcome, not a bare timestamp', async () => {
    const out = { ok: true, locations: 2, parked: 1, applied: 3, failed: 0, elapsedMs: 812 }
    runShellyReconcile.mockResolvedValue(out)

    const body = await (await GET(req())).json()

    expect(runShellyReconcile).toHaveBeenCalledWith(fakeDb)
    // The counters are the whole point of the second argument — a stamp
    // without them cannot tell "ran, 0 connections" from "ran, 12 failed".
    expect(stampHeartbeat).toHaveBeenCalledWith('shelly-reconcile', out)
    expect(body).toMatchObject({ success: true, ...out })
  })

  it('success mirrors ok !== false: false only on an explicit ok:false', async () => {
    runShellyReconcile.mockResolvedValue({ ok: false, reason: 'bad_clock' })
    expect(await (await GET(req())).json()).toMatchObject({ success: false, reason: 'bad_clock' })

    runShellyReconcile.mockResolvedValue({ ok: false })
    expect((await (await GET(req())).json()).success).toBe(false)

    // A result carrying no `ok` key is NOT a failure — a dormant deploy must
    // not page. Same reasoning as the sonos-reconcile route.
    runShellyReconcile.mockResolvedValue({ skipped: 'dormant' })
    expect(await (await GET(req())).json()).toMatchObject({ success: true, skipped: 'dormant' })

    // The heartbeat stamps on every one of those, failures included.
    expect(stampHeartbeat).toHaveBeenCalledTimes(3)
  })
})
