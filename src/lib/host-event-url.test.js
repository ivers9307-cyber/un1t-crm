// HOSTPORTAL.4 — the one place a host's public event URL is built.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ resolveCustomerBaseUrl: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.resolveCustomerBaseUrl }))

const { hostEventPublicUrl } = await import('./host-event-url')

function fakeDb(result) {
  const calls = []
  return {
    calls,
    from: (table) => {
      const b = { table, ops: [] }
      b.select = (cols) => { b.ops.push(['select', cols]); return b }
      b.eq = (c, v) => { b.ops.push(['eq', c, v]); return b }
      b.maybeSingle = async () => { calls.push(b); return result }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveCustomerBaseUrl.mockResolvedValue('https://studio.test/some/path?x=1')
})

describe('hostEventPublicUrl', () => {
  it("builds origin + /event/<slug> on the host's anchor studio tenant host, dropping any path or query", async () => {
    const db = fakeDb({ data: { anchor_location_id: 'loc1' }, error: null })
    expect(await hostEventPublicUrl(db, 'h1', 'summer-run')).toBe('https://studio.test/event/summer-run')
    expect(mocks.resolveCustomerBaseUrl).toHaveBeenCalledWith(db, 'loc1')
    expect(db.calls[0].table).toBe('event_hosts')
    expect(db.calls[0].ops).toEqual(expect.arrayContaining([['select', 'anchor_location_id'], ['eq', 'id', 'h1']]))
  })

  it('passes null when the host has no anchor studio', async () => {
    await hostEventPublicUrl(fakeDb({ data: null, error: null }), 'h1', 'summer-run')
    expect(mocks.resolveCustomerBaseUrl).toHaveBeenCalledWith(expect.anything(), null)
  })

  it('throws on an empty slug without resolving anything', async () => {
    await expect(hostEventPublicUrl(fakeDb({ data: null, error: null }), 'h1', '')).rejects.toThrow(/slug/)
    await expect(hostEventPublicUrl(fakeDb({ data: null, error: null }), 'h1', null)).rejects.toThrow(/slug/)
    expect(mocks.resolveCustomerBaseUrl).not.toHaveBeenCalled()
  })

  it('throws when the host read fails or the base cannot be resolved', async () => {
    await expect(hostEventPublicUrl(fakeDb({ data: null, error: { message: 'down' } }), 'h1', 's')).rejects.toBeTruthy()
    mocks.resolveCustomerBaseUrl.mockRejectedValueOnce(new Error('no base'))
    await expect(hostEventPublicUrl(fakeDb({ data: { anchor_location_id: 'l' }, error: null }), 'h1', 's')).rejects.toThrow('no base')
    mocks.resolveCustomerBaseUrl.mockResolvedValueOnce('not a url')
    await expect(hostEventPublicUrl(fakeDb({ data: { anchor_location_id: 'l' }, error: null }), 'h1', 's')).rejects.toBeTruthy()
  })
})
