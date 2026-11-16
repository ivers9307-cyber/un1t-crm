// POLICYATOMIC.1 (October audit A23) — the end of a reading is recorded by one
// database call that only raises the evidence (record_policy_view_end, mig 841),
// never a read-then-write in the route.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'u1' })) }))
let rpc, existing
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    rpc: (...a) => rpc(...a),
    from: () => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: existing, error: null })
      b.update = () => { throw new Error('the route must not update policy_views itself') }
      return b
    },
  }),
}))

const { PATCH } = await import('./route.js')
const VIEW = 'c0000000-0000-4000-8000-000000000001'
const patch = (body) => PATCH(
  new Request('http://x/api/policies/aup/views', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'aup' }) },
)

beforeEach(() => {
  existing = { id: VIEW, profile_id: 'u1', total_duration_seconds: 60, policy_versions: { policies: { slug: 'aup' } } }
  rpc = vi.fn(async () => ({ data: [{ id: VIEW, ended_at: '2026-11-15T12:00:00Z', total_duration_seconds: 60 }], error: null }))
})

describe('PATCH /api/policies/[slug]/views', () => {
  it('records the end through the one monotonic function, as the caller', async () => {
    const res = await patch({ view_id: VIEW, total_duration_seconds: 30, section_dwell: { Intro: 10 } })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('record_policy_view_end', {
      p_view_id: VIEW, p_profile_id: 'u1', p_duration: 30, p_section_dwell: { Intro: 10 },
    })
    expect((await res.json()).view.total_duration_seconds).toBe(60)
  })

  it('no section times are passed as null (the stored ones are kept)', async () => {
    await patch({ view_id: VIEW, total_duration_seconds: 30 })
    expect(rpc.mock.calls[0][1].p_section_dwell).toBeNull()
  })

  it("someone else's view is refused before any write", async () => {
    existing = { ...existing, profile_id: 'someone-else' }
    expect((await patch({ view_id: VIEW, total_duration_seconds: 30 })).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a database error is a 500', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect((await patch({ view_id: VIEW, total_duration_seconds: 30 })).status).toBe(500)
  })
})
