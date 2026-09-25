// AVAIL.1 — GET/PUT /api/schedule/availability. The data layer and the
// notice are pinned in their own tests; here: the gates, the query contract,
// validation in both layers, and that a notice is handed to after() only for
// a real change.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-09-25' }))
vi.mock('@/lib/availability-server', async (importOriginal) => ({
  ...(await importOriginal()),
  readOwnAvailability: vi.fn(),
  saveOwnAvailability: vi.fn(),
  readStudioAvailability: vi.fn(),
  readKnownDatedKeys: vi.fn(),
}))
vi.mock('@/lib/availability-notify', () => ({ deliverOwedAvailabilityNotices: vi.fn(async () => ({ status: 'sent', sent: 1 })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { after, NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { readOwnAvailability, saveOwnAvailability, readStudioAvailability, readKnownDatedKeys } = await import('@/lib/availability-server')
const { ruleKey } = await import('@shared/availability')
const { deliverOwedAvailabilityNotices } = await import('@/lib/availability-notify')
const { GET, PUT } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const coach = { id: 'u1', full_name: 'Sam Demo', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } }
const manager = { ...coach, id: 'm1', rolesByLocation: { [LOC]: 'manager' } }

const getReq = (params = {}) => {
  const url = new URL('http://test/api/schedule/availability')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const putReq = (body) => ({ url: 'http://test/api/schedule/availability', json: async () => body })

const MON = { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00' }

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  readOwnAvailability.mockResolvedValue({ data: { weekly: [], dated: [] }, error: null })
  readStudioAvailability.mockResolvedValue({ data: [{ id: 'r1', profile_id: 'c1' }], error: null })
  readKnownDatedKeys.mockResolvedValue({ keys: new Set(), rules: [], error: null })
  saveOwnAvailability.mockResolvedValue({
    result: { changed: true, changeId: 'ch-1', before: [], after: [{ kind: 'weekly', weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null }] },
    error: null,
  })
})

describe('GET own', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq())).status).toBe(401)
    expect(readOwnAvailability).not.toHaveBeenCalled()
  })
  it('any staff member reads their own, as of Dublin today', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { weekly: [], dated: [] } })
    expect(readOwnAvailability).toHaveBeenCalledWith({ db: true }, 'u1', '2026-09-25')
  })
  it('a failed read is a 500, never an empty availability', async () => {
    getCurrentUser.mockResolvedValue(coach)
    readOwnAvailability.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect((await GET(getReq())).status).toBe(500)
  })
})

describe('GET studio range', () => {
  const q = { location_id: LOC, start_date: '2026-05-04', end_date: '2026-05-10' }
  it("403 from assertLocationAccess for a studio outside the caller's assignments", async () => {
    getCurrentUser.mockResolvedValue(manager)
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    expect((await GET(getReq(q))).status).toBe(403)
    expect(readStudioAvailability).not.toHaveBeenCalled()
  })
  it('403 for a coach (staff AT that studio)', async () => {
    getCurrentUser.mockResolvedValue(coach)
    expect((await GET(getReq(q))).status).toBe(403)
    expect(readStudioAvailability).not.toHaveBeenCalled()
  })
  it('a manager at that studio reads it', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await GET(getReq(q))
    expect(res.status).toBe(200)
    expect(readStudioAvailability).toHaveBeenCalledWith({ db: true }, { locationId: LOC, startDate: '2026-05-04', endDate: '2026-05-10' })
  })
  it.each([
    [{ location_id: 'nope', start_date: '2026-05-04', end_date: '2026-05-10' }],
    [{ location_id: LOC, start_date: '2026-05-04' }],
    [{ location_id: LOC, start_date: '2026-02-30', end_date: '2026-03-02' }],
    [{ location_id: LOC, start_date: '2026-05-10', end_date: '2026-05-04' }],
    [{ location_id: LOC, start_date: '2026-05-01', end_date: '2026-08-01' }], // 93 days
  ])('400 for %j', async (params) => {
    getCurrentUser.mockResolvedValue(manager)
    expect((await GET(getReq(params))).status).toBe(400)
    expect(readStudioAvailability).not.toHaveBeenCalled()
  })
})

describe('PUT own', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq({ weekly: [MON] }))).status).toBe(401)
  })
  it('400 for a malformed body, nothing saved', async () => {
    getCurrentUser.mockResolvedValue(coach)
    expect((await PUT(putReq({ weekly: [{ weekday: 'monday' }] }))).status).toBe(400)
    expect(saveOwnAvailability).not.toHaveBeenCalled()
  })
  it('400 with issues for an end before the start or a passed date, nothing saved', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await PUT(putReq({ weekly: [{ ...MON, end_time: '08:00' }], dated: [{ start_date: '2026-09-01', all_day: true }] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues).toEqual([
      { path: 'weekly.0', message: 'The end time must be after the start time' },
      { path: 'dated.0', message: 'That date has passed' },
    ])
    expect(saveOwnAvailability).not.toHaveBeenCalled()
  })
  it('stale tab over midnight: an ENDED rule the coach already has is dropped (history), not refused', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const stale = { start_date: '2026-09-23', end_date: '2026-09-24', all_day: true, note: 'Wedding' }
    readKnownDatedKeys.mockResolvedValue({ keys: new Set([ruleKey({ kind: 'dated', ...stale })]), rules: [{ kind: 'dated', ...stale }], error: null })
    const res = await PUT(putReq({ weekly: [MON], dated: [stale, { start_date: '2026-10-03', all_day: true }] }))
    expect(res.status).toBe(200)
    expect(readKnownDatedKeys).toHaveBeenCalledWith({ db: true }, 'u1', '2026-09-25', ['2026-09-23'])
    expect(saveOwnAvailability.mock.calls[0][1].dated.map((r) => r.start_date)).toEqual(['2026-10-03'])
  })
  it('a NEW rule that ended before today is still refused', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await PUT(putReq({ dated: [{ start_date: '2026-09-23', end_date: '2026-09-24', all_day: true }] }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues).toEqual([{ path: 'dated.0', message: 'That date has passed' }])
    expect(saveOwnAvailability).not.toHaveBeenCalled()
  })
  it('an unreadable history is a 500, never a guess', async () => {
    getCurrentUser.mockResolvedValue(coach)
    readKnownDatedKeys.mockResolvedValue({ keys: null, rules: null, error: { message: 'down' } })
    expect((await PUT(putReq({ dated: [{ start_date: '2026-09-23', end_date: '2026-09-24', all_day: true }] }))).status).toBe(500)
    expect(saveOwnAvailability).not.toHaveBeenCalled()
  })
  it('a NEW rule that starts before today (backdating) is refused; one the coach already has is kept', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const started = { start_date: '2026-09-20', end_date: '2026-09-30', all_day: true }
    let res = await PUT(putReq({ dated: [started] }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues).toEqual([{ path: 'dated.0', message: 'Start today or later' }])
    expect(saveOwnAvailability).not.toHaveBeenCalled()

    readKnownDatedKeys.mockResolvedValue({ keys: new Set([ruleKey({ kind: 'dated', ...started })]), rules: [{ kind: 'dated', ...started }], error: null })
    res = await PUT(putReq({ dated: [{ ...started, note: 'edited note' }] }))
    expect(res.status).toBe(200)
    expect(saveOwnAvailability.mock.calls[0][1].dated).toEqual([expect.objectContaining({ start_date: '2026-09-20', end_date: '2026-09-30', note: 'edited note' })])
  })
  it('a STARTED rule whose end moved (20-30 -> 20-27 on the 25th) is saved as 25-27; the RPC keeps 20-24 as history', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const stored = { kind: 'dated', weekday: null, start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: null }
    readKnownDatedKeys.mockResolvedValue({ keys: new Set([ruleKey(stored)]), rules: [stored], error: null })
    const res = await PUT(putReq({ dated: [{ start_date: '2026-09-20', end_date: '2026-09-27', all_day: true }] }))
    expect(res.status).toBe(200)
    expect(saveOwnAvailability.mock.calls[0][1].dated).toEqual([expect.objectContaining({ start_date: '2026-09-25', end_date: '2026-09-27' })])
  })
  it('no dated rule before today: the history is not read at all', async () => {
    getCurrentUser.mockResolvedValue(coach)
    await PUT(putReq({ weekly: [MON], dated: [{ start_date: '2026-10-03', all_day: true }] }))
    expect(readKnownDatedKeys).not.toHaveBeenCalled()
  })
  it('saves the canonical lists for the caller and hands the notice to after()', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await PUT(putReq({ weekly: [MON, MON], dated: [] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { changed: true, weekly: [{ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null }], dated: [] } })
    const args = saveOwnAvailability.mock.calls[0][1]
    expect(args).toMatchObject({ profileId: 'u1', actorId: 'u1', todayIso: '2026-09-25' })
    expect(args.weekly).toHaveLength(1) // duplicate collapsed
    expect(after).toHaveBeenCalledTimes(1)
    // The save's notice folds in any older owed change of this coach (not just this one).
    expect(deliverOwedAvailabilityNotices).toHaveBeenCalledWith({ db: true }, 'u1')
  })
  it('an unchanged save notifies nobody', async () => {
    getCurrentUser.mockResolvedValue(coach)
    saveOwnAvailability.mockResolvedValue({ result: { changed: false, changeId: null, before: [], after: [] }, error: null })
    const res = await PUT(putReq({ weekly: [], dated: [] }))
    expect((await res.json()).data.changed).toBe(false)
    expect(after).not.toHaveBeenCalled()
  })
  it('records the master as the actor under View as user', async () => {
    getCurrentUser.mockResolvedValue({ ...coach, impersonatingFrom: { masterId: 'master-1' } })
    await PUT(putReq({ weekly: [MON] }))
    expect(saveOwnAvailability.mock.calls[0][1]).toMatchObject({ profileId: 'u1', actorId: 'master-1' })
  })
  it('an input error from the database is a 400; anything else a 500', async () => {
    getCurrentUser.mockResolvedValue(coach)
    saveOwnAvailability.mockResolvedValue({ result: null, error: { code: '23514', message: 'violates check constraint' } })
    expect((await PUT(putReq({ weekly: [MON] }))).status).toBe(400)
    saveOwnAvailability.mockResolvedValue({ result: null, error: { code: '42P01', message: 'relation does not exist' } })
    expect((await PUT(putReq({ weekly: [MON] }))).status).toBe(500)
    expect(after).not.toHaveBeenCalled()
  })
  it("says the RPC's own availability_* reason in words, and never echoes raw Postgres text", async () => {
    getCurrentUser.mockResolvedValue(coach)
    saveOwnAvailability.mockResolvedValue({ result: null, error: { code: 'P0001', message: 'availability_past_date: a date that has already passed cannot be added' } })
    expect((await (await PUT(putReq({ weekly: [MON] }))).json()).error).toBe('a date that has already passed cannot be added')
    saveOwnAvailability.mockResolvedValue({ result: null, error: { code: '23514', message: 'new row for relation "staff_unavailability" violates check constraint "staff_unavailability_window"' } })
    expect((await (await PUT(putReq({ weekly: [MON] }))).json()).error).toBe('Invalid availability')
  })
})
