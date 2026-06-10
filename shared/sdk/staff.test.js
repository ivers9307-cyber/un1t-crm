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
})
