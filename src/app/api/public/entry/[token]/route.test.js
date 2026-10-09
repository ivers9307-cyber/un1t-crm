// EVENT-MOVE.6 — GET /api/public/entry/[token]: the token holder's entry, for
// the /event/entry/[token] page. Same public shape as
// /api/public/event-registrations/[id] (names only, no emails or phones) plus
// can_move and a plain reason when it cannot. A paid date change whose
// webhook has not landed yet is applied here first (provider refresh).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => globalThis.__db) }))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: new Date(), retryAfterSec: 1 })),
}))
vi.mock('@/lib/registration-move', async (importOriginal) => ({ ...(await importOriginal()), countEntryCheckins: vi.fn() }))
vi.mock('@/lib/race-payments', () => ({ refreshRacePaymentFromProvider: vi.fn(async (_db, row) => row) }))
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-10-09' }))

const { checkRateLimit } = await import('@/lib/rate-limit')
const { countEntryCheckins } = await import('@/lib/registration-move')
const { refreshRacePaymentFromProvider } = await import('@/lib/race-payments')
const { signEntryManageToken } = await import('@/lib/entry-manage-tokens')
const { GET } = await import('./route.js')

const SECRET = 'svc-key'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const ENTRY = {
  id: R1, status: 'confirmed', registered_at: '2026-10-01T10:00:00Z', team_composition: null, race_started_at: null, race_finished_at: null,
  race: { id: 'e1', name: 'Hatch Oct 18', slug: 'hatch-oct18-1100', kind: 'hyrox_sim', race_date: '2026-10-18', location_id: 'L1', locations: { name: 'UN1T Hatch', address: '1 Hatch St' } },
  wave: { id: 'w1', start_time: '11:00:00', label: null },
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [
    { id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true },
    { id: 'm2', name: 'Dan Walsh', role: 'member', is_member: false },
  ] },
}

function fakeDb({ entry = { data: ENTRY, error: null }, pending = { data: [], error: null } } = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, ops: [] }
      queries.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'is', 'order', 'limit']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      const answer = () => (table === 'race_registrations' ? entry : table === 'race_payments' ? pending : { data: null, error: null })
      b.maybeSingle = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

const props = (token = signEntryManageToken({ registrationId: R1 }, SECRET)) => ({ params: Promise.resolve({ token }) })
const get = () => new Request('http://localhost/api/public/entry/x', { headers: { 'x-forwarded-for': '1.2.3.4' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
  globalThis.__db = fakeDb()
  countEntryCheckins.mockResolvedValue({ count: 0, error: null })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('GET /api/public/entry/[token]', () => {
  it('a bad or expired token is a 404 with no read', async () => {
    expect((await GET(get(), props('nope'))).status).toBe(404)
    const old = signEntryManageToken({ registrationId: R1 }, SECRET, { nowMs: Date.now() - 91 * 24 * 3600 * 1000 })
    expect((await GET(get(), props(old))).status).toBe(404)
    expect(globalThis.__db.queries).toEqual([])
  })
  it('a missing entry is a 404; an unreadable one is a 500', async () => {
    globalThis.__db = fakeDb({ entry: { data: null, error: null } })
    expect((await GET(get(), props())).status).toBe(404)
    globalThis.__db = fakeDb({ entry: { data: null, error: { message: 'down' } } })
    expect((await GET(get(), props())).status).toBe(500)
  })
  it('answers the public summary with can_move, names only, check-in codes for a confirmed entry', async () => {
    const res = await GET(get(), props())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({
      id: R1, status: 'confirmed', can_move: true, move_blocked_reason: null, date_change_pending: false,
      race: { name: 'Hatch Oct 18', race_date: '2026-10-18' }, wave: { start_time: '11:00:00' },
      team: { name: 'The Crushers', size: 2 },
    })
    expect(data.team.team_members.map((m) => Object.keys(m).sort())).toEqual([
      ['id', 'is_member', 'name', 'qr_url', 'role'], ['id', 'is_member', 'name', 'qr_url', 'role'],
    ])
    expect(JSON.stringify(data)).not.toMatch(/@|phone|capacity|spots/i)
    const select = globalThis.__db.queries.find((q) => q.table === 'race_registrations').ops.find((o) => o[0] === 'select')[1]
    expect(select).not.toMatch(/email|phone/)
  })
  it('is rate limited on the entry bucket (60 per 5 minutes)', async () => {
    await GET(get(), props())
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), 'entry:1.2.3.4', { max: 60, windowMs: 5 * 60_000 })
  })
  it.each([
    ['unpaid', { status: 'pending_payment' }, 0, /waiting for payment/],
    ['cancelled', { status: 'cancelled' }, 0, /no longer active/],
    ['checked in', {}, 1, /checked in/],
    ['past', { race: { ...ENTRY.race, race_date: '2026-10-01' } }, 0, /already happened/],
  ])('%s: can_move false with a plain reason', async (_w, over, checkins, reason) => {
    globalThis.__db = fakeDb({ entry: { data: { ...ENTRY, ...over }, error: null } })
    countEntryCheckins.mockResolvedValue({ count: checkins, error: null })
    const { data } = await (await GET(get(), props())).json()
    expect(data.can_move).toBe(false)
    expect(data.move_blocked_reason).toMatch(reason)
  })
  it('an unreadable check-in count blocks the move rather than guessing', async () => {
    countEntryCheckins.mockResolvedValue({ count: null, error: { message: 'down' } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.can_move).toBe(false)
    expect(data.move_blocked_reason).toMatch(/try again/i)
  })
  it('refreshes a pending date-change payment first (the checkout returns here before the webhook)', async () => {
    const pendingRow = { id: 'gp1', kind: 'move_gap', status: 'pending', payment_provider: 'stripe_connect', payment_provider_ref: 'cs_1' }
    globalThis.__db = fakeDb({ pending: { data: [pendingRow], error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(refreshRacePaymentFromProvider).toHaveBeenCalledWith(globalThis.__db, pendingRow)
    const q = globalThis.__db.queries.find((x) => x.table === 'race_payments')
    expect(q.ops).toContainEqual(['eq', 'race_registration_id', R1])
    expect(q.ops).toContainEqual(['eq', 'kind', 'move_gap'])
    expect(q.ops).toContainEqual(['eq', 'status', 'pending'])
    expect(q.ops).toContainEqual(['is', 'registration_move_id', null])
    expect(data.date_change_pending).toBe(true)
  })
  it('a refresh that throws never breaks the page', async () => {
    refreshRacePaymentFromProvider.mockRejectedValueOnce(new Error('stripe down'))
    globalThis.__db = fakeDb({ pending: { data: [{ id: 'gp1', status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'o1' }], error: null } })
    expect((await GET(get(), props())).status).toBe(200)
  })
})
