import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiBaseUrl: 'https://crm.test' } } },
}))
vi.mock('./api', () => ({
  authHeaders: vi.fn(async ({ json, locationId }) => ({
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: 'Bearer jwt-123',
    ...(locationId ? { 'x-active-location': locationId } : {}),
  })),
}))

describe('mobile sdk binding', () => {
  let fetchSpy
  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { profile: { id: 'mob-1' } } }) }))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('me.get() hits the configured base URL with the Bearer header from authHeaders', async () => {
    const { sdk } = await import('./sdk.js')
    const out = await sdk.me.get()
    expect(out.data.profile.id).toBe('mob-1')
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://crm.test/api/mobile/me')
    expect(opts.headers.Authorization).toBe('Bearer jwt-123')
  })
})
