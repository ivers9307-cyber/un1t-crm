// UN1TSYNC.8 — the un1t.online → CRM pull cron. Facts pinned:
//   1. 401 without CRON_SECRET;
//   2. a failed discovery is a 500 with NO heartbeat (never "no locations");
//   3. each eligible location runs, sequentially, and ok ones stamp their tenant row;
//   4. a location-level failure (auth, studio mismatch) is COUNTED, not fatal:
//      the cron is healthy, the location is not, so the heartbeat still stamps;
//   5. a thrown exception from one location never stops the next one;
//   6. the heartbeat outcome carries counts by reason only;
//   7. a studio whose sync is already running is skipped, never a failure (UN1THARD.1);
//   8. once the wall-clock budget is spent no further location starts (UN1THARD.4);
//   9. an ok location is followed by the hourly reclassify (HATCHPIPE.2), after its
//      tenant heartbeat; a failed or in-progress one is not, and a rejection from it
//      changes neither the outcome nor the heartbeats.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ discovery: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ marker: 'db' }) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/tenant-heartbeat', () => ({ stampTenantHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/membership/locations-for-source', async (importOriginal) => ({
  ...(await importOriginal()),
  locationsWithSource: vi.fn(async () => h.discovery),
}))
vi.mock('@/lib/un1t-online-sync', () => ({ runUn1tSync: vi.fn() }))
vi.mock('@/lib/un1t-online-welcome', () => ({ sweepUn1tWelcomes: vi.fn() }))
vi.mock('@/lib/un1t-pipeline-cadence', () => ({ maybeReclassifyAfterSync: vi.fn(async () => ({ ran: false, reason: 'recent_run' })) }))

import { GET, BUDGET_MS } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { runUn1tSync } from '@/lib/un1t-online-sync'
import { maybeReclassifyAfterSync } from '@/lib/un1t-pipeline-cadence'
import { sweepUn1tWelcomes } from '@/lib/un1t-online-welcome'
import { logError, logWarn } from '@/lib/log'

const req = (token = 'test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
})
const loc = (id) => ({ id, name: `Studio ${id}`, source: 'un1t_online', state: 'configured' })
const found = (eligible, skipped = []) => ({ locations: [...eligible, ...skipped], eligible, skipped, error: null })

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  stampHeartbeat.mockReset().mockResolvedValue(undefined)
  stampTenantHeartbeat.mockReset().mockResolvedValue(undefined)
  maybeReclassifyAfterSync.mockReset().mockResolvedValue({ ran: false, reason: 'recent_run' })
  sweepUn1tWelcomes.mockReset().mockResolvedValue({ ok: true, skipped_no_sequence: false, checked: 0, enrolled: 0, crm_made: 0, waiting: 0, no_contact: 0, no_email: 0, failed: 0 })
  h.discovery = found([])
})

describe('GET /api/cron/un1t-online-sync', () => {
  it('401 without CRON_SECRET', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    const none = await GET(req(null))
    expect(none.status).toBe(401)
    expect(locationsWithSource).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401 when CRON_SECRET is unset, even for a bare "Bearer undefined"', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req('undefined'))
    expect(res.status).toBe(401)
  })

  it('500 and no heartbeat when discovery fails', async () => {
    h.discovery = { locations: null, eligible: null, skipped: null, error: { message: 'membership_source unreadable' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
    expect(runUn1tSync).not.toHaveBeenCalled()
  })

  it('asks the seam for un1t_online locations', async () => {
    await GET(req())
    expect(locationsWithSource).toHaveBeenCalledWith(expect.anything(), 'un1t_online', { module: 'un1t-online-sync' })
  })

  it('no eligible location still stamps, with zero counts', async () => {
    h.discovery = found([], [{ id: 'x', state: 'unconfigured' }])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(runUn1tSync).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
      locations_processed: 0, failed_locations: 0, failed_by_reason: {}, skipped: 1, skipped_in_progress: 0, deferred_budget: 0,
    })
  })

  it('runs each eligible location and stamps the heartbeat with counts', async () => {
    h.discovery = found([loc('hatch'), loc('other')])
    runUn1tSync.mockResolvedValue({ ok: true, counts: { clients: 3 }, runId: 'r' })
    const res = await GET(req())
    const body = await res.json()
    expect(runUn1tSync.mock.calls.map((c) => c[1])).toEqual(['hatch', 'other'])
    expect(stampTenantHeartbeat.mock.calls).toEqual([
      ['un1t-online-sync', 'hatch'],
      ['un1t-online-sync', 'other'],
    ])
    expect(stampHeartbeat.mock.calls.filter((c) => c[0] === 'un1t-online-sync')).toHaveLength(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
      locations_processed: 2, failed_locations: 0, failed_by_reason: {}, skipped: 0, skipped_in_progress: 0, deferred_budget: 0,
    })
    expect(body).toMatchObject({ success: true, locations_processed: 2, failed_locations: 0 })
  })

  it('an auth failure at one location still stamps, with failed_locations 1', async () => {
    h.discovery = found([loc('hatch'), loc('other')])
    runUn1tSync.mockImplementation(async (_db, id) => (
      id === 'hatch' ? { ok: false, reason: 'auth', counts: {}, runId: 'r1' } : { ok: true, counts: {}, runId: 'r2' }
    ))
    const res = await GET(req())
    expect(res.status).toBe(200)
    // The failed location does not stamp its tenant row; the healthy one does.
    expect(stampTenantHeartbeat.mock.calls).toEqual([['un1t-online-sync', 'other']])
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
      locations_processed: 1, failed_locations: 1, failed_by_reason: { auth: 1 }, skipped: 0, skipped_in_progress: 0, deferred_budget: 0,
    })
  })

  it('counts every failure reason, including studio_mismatch and not_connected', async () => {
    h.discovery = found([loc('a'), loc('b'), loc('c'), loc('d')])
    const reasons = { a: 'studio_mismatch', b: 'auth', c: 'auth', d: 'not_connected' }
    runUn1tSync.mockImplementation(async (_db, id) => ({ ok: false, reason: reasons[id], counts: {}, runId: null }))
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
      locations_processed: 0,
      failed_locations: 4,
      failed_by_reason: { studio_mismatch: 1, auth: 2, not_connected: 1 },
      skipped: 0, skipped_in_progress: 0, deferred_budget: 0,
    })
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
  })

  it('a thrown exception at one location is counted and the next location still runs', async () => {
    h.discovery = found([loc('boom'), loc('fine')])
    runUn1tSync.mockImplementation(async (_db, id) => {
      if (id === 'boom') throw new Error('secret-token-abc leaked in message')
      return { ok: true, counts: {}, runId: 'r' }
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(runUn1tSync.mock.calls.map((c) => c[1])).toEqual(['boom', 'fine'])
    expect(stampTenantHeartbeat.mock.calls).toEqual([['un1t-online-sync', 'fine']])
    const outcome = stampHeartbeat.mock.calls[0][1]
    expect(outcome).toEqual({
      locations_processed: 1, failed_locations: 1, failed_by_reason: { exception: 1 }, skipped: 0, skipped_in_progress: 0, deferred_budget: 0,
    })
    // No exception text reaches the heartbeat or the response.
    expect(JSON.stringify(outcome)).not.toContain('secret-token')
    expect(JSON.stringify(await res.json())).not.toContain('secret-token')
  })

  it('counts skipped (unconfigured / unknown) locations without running them', async () => {
    h.discovery = found([loc('hatch')], [{ id: 'u', state: 'unknown' }, { id: 'v', state: 'unconfigured' }])
    runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
    await GET(req())
    expect(runUn1tSync).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
      locations_processed: 1, failed_locations: 0, failed_by_reason: {}, skipped: 2, skipped_in_progress: 0, deferred_budget: 0,
    })
  })

  it('a location whose sync is already running is skipped_in_progress, not failed', async () => {
    h.discovery = found([loc('hatch'), loc('other')])
    runUn1tSync.mockImplementation(async (_db, id) =>
      id === 'hatch' ? { ok: false, reason: 'in_progress', counts: {}, runId: null } : { ok: true, counts: {}, runId: 'r' })
    await GET(req())
    expect(stampTenantHeartbeat.mock.calls).toEqual([['un1t-online-sync', 'other']])
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
      locations_processed: 1, failed_locations: 0, failed_by_reason: {}, skipped: 0, skipped_in_progress: 1, deferred_budget: 0,
    })
  })

  it('stops starting locations once the time budget is spent and counts the rest as deferred', async () => {
    h.discovery = found([loc('a'), loc('b'), loc('c')])
    let t = 1_000_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t)
    try {
      runUn1tSync.mockImplementation(async (_db, id) => {
        if (id === 'a') t += BUDGET_MS + 1 // the first location runs past the budget
        return { ok: true, counts: {}, runId: 'r' }
      })
      const res = await GET(req())
      expect(res.status).toBe(200)
      expect(runUn1tSync.mock.calls.map((c) => c[1])).toEqual(['a'])
      expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', {
        locations_processed: 1, failed_locations: 0, failed_by_reason: {}, skipped: 0, skipped_in_progress: 0, deferred_budget: 2,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('ok location calls maybeReclassifyAfterSync after its tenant heartbeat (and after the sync loop)', async () => {
    h.discovery = found([loc('hatch'), loc('other')])
    runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
    const order = []
    stampTenantHeartbeat.mockImplementation(async (_n, id) => { order.push(`hb:${id}`) })
    maybeReclassifyAfterSync.mockImplementation(async (_db, id) => { order.push(`re:${id}`); return { ran: false, reason: 'recent_run' } })
    await GET(req())
    // Every heartbeat first, the reclassify passes after the loop.
    expect(order).toEqual(['hb:hatch', 'hb:other', 're:hatch', 're:other'])
    expect(maybeReclassifyAfterSync.mock.calls.map((c) => c[1])).toEqual(['hatch', 'other'])
    expect(maybeReclassifyAfterSync.mock.calls[0][0]).toEqual({ marker: 'db' })
  })

  it('a not-ok or in_progress location does not call it', async () => {
    h.discovery = found([loc('bad'), loc('busy'), loc('boom')])
    runUn1tSync.mockImplementation(async (_db, id) => {
      if (id === 'boom') throw new Error('x')
      return id === 'bad' ? { ok: false, reason: 'auth', counts: {}, runId: 'r' } : { ok: false, reason: 'in_progress', counts: {}, runId: null }
    })
    await GET(req())
    expect(maybeReclassifyAfterSync).not.toHaveBeenCalled()
  })

  it('maybeReclassifyAfterSync rejecting leaves the outcome, tenant heartbeat and stampHeartbeat unchanged', async () => {
    h.discovery = found([loc('hatch'), loc('other')])
    runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
    maybeReclassifyAfterSync.mockRejectedValue(new Error('secret-token-abc'))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    // The next location still ran, and both tenant rows stamped.
    expect(runUn1tSync.mock.calls.map((c) => c[1])).toEqual(['hatch', 'other'])
    expect(stampTenantHeartbeat.mock.calls).toEqual([['un1t-online-sync', 'hatch'], ['un1t-online-sync', 'other']])
    const expected = { locations_processed: 2, failed_locations: 0, failed_by_reason: {}, skipped: 0, skipped_in_progress: 0, deferred_budget: 0 }
    expect(stampHeartbeat.mock.calls.filter((c) => c[0] === 'un1t-online-sync')).toHaveLength(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', expected)
    expect(body).toEqual({ success: true, ...expected })
    // Logged by name only, never the message.
    expect(logError).toHaveBeenCalledWith('un1t-online-sync', 'reclassify after sync threw', { locationId: 'hatch', errName: 'Error' })
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret-token')
  })

  it('runs the reclassify passes only after the final stampHeartbeat', async () => {
    h.discovery = found([loc('hatch')])
    runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
    const order = []
    stampHeartbeat.mockImplementation(async (name) => { if (name === 'un1t-online-sync') order.push('stamp') })
    maybeReclassifyAfterSync.mockImplementation(async () => { order.push('re'); return { ran: false, reason: 'recent_run' } })
    await GET(req())
    expect(order).toEqual(['stamp', 're'])
  })

  it('a never-resolving maybeReclassifyAfterSync is cut at 60 s: heartbeat stamped, outcome unchanged, response returns', async () => {
    h.discovery = found([loc('hatch')])
    runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
    maybeReclassifyAfterSync.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const pending = GET(req())
      await vi.advanceTimersByTimeAsync(60_000)
      const res = await pending
      const expected = { locations_processed: 1, failed_locations: 0, failed_by_reason: {}, skipped: 0, skipped_in_progress: 0, deferred_budget: 0 }
      expect(stampHeartbeat.mock.calls.filter((c) => c[0] === 'un1t-online-sync')).toHaveLength(1)
      expect(stampHeartbeat).toHaveBeenCalledWith('un1t-online-sync', expected)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, ...expected })
      expect(logWarn).toHaveBeenCalledWith('un1t-online-sync', 'reclassify after sync timed out', { locationId: 'hatch' })
    } finally {
      vi.useRealTimers()
    }
  })

  describe('welcome sweep arm (UN1TWELCOME.5)', () => {
    const syncStamps = () => stampHeartbeat.mock.calls.filter((c) => c[0] === 'un1t-online-sync')
    const welcomeStamps = () => stampHeartbeat.mock.calls.filter((c) => c[0] === 'un1t-welcome-sweep')

    it('stamps its own row with summed counts when every sweep is ok', async () => {
      h.discovery = found([loc('hatch'), loc('other')])
      runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
      sweepUn1tWelcomes.mockResolvedValue({ ok: true, checked: 2, enrolled: 1, crm_made: 0, waiting: 1, no_contact: 0, no_email: 0, failed: 0 })
      await GET(req())
      expect(sweepUn1tWelcomes.mock.calls.map((c) => c[1])).toEqual(['hatch', 'other'])
      expect(syncStamps()).toHaveLength(1)
      expect(welcomeStamps()).toEqual([['un1t-welcome-sweep', expect.objectContaining({ locations: 2, checked: 4, enrolled: 2, waiting: 2 })]])
    })

    it('zero eligible locations still stamps the welcome row', async () => {
      await GET(req())
      expect(welcomeStamps()).toHaveLength(1)
    })

    it('a sweep returning ok:false skips the welcome stamp but not the sync stamp', async () => {
      h.discovery = found([loc('hatch')])
      runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
      sweepUn1tWelcomes.mockResolvedValue({ ok: false, checked: 0 })
      const res = await GET(req())
      expect(res.status).toBe(200)
      expect(syncStamps()).toHaveLength(1)
      expect(welcomeStamps()).toHaveLength(0)
    })

    it('a sweep that throws changes neither the response nor the sync stamp, and skips the welcome stamp', async () => {
      h.discovery = found([loc('hatch')])
      runUn1tSync.mockResolvedValue({ ok: true, counts: {}, runId: 'r' })
      sweepUn1tWelcomes.mockRejectedValue(new Error('boom'))
      const res = await GET(req())
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ success: true, locations_processed: 1 })
      expect(syncStamps()).toHaveLength(1)
      expect(welcomeStamps()).toHaveLength(0)
      expect(logError).toHaveBeenCalled()
    })

    it('does not sweep a location whose sync failed', async () => {
      h.discovery = found([loc('hatch')])
      runUn1tSync.mockResolvedValue({ ok: false, reason: 'auth', counts: {}, runId: 'r' })
      await GET(req())
      expect(sweepUn1tWelcomes).not.toHaveBeenCalled()
    })
  })
})
