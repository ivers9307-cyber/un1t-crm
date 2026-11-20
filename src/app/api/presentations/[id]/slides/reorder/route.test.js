// PRESENTSAFE.1 (October audit A18) — a reorder names the whole deck, every
// write is judged, and a partial failure never reports "saved".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn(async () => ({ id: 'u1' })), assertLocationAccess: () => null }))
vi.mock('@/lib/permissions', async (importOriginal) => ({ ...(await importOriginal()), hasPermissionAtAnyLocation: () => true, hasPermissionForLocation: () => true }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
const A = 'a0000000-0000-4000-8000-00000000000a'
const B = 'a0000000-0000-4000-8000-00000000000b'
const DECK = 'd0000000-0000-4000-8000-000000000001'
let failUpdate, bumpErr, updates, rpc
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    rpc: (...a) => rpc(...a),
    from(table) {
      const q = { _update: null }
      q.select = () => q
      q.eq = () => q
      q.update = (u) => { q._update = u; updates.push(u); return q }
      q.maybeSingle = async () => ({ data: { id: DECK, location_id: 'loc1', version: 1 }, error: null })
      q.then = (res) => Promise.resolve(
        table === 'presentation_slides' && !q._update
          ? { data: [{ id: A }, { id: B }], error: null }
          : { data: null, error: failUpdate && q._update?.position === 1 ? { message: 'down' } : null },
      ).then(res)
      return q
    },
  }),
}))

const { PUT } = await import('./route.js')
const put = (order) => PUT(
  new Request('http://x', { method: 'PUT', body: JSON.stringify({ order }), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: DECK }) },
)

beforeEach(() => {
  failUpdate = false; bumpErr = null; updates = []
  rpc = vi.fn(async () => ({ data: null, error: bumpErr }))
})

describe('PUT /api/presentations/[id]/slides/reorder', () => {
  it('saves a full order and bumps the version', async () => {
    const res = await put([B, A])
    expect(res.status).toBe(200)
    expect(updates).toEqual([{ position: 0 }, { position: 1 }])
    expect(rpc).toHaveBeenCalledWith('bump_presentation_version', { p_presentation_id: DECK })
  })

  it('refuses an order that leaves out or repeats a slide, writing nothing', async () => {
    expect((await put([A])).status).toBe(400)
    expect((await put([A, A])).status).toBe(400)
    expect(updates).toEqual([])
  })

  it('a failed position write is not reported as saved, and screens still re-read', async () => {
    failUpdate = true
    const res = await put([A, B])
    expect(res.status).toBe(500)
    expect(rpc).toHaveBeenCalled()
  })

  it('a failed version bump is not reported as saved', async () => {
    bumpErr = { message: 'down' }
    expect((await put([A, B])).status).toBe(500)
  })
})
