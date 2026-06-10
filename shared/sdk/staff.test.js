import { describe, it, expect, vi } from 'vitest'
import { createSdk } from './index.js'

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

describe('sdk.staff', () => {
  it('list() calls GET /api/staff', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: [{ id: 'p1' }] }))
    const sdk = createSdk({ baseUrl: 'https://api.test', getAuthHeaders: () => ({}), fetchImpl })
    const out = await sdk.staff.list()
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/api/staff', expect.objectContaining({ method: 'GET' }))
    expect(out.data[0].id).toBe('p1')
  })
  it('get(id) calls GET /api/staff/:id', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { id: 'p1' } }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    await sdk.staff.get('p1')
    expect(fetchImpl).toHaveBeenCalledWith('/api/staff/p1', expect.objectContaining({ method: 'GET' }))
  })

  it('update(id, patch) PUTs /api/staff/:id with the patch body', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { id: 'p1', full_name: 'Ada L' } }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    await sdk.staff.update('p1', { full_name: 'Ada L' })
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/staff/p1')
    expect(opts.method).toBe('PUT')
    expect(opts.body).toBe(JSON.stringify({ full_name: 'Ada L' }))
  })

  it('sendPasswordReset(id) POSTs the reset route', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    await sdk.staff.sendPasswordReset('p1')
    expect(fetchImpl).toHaveBeenCalledWith('/api/staff/p1/send-password-reset', expect.objectContaining({ method: 'POST' }))
  })

  it('create(payload) POSTs /api/staff with the payload body', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { id: 'new1' } }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    const payload = {
      email: 'ada@test.io',
      full_name: 'Ada Lovelace',
      employment_type: 'fte',
      assignments: [{ location_id: 'loc-1', role: 'staff', is_default: true }],
    }
    const out = await sdk.staff.create(payload)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/staff')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBe(JSON.stringify(payload))
    expect(out.data.id).toBe('new1')
  })
})
