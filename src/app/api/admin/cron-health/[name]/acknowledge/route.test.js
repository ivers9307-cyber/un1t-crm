// STALEWATCH.1 — acknowledging a known stale job is master only and runs out.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let user, updates, rows
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => user) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from() {
      const q = {}
      q.update = (p) => { updates.push(p); return q }
      q.eq = () => q
      q.select = async () => ({ data: rows, error: null })
      return q
    },
  }),
}))

const { POST, DELETE } = await import('./route.js')
const props = (name = 'instagram-feed-sync') => ({ params: Promise.resolve({ name }) })
const post = (body, name) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), props(name))

beforeEach(() => {
  user = { id: 'm1', profileRole: 'master' }
  updates = []
  rows = [{ name: 'instagram-feed-sync' }]
})

describe('acknowledge a stale job', () => {
  it('a master acknowledges for a number of hours with a note', async () => {
    const before = Date.now()
    const res = await post({ hours: 168, note: 'reconnecting Instagram' })
    expect(res.status).toBe(200)
    const until = Date.parse(updates[0].acknowledged_until)
    expect(until - before).toBeGreaterThanOrEqual(168 * 3_600_000 - 1000)
    expect(updates[0]).toMatchObject({ acknowledged_by: 'm1', acknowledged_note: 'reconnecting Instagram' })
  })

  it('only a master', async () => {
    user = { id: 'o1', profileRole: 'owner' }
    expect((await post({ hours: 1 })).status).toBe(403)
    expect(updates).toEqual([])
  })

  it('an unknown job is a 404; an out-of-range length is refused', async () => {
    rows = []
    expect((await post({ hours: 1 })).status).toBe(404)
    rows = [{ name: 'x' }]
    expect((await post({ hours: 10_000 })).status).toBe(400)
    expect((await post({ hours: 1 }, 'Bad Name!')).status).toBe(404)
  })

  it('clearing removes the acknowledgement', async () => {
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), props())
    expect(res.status).toBe(200)
    expect(updates[0]).toEqual({ acknowledged_until: null, acknowledged_by: null, acknowledged_note: null })
  })
})
