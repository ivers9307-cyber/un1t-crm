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
// TZ.9: "today" is the event studio's day at the (fake) clock, 2026-10-09 in
// Dublin as the old dublinTodayStr mock pinned (see beforeEach).

const { checkRateLimit } = await import('@/lib/rate-limit')
const { countEntryCheckins } = await import('@/lib/registration-move')
const { refreshRacePaymentFromProvider } = await import('@/lib/race-payments')
const { signEntryManageToken } = await import('@/lib/entry-manage-tokens')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { GET } = await import('./route.js')

const SECRET = 'svc-key'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const ENTRY = {
  id: R1, status: 'confirmed', race_event_id: 'e1', registered_at: '2026-10-01T10:00:00Z', team_composition: null, race_started_at: null, race_finished_at: null,
  race: { id: 'e1', name: 'Hatch Oct 18', slug: 'hatch-oct18-1100', kind: 'hyrox_sim', race_date: '2026-10-18', location_id: 'L1', locations: { name: 'UN1T Hatch', address: '1 Hatch St' } },
  wave: { id: 'w1', start_time: '11:00:00', label: null },
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [
    { id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true },
    { id: 'm2', name: 'Dan Walsh', role: 'member', is_member: false },
  ] },
}

function fakeDb({ entry = { data: ENTRY, error: null }, pending = { data: [], error: null }, zoneRow = { data: null, error: null } } = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, ops: [] }
      queries.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'is', 'order', 'limit']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      const answer = () => (table === 'race_registrations' ? entry : table === 'race_payments' ? pending : table === 'locations' ? zoneRow : { data: null, error: null })
      b.maybeSingle = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

const props = (token = signEntryManageToken({ registrationId: R1 }, SECRET)) => ({ params: Promise.resolve({ token }) })
const get = () => new Request('http://localhost/api/public/entry/x', { headers: { 'x-forwarded-for': '1.2.3.4' } })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
  globalThis.__db = fakeDb()
  countEntryCheckins.mockResolvedValue({ count: 0, error: null })
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); resetLocationZoneCache() })

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
  it('answers the public summary with can_move and names only (no check-in codes: the page never shows them)', async () => {
    const res = await GET(get(), props())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({
      id: R1, status: 'confirmed', can_move: true, move_blocked_reason: null, date_change_pending: false, date_change_failed: false,
      race: { name: 'Hatch Oct 18', race_date: '2026-10-18' }, wave: { start_time: '11:00:00' },
      team: { name: 'The Crushers', size: 2 },
    })
    expect(data.team.team_members.map((m) => Object.keys(m).sort())).toEqual([
      ['id', 'is_member', 'name', 'role'], ['id', 'is_member', 'name', 'role'],
    ])
    expect(JSON.stringify(data)).not.toMatch(/@|phone|capacity|spots|qr|checkin/i)
    const select = globalThis.__db.queries.find((q) => q.table === 'race_registrations').ops.find((o) => o[0] === 'select')[1]
    expect(select).not.toMatch(/email|phone/)
  })
  // FINDTEAM.8 (I5) — a placed solo: the team they joined and its wave, names and times only.
  it('a placed row carries placed_into and the placed move reason', async () => {
    globalThis.__db = fakeDb({ entry: { data: {
      ...ENTRY, status: 'placed',
      teams: { id: 't-solo', name: 'Sarah Byrne (looking for a team)', size: 1, team_members: [{ id: 'm9', name: 'Sarah Byrne', role: 'captain', is_member: false }] },
      placed_into: { teams: { name: 'The Crushers' }, wave: { start_time: '12:30:00', label: 'Heat B' } },
    }, error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.placed_into).toEqual({ team_name: 'The Crushers', wave: { start_time: '12:30:00', label: 'Heat B' } })
    expect(data.can_move).toBe(false)
    expect(data.move_blocked_reason).toBe("You've been placed in a team, so your team's time applies; contact the studio to change it.")
    const select = globalThis.__db.queries.find((q) => q.table === 'race_registrations').ops.find((o) => o[0] === 'select')[1]
    expect(select.replace(/\s+/g, ' ')).toContain('placed_into:placed_into_registration_id ( teams:team_id ( name ), wave:wave_id ( start_time, label ) )')
  })
  it('a row that is not placed has placed_into null', async () => {
    const { data } = await (await GET(get(), props())).json()
    expect(data.placed_into).toBeNull()
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
  it('TZ.9: "already happened" is by the event studio\'s day; an unreadable zone hides the move', async () => {
    // 2026-11-01T03:30Z: Dublin is Sunday 1 Nov; New York is Saturday 31 Oct 23:30.
    vi.setSystemTime(new Date('2026-11-01T03:30:00Z'))
    // ENTRYPOLICY.1: the race is today at the studio, so the default 48 h
    // cutoff would block it; this test is about the DAY, so no cutoff here.
    const entry = { data: { ...ENTRY, race: { ...ENTRY.race, race_date: '2026-10-31', entry_policy: { cutoff_hours: 0 } } }, error: null }
    globalThis.__db = fakeDb({ entry, zoneRow: { data: { id: 'L1', timezone: 'America/New_York' }, error: null } })
    expect((await (await GET(get(), props())).json()).data.can_move).toBe(true)
    // The page payload never carries the zone.
    expect(JSON.stringify((await (await GET(get(), props())).json()).data.race)).not.toMatch(/timezone/)
    resetLocationZoneCache()
    globalThis.__db = fakeDb({ entry, zoneRow: { data: { id: 'L1', timezone: 'Europe/Dublin' }, error: null } })
    const dub = (await (await GET(get(), props())).json()).data
    expect(dub.can_move).toBe(false)
    expect(dub.move_blocked_reason).toMatch(/already happened/)
    resetLocationZoneCache()
    globalThis.__db = fakeDb({ entry, zoneRow: { data: null, error: { message: 'down' } } })
    const down = (await (await GET(get(), props())).json()).data
    expect(down.can_move).toBe(false)
    expect(down.move_blocked_reason).toMatch(/try again/i)
  })
  it('refreshes a pending date-change payment first (the checkout returns here before the webhook)', async () => {
    const pendingRow = { id: 'gp1', kind: 'move_gap', status: 'pending', payment_provider: 'stripe_connect', payment_provider_ref: 'cs_1',
      metadata: { pending_move: { target_event_id: 'e2', expected_source_event_id: 'e1' } } }
    globalThis.__db = fakeDb({ pending: { data: [pendingRow], error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(refreshRacePaymentFromProvider).toHaveBeenCalledWith(globalThis.__db, pendingRow)
    const q = globalThis.__db.queries.find((x) => x.table === 'race_payments')
    expect(q.ops).toContainEqual(['eq', 'race_registration_id', R1])
    expect(q.ops).toContainEqual(['eq', 'kind', 'move_gap'])
    expect(q.ops).toContainEqual(['is', 'registration_move_id', null])
    expect(data.date_change_pending).toBe(true)
  })
  it('a refresh that throws never breaks the page', async () => {
    refreshRacePaymentFromProvider.mockRejectedValueOnce(new Error('stripe down'))
    globalThis.__db = fakeDb({ pending: { data: [{ id: 'gp1', status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'o1', metadata: { pending_move: {} } }], error: null } })
    expect((await GET(get(), props())).status).toBe(200)
  })
})

// Review minor — a paid change that was refused shows on the page as "we are
// looking into it", while the entry is still where the change started.
describe('GET /api/public/entry/[token] — a refused date change', () => {
  const PM = { target_event_id: 'e2', target_wave_id: 'w2', expected_source_event_id: 'e1', actor: { type: 'customer' } }
  const failed = (over = {}) => ({ id: 'gp1', kind: 'move_gap', status: 'completed', payment_provider: 'stripe_connect', payment_provider_ref: 'cs_1',
    metadata: { pending_move: PM, pending_move_failed: { error: 'wave_full', at: '2026-10-09T10:00:00Z' } }, ...over })
  it('date_change_failed while the entry is still on the event the change started from', async () => {
    globalThis.__db = fakeDb({ pending: { data: [failed()], error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.date_change_failed).toBe(true)
    expect(data.date_change_pending).toBe(false)
    expect(refreshRacePaymentFromProvider).not.toHaveBeenCalled()
  })
  it('not once staff have moved the entry by hand, or refunded it', async () => {
    globalThis.__db = fakeDb({ pending: { data: [failed()], error: null }, entry: { data: { ...ENTRY, race_event_id: 'e9' }, error: null } })
    expect((await (await GET(get(), props())).json()).data.date_change_failed).toBe(false)
    globalThis.__db = fakeDb({ pending: { data: [failed({ status: 'refunded' })], error: null } })
    expect((await (await GET(get(), props())).json()).data.date_change_failed).toBe(false)
  })
  it('never echoes the payment or its metadata', async () => {
    globalThis.__db = fakeDb({ pending: { data: [failed()], error: null } })
    const text = JSON.stringify(await (await GET(get(), props())).json())
    expect(text).not.toMatch(/pending_move|wave_full|gp1|cs_1/)
  })
})

// ENTRYPOLICY.1 — the entry policy on the page: the reschedule switch and the
// cutoff block the date change in the operator's words; an unpaid entry past
// the event's hold reads lapsed, with the operator's sentence and the way back.
describe('GET /api/public/entry/[token] — entry policy', () => {
  it('a confirmed entry inside the 48 h cutoff cannot move, in the operator\'s words; the policy itself never leaves', async () => {
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    globalThis.__db = fakeDb({ entry: { data: { ...ENTRY, race: { ...ENTRY.race, entry_policy: { cutoff_message: 'Too late for {{event_name}}: ring us.' } } }, error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.can_move).toBe(false)
    expect(data.move_blocked_reason).toBe('Too late for Hatch Oct 18: ring us.')
    expect(data.lapsed).toBe(false)
    expect(JSON.stringify(data)).not.toMatch(/entry_policy|cutoff_hours/)
  })
  it('date changes switched off: blocked with the disabled copy', async () => {
    globalThis.__db = fakeDb({ entry: { data: { ...ENTRY, race: { ...ENTRY.race, entry_policy: { self_reschedule_enabled: false } } }, error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.can_move).toBe(false)
    expect(data.move_blocked_reason).toMatch(/handled by the team/)
  })
  it('an unpaid entry past the hold is lapsed: the operator sentence and a link to register again', async () => {
    globalThis.__db = fakeDb({ entry: { data: { ...ENTRY, status: 'pending_payment', registered_at: '2026-10-01T10:00:00Z' }, error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.lapsed).toBe(true)
    expect(data.lapsed_message).toBe('Your unpaid entry for Hatch Oct 18 was held for 48 hours and has now lapsed. You can register again if places remain.')
    expect(data.register_url).toBe('/event/hatch-oct18-1100')
    expect(data.status).toBe('pending_payment')
    expect(data.can_move).toBe(false)
  })
  it('an unpaid entry inside the hold is not lapsed (still waiting for payment)', async () => {
    globalThis.__db = fakeDb({ entry: { data: { ...ENTRY, status: 'pending_payment', registered_at: '2026-10-09T10:00:00Z' }, error: null } })
    const { data } = await (await GET(get(), props())).json()
    expect(data.lapsed).toBe(false)
    expect(data.lapsed_message).toBeNull()
    expect(data.register_url).toBeNull()
    expect(data.move_blocked_reason).toMatch(/waiting for payment/)
  })
})

