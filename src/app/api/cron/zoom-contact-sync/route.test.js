import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/zoom/reconcile', () => ({ runZoomContactSync: vi.fn() }))

import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createServerClient } from '@/lib/supabase'
import { GET } from './route'

const req = (url = 'https://x.test/api/cron/zoom-contact-sync', secret = 'shh') =>
  new Request(url, { headers: { authorization: `Bearer ${secret}` } })

beforeEach(() => {
  process.env.CRON_SECRET = 'shh'
  // mockClear on both mocks — without it, mock.calls accumulates across
  // tests in this file (vitest does not auto-clear mocks between tests) and
  // `mock.calls[0]` below stops meaning "the call this test just made".
  vi.mocked(runZoomContactSync).mockClear()
  vi.mocked(runZoomContactSync).mockResolvedValue({ ok: true, counts: { creates: 1, updates: 0, deletes: 0 }, enqueued: 1 })
  vi.mocked(stampHeartbeat).mockClear()
  vi.mocked(createServerClient).mockClear()
})

describe('GET /api/cron/zoom-contact-sync', () => {
  it('401s without the cron secret', async () => {
    const res = await GET(new Request('https://x.test/', { headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
    expect(runZoomContactSync).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('runs the sync and stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, enqueued: 1 })
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['zoom-contact-sync', {
      counts: { creates: 1, updates: 0, deletes: 0 }, enqueued: 1, guardTripped: false,
    }]])
  })

  it('ROUTEWRAP.C9 — a runner that throws answers a fixed 500 and stamps nothing', async () => {
    vi.mocked(runZoomContactSync).mockRejectedValue(new Error('zoom token 401: secret detail'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Cron run failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('passes ?limit through as a number', async () => {
    await GET(req('https://x.test/api/cron/zoom-contact-sync?limit=200'))
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].limit).toBe(200)
  })

  it('passes ?dry=1 through', async () => {
    await GET(req('https://x.test/api/cron/zoom-contact-sync?dry=1'))
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].dry).toBe(true)
  })

  it('passes ?force=1 through', async () => {
    await GET(req('https://x.test/api/cron/zoom-contact-sync?force=1'))
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].force).toBe(true)
  })

  it('does not force by default — the scheduled run must never bypass the guard', async () => {
    await GET(req())
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].force).toBe(false)
  })

  it('reports success:false when the guard trips', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true, counts: { creates: 0, updates: 0, deletes: 0 }, enqueued: 0,
    })
    const res = await GET(req())
    // Answered 200 as before: success:false is the signal, the status is not.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: false, guardTripped: true })
    // The trip must be durable, not only present in an HTTP response nobody
    // reads at 04:30.
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['zoom-contact-sync', {
      counts: { creates: 0, updates: 0, deletes: 0 }, enqueued: 0, guardTripped: true,
    }]])
  })

  it('ZOOMSYNC.5 — a run that could not read its inputs answers a fixed line and does not stamp', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({ ok: false, error: 'relation secret_z does not exist' })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Zoom contact sync could not read its inputs' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('ZOOMSYNC.5 — the scheduled response carries counts, never phone numbers or provider errors', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true, enqueued: 1, counts: { creates: 2, updates: 0, deletes: 40 },
      failures: ['create +353871234567: 429 rate limited'],
      guard: { tripped: true, threshold: 25, attempted: 40, deletes: [{ e164: '+353870000001' }, { e164: '+353870000002' }] },
    })
    const res = await GET(req())
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/\+3538/)
    expect(text).not.toContain('rate limited')
    expect(JSON.parse(text)).toMatchObject({ success: false, failureCount: 1, guard: { tripped: true, threshold: 25, attempted: 40, deletesCount: 2 } })
    expect(stampHeartbeat).toHaveBeenCalledWith('zoom-contact-sync', expect.objectContaining({ guardTripped: true, failureCount: 1 }))
  })

  it('ZOOMSYNC.5 — a dry run still answers in full for the operator', async () => {
    const full = { ok: false, dry: true, guardTripped: true, guard: { tripped: true, deletes: [{ e164: '+353870000001' }] }, counts: {} }
    vi.mocked(runZoomContactSync).mockResolvedValue(full)
    const body = await (await GET(req('https://x.test/api/cron/zoom-contact-sync?dry=1'))).json()
    expect(body.guard.deletes).toEqual([{ e164: '+353870000001' }])
    // A dry run stamps its row as it always has (its outcome carries counts only).
    expect(stampHeartbeat).toHaveBeenCalledWith('zoom-contact-sync', expect.objectContaining({ guardTripped: true }))
  })

  it('reports success for a clean unconfigured skip', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({ skipped: 'unconfigured' })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, skipped: 'unconfigured' })
  })

  it('identifies itself as the cron trigger', async () => {
    await GET(req())
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].trigger).toBe('cron')
  })
})
