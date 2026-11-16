// PRESENTSAFE.1 (October audit A18) — a failed read is a 503, never an empty
// deck (which a screen would adopt and keep) or an "invalid link".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: vi.fn(),
}))
let deckAnswer, slidesAnswer
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from() {
      const q = {}
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = async () => deckAnswer
      q.order = async () => slidesAnswer
      return q
    },
  }),
}))

const { GET } = await import('./route.js')
const get = () => GET(new Request('http://x'), { params: Promise.resolve({ token: 'tok' }) })

beforeEach(() => {
  deckAnswer = { data: { id: 'd1', title: 'T', current_index: 0, version: 3 }, error: null }
  slidesAnswer = { data: [{ image_path: 'a.jpg' }], error: null }
})

describe('GET /api/public/presentations/[token]/state', () => {
  it('answers the deck', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).slides).toHaveLength(1)
  })
  it('a failed slide read is a 503, not an empty deck', async () => {
    slidesAnswer = { data: null, error: { message: 'down' } }
    expect((await get()).status).toBe(503)
  })
  it('a failed deck read is a 503, not "invalid link"', async () => {
    deckAnswer = { data: null, error: { message: 'down' } }
    expect((await get()).status).toBe(503)
  })
  it('an unknown token is still a 404', async () => {
    deckAnswer = { data: null, error: null }
    expect((await get()).status).toBe(404)
  })
})
