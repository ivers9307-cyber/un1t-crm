import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('web sdk binding', () => {
  let fetchSpy
  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { profile: { id: 'web-1' } } }) }))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('me.get() hits same-origin /api/mobile/me with credentials and no Authorization header', async () => {
    const { sdk } = await import('./sdk.js')
    const out = await sdk.me.get()
    expect(out.data.profile.id).toBe('web-1')
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/mobile/me')
    expect(opts.credentials).toBe('include')
    expect(opts.headers.Authorization).toBeUndefined()
  })
})
