// APPROVALSQ.5 — the one place the web sends { undo_clear: true }.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { undoClearRequest } from './undo-clear-request.js'

afterEach(() => { vi.unstubAllGlobals() })
const stub = (status, body) => vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status < 300, json: async () => body })))

describe('undoClearRequest', () => {
  it('sends exactly { undo_clear: true } as a PATCH to the request', async () => {
    stub(200, { success: true, request: { id: 'r1', status: 'pending' }, undone: true })
    const res = await undoClearRequest('r1')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/agent/membership-requests/r1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ undo_clear: true })
    expect(res).toEqual({ ok: true, request: { id: 'r1', status: 'pending' } })
  })

  it("returns the route's own words and status on a refusal", async () => {
    stub(409, { success: false, error: 'This clear can no longer be undone.' })
    expect(await undoClearRequest('r1')).toEqual({ ok: false, status: 409, error: 'This clear can no longer be undone.' })
  })

  it('a refusal with no error text still says something', async () => {
    stub(500, { success: false })
    const res = await undoClearRequest('r1')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('a network failure is a failure, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const res = await undoClearRequest('r1')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(0)
  })
})
