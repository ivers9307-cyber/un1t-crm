import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/zoom/reconcile', () => ({ runZoomContactSync: vi.fn() }))

import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
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
})

describe('GET /api/cron/zoom-contact-sync', () => {
  it('401s without the cron secret', async () => {
    const res = await GET(new Request('https://x.test/', { headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  it('runs the sync and stamps the heartbeat', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, enqueued: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('zoom-contact-sync')
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
    expect(await res.json()).toMatchObject({ success: false, guardTripped: true })
  })

  it('reports success for a clean unconfigured skip', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({ skipped: 'unconfigured' })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, skipped: 'unconfigured' })
  })
})
