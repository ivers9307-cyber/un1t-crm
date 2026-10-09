// EVENT-MOVE.6 — GET /api/public/entry/[token]/move-options: the dates and
// times the token holder may move to. Eligible options only; no capacity, no
// places left, no count of any kind, in any key or any sentence.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: vi.fn() })) }))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: new Date(), retryAfterSec: 1 })),
}))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  readRegistrationForMove: vi.fn(),
  countEntryCheckins: vi.fn(),
  listMoveTargets: vi.fn(),
}))
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-10-09' }))

const { checkRateLimit } = await import('@/lib/rate-limit')
const { readRegistrationForMove, countEntryCheckins, listMoveTargets } = await import('@/lib/registration-move')
const { signEntryManageToken } = await import('@/lib/entry-manage-tokens')
const { GET } = await import('./route.js')

const SECRET = 'svc-key'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const REG = { id: R1, status: 'confirmed', race_event_id: 'e1', race: { id: 'e1', race_date: '2026-10-18' }, race_started_at: null, race_finished_at: null }
const TARGETS = {
  ok: true,
  entry: { id: R1, headcount: 2, label: 'The Crushers', member_count: 1, non_member_count: 1 },
  source: { event_id: 'e1' },
  targets: [{
    id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_name: 'Hatch St', capacity_mode: 'teams', price_gap_cents: 1000, currency: 'EUR',
    crosses_studio: false, location_id: 'L1',
    waves: [
      { id: 'w1', start_time: '09:00:00', label: null, capacity: 10, spots_left: 3 },
      { id: 'w2', start_time: '11:00:00', label: null, capacity: 10, spots_left: 0 },
    ],
  }],
}
const props = (token = signEntryManageToken({ registrationId: R1 }, SECRET)) => ({ params: Promise.resolve({ token }) })
const get = () => new Request('http://localhost/api/public/entry/x/move-options', { headers: { 'x-forwarded-for': '1.2.3.4' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
  readRegistrationForMove.mockResolvedValue({ registration: REG, error: null })
  countEntryCheckins.mockResolvedValue({ count: 0, error: null })
  listMoveTargets.mockResolvedValue(TARGETS)
})
afterEach(() => { vi.unstubAllEnvs() })

describe('GET /api/public/entry/[token]/move-options', () => {
  it('a bad token is a 404 with no read', async () => {
    expect((await GET(get(), props('x.y'))).status).toBe(404)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('lists every studio\'s eligible options for the entry, with no number about room anywhere', async () => {
    const res = await GET(get(), props())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(listMoveTargets).toHaveBeenCalledWith(expect.anything(), { registrationId: R1, allowedLocationIds: null })
    expect(body.data.can_move).toBe(true)
    expect(body.data.options).toHaveLength(1)
    expect(body.data.options[0].times.map((t) => t.wave_id)).toEqual(['w1'])
    expect(body.data.options[0].price_note).toBe('€10.00 more, paid before the move')
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/spot|capacity|count|left/i)
  })
  it('is rate limited on the shared entry bucket', async () => {
    await GET(get(), props())
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), 'entry:1.2.3.4', { max: 60, windowMs: 5 * 60_000 })
  })
  it.each([
    ['unpaid', { status: 'pending_payment' }, 0],
    ['checked in', {}, 1],
    ['past', { race: { id: 'e1', race_date: '2026-10-01' } }, 0],
  ])('%s: can_move false with a reason, and no options looked up', async (_w, over, checkins) => {
    readRegistrationForMove.mockResolvedValue({ registration: { ...REG, ...over }, error: null })
    countEntryCheckins.mockResolvedValue({ count: checkins, error: null })
    const body = await (await GET(get(), props())).json()
    expect(body.data).toEqual({ can_move: false, move_blocked_reason: expect.any(String), options: [] })
    expect(listMoveTargets).not.toHaveBeenCalled()
  })
  it('a failed read is a 500, never an empty list', async () => {
    listMoveTargets.mockResolvedValue({ ok: false, error: 'load_failed' })
    expect((await GET(get(), props())).status).toBe(500)
    countEntryCheckins.mockResolvedValue({ count: null, error: { message: 'down' } })
    expect((await GET(get(), props())).status).toBe(500)
  })
})
