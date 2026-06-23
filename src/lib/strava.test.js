import { describe, it, expect, vi, afterEach } from 'vitest'
import { getActivity, listActivities } from './strava.js'

afterEach(() => vi.restoreAllMocks())

describe('strava client reads', () => {
  it('getActivity fetches the detailed activity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 123, name: 'Run' }) })
    vi.stubGlobal('fetch', fetchMock)
    const a = await getActivity({ accessToken: 'tok', activityId: '123' })
    expect(a.id).toBe(123)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.strava.com/api/v3/activities/123')
    expect(opts.headers.authorization).toBe('Bearer tok')
  })

  it('listActivities passes after + per_page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ([{ id: 1 }, { id: 2 }]) })
    vi.stubGlobal('fetch', fetchMock)
    const rows = await listActivities({ accessToken: 'tok', afterEpoch: 1700000000, perPage: 50 })
    expect(rows).toHaveLength(2)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('after=1700000000')
    expect(url).toContain('per_page=50')
  })

  it('throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'nope' }))
    await expect(getActivity({ accessToken: 't', activityId: '1' })).rejects.toThrow(/Strava activity fetch failed: 401/)
  })
})
