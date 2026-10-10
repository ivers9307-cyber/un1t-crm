// EVENT-WAITLIST.1 — the public join: refusals (not public, past, closed,
// has room, bad group size) add nothing; a sold-out event adds the row; the
// answer never carries a count or any capacity.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(() => new Response('{}', { status: 429 })),
}))
let RACE
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.maybeSingle = async () => ({ data: RACE, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/dublin-time', () => ({ dublinTodayStr: () => '2026-10-09' }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-waitlist', async (importOriginal) => ({
  ...(await importOriginal()),
  joinWaitlist: vi.fn(async () => ({ row: { id: 'wl1' }, created: true })),
  loadEventHasRoom: vi.fn(async () => ({ hasRoom: false, error: null })),
}))

const { joinWaitlist, loadEventHasRoom } = await import('@/lib/event-waitlist')
const { checkRateLimit } = await import('@/lib/rate-limit')
const { POST } = await import('./route.js')

const BASE = { id: 'e1', name: 'Hatch Relay', slug: 'hatch-oct18-1100', race_date: '2026-10-18', active: true, status: 'published',
  location_id: 'L1', allowed_team_sizes: [1, 2], registration_opens_at: null, registration_closes_at: null, waves: [{ id: 'w1', capacity: 1 }] }
const BODY = { name: 'Ann Example', email: 'ann@example.test', phone: '087 000 0000', headcount: 2, consent: true }
const post = (body = BODY) => POST(
  new Request('https://crm.test/api/public/events/hatch-oct18-1100/waitlist', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'hatch-oct18-1100' }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  RACE = { ...BASE }
  loadEventHasRoom.mockResolvedValue({ hasRoom: false, error: null })
  joinWaitlist.mockResolvedValue({ row: { id: 'wl1' }, created: true })
})

describe('POST /api/public/events/[slug]/waitlist', () => {
  it('rate-limits per slug + IP, 5 per 15 minutes', async () => {
    await post()
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), 'waitlist:hatch-oct18-1100:1.2.3.4', { max: 5, windowMs: 15 * 60_000 })
  })

  it('joins a sold-out event and answers only the row id', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 'wl1' } })
    expect(joinWaitlist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: 'Ann Example', email: 'ann@example.test', phone: '087 000 0000', headcount: 2, consent: true, ip: '1.2.3.4', source: 'public',
    }))
  })

  it('has room: 409 has_room, "book directly", nothing added', async () => {
    loadEventHasRoom.mockResolvedValue({ hasRoom: true, error: null })
    const res = await post()
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j).toMatchObject({ code: 'has_room', error: 'Spots are available, book directly.' })
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', null, 404, 'not_found'],
    ['past', { race_date: '2026-10-08' }, 409, 'past'],
    ['not yet open', { registration_opens_at: '2099-01-01T00:00:00Z' }, 409, 'closed'],
    ['closed', { registration_closes_at: '2026-01-01T00:00:00Z' }, 409, 'closed'],
  ])('refuses an event that is %s', async (_l, patch, status, code) => {
    RACE = patch === null ? null : { ...BASE, ...patch }
    const res = await post()
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('refuses a group size the event does not offer', async () => {
    const res = await post({ ...BODY, headcount: 3 })
    expect(res.status).toBe(400)
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('refuses a junk phone and a bad email at the schema', async () => {
    expect((await post({ ...BODY, phone: '12' })).status).toBe(400)
    expect((await post({ ...BODY, email: 'nope' })).status).toBe(400)
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('a phone is optional', async () => {
    const { phone: _p, ...noPhone } = BODY
    expect((await post(noPhone)).status).toBe(200)
  })

  it('a failed registrations read or a failed write is a 500, never a success', async () => {
    loadEventHasRoom.mockResolvedValueOnce({ hasRoom: null, error: { message: 'down' } })
    expect((await post()).status).toBe(500)
    joinWaitlist.mockResolvedValueOnce({ error: 'write_failed' })
    expect((await post()).status).toBe(500)
  })

  it('never answers with a count or a capacity', async () => {
    const text = JSON.stringify(await (await post()).json())
    expect(text).not.toMatch(/count|capacity|waiting|position|spots_left/i)
  })
})
