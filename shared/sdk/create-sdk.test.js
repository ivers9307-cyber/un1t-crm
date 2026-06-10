import { describe, it, expect, vi } from 'vitest'
import { createTransport } from './create-sdk.js'
import { createSdk } from './index.js'

function okResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('createTransport', () => {
  it('builds the URL from baseUrl + path and returns the parsed envelope', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { id: 1 } }))
    const request = createTransport({ baseUrl: 'https://api.test', getAuthHeaders: () => ({}), fetchImpl })
    const out = await request('/api/mobile/me')
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/api/mobile/me', expect.objectContaining({ method: 'GET' }))
    expect(out).toEqual({ success: true, data: { id: 1 } })
  })

  it('awaits getAuthHeaders and forwards them, asking for json only when there is a body', async () => {
    const getAuthHeaders = vi.fn(async ({ json }) => ({ Authorization: 'Bearer t', ...(json ? { 'Content-Type': 'application/json' } : {}) }))
    const fetchImpl = vi.fn(async () => okResponse({ success: true }))
    const request = createTransport({ baseUrl: '', getAuthHeaders, fetchImpl })
    await request('/api/x', { method: 'POST', body: { a: 1 } })
    expect(getAuthHeaders).toHaveBeenCalledWith({ json: true, locationId: undefined })
    const opts = fetchImpl.mock.calls[0][1]
    expect(opts.headers.Authorization).toBe('Bearer t')
    expect(opts.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('returns a success:false envelope on network error', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const request = createTransport({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    const out = await request('/api/x')
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/offline/)
  })

  it('returns a success:false envelope on non-JSON response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }))
    const request = createTransport({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    const out = await request('/api/x')
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/Non-JSON/)
  })

  it('surfaces a non-2xx without our envelope as success:false', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ message: 'nope' }, 500))
    const request = createTransport({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    const out = await request('/api/x')
    expect(out).toEqual({ success: false, error: 'HTTP 500' })
  })

  it('throws if no fetch implementation is available', () => {
    expect(() => createTransport({ getAuthHeaders: () => ({}), fetchImpl: null })).toThrow(/fetch/)
  })
})

describe('createSdk + me domain', () => {
  it('me.get() calls GET /api/mobile/me through the transport', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { profile: { id: 'u1' } } }))
    const sdk = createSdk({ baseUrl: 'https://api.test', getAuthHeaders: () => ({}), fetchImpl })
    const out = await sdk.me.get()
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/api/mobile/me', expect.objectContaining({ method: 'GET' }))
    expect(out.data.profile.id).toBe('u1')
  })
})
