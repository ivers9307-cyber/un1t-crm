// SHELLYGROUPS.5 — GET /api/shelly/preview?date=: a day of the schedule,
// computed by the engine the cron calls (resolveServeWindows on each group for
// the location's day), never re-implemented.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  LOC_A, LOC_B, GRP_A, GRP_B, OWNER_ID, OWNER_A, OWNER_NY, STAFF_A,
  groupRow, makeDb, req,
} from '../shelly-routes.test-helpers.js'

// Monday 24 Aug 2026, 12:00 Dublin.
const NOW = Date.parse('2026-08-24T11:00:00.000Z')
const GRP_F = '90000000-0000-4000-8000-0000000000af'
const get = (q = '') => GET(req(`http://localhost/api/shelly/preview${q}`, { method: 'GET' }))

const weekdays = { lead_min: 15, lag_min: 10, merge_gap_min: 30, days: [1, 2, 3, 4, 5] }
const occ = (startIso, endIso, name, location_id = LOC_A) => ({ location_id, starts_at: startIso, ends_at: endIso, cancelled_at: null, name })

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
}
const world = (groups, occurrences) => ({ rows: { shelly_groups: groups, class_occurrences: occurrences } })
const defaultWorld = () => world(
  [
    groupRow({ enabled: true, schedule_mode: 'class', class_rule: weekdays }),
    groupRow({ id: GRP_F, name: 'Fans', enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [1, 2, 3, 4, 5, 6, 7], on: '07:00', off: '09:00' }] }),
    groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs', enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [1], on: '01:00', off: '02:00' }] }),
  ],
  [
    // Monday 18:00-19:00 Dublin
    occ('2026-08-24T17:00:00.000Z', '2026-08-24T18:00:00.000Z', 'HIIT'),
    // Saturday 10:00-11:00 Dublin
    occ('2026-08-29T09:00:00.000Z', '2026-08-29T10:00:00.000Z', 'Saturday Sweat'),
    // A cancelled class and another studio's class never show.
    { ...occ('2026-08-24T08:00:00.000Z', '2026-08-24T09:00:00.000Z', 'Cancelled'), cancelled_at: '2026-08-20T00:00:00.000Z' },
    occ('2026-08-24T10:00:00.000Z', '2026-08-24T11:00:00.000Z', 'Elsewhere', LOC_B),
  ],
)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  getCurrentUser.mockResolvedValue(OWNER_A)
  useDb(defaultWorld())
})
afterEach(() => vi.useRealTimers())

describe('GET /api/shelly/preview', () => {
  it('defaults to today at the location, with its classes and each group’s windows', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.date).toBe('2026-08-24')
    expect(body.classes).toEqual([{ starts_at: '2026-08-24T17:00:00.000Z', ends_at: '2026-08-24T18:00:00.000Z', name: 'HIIT' }])
    const byId = Object.fromEntries(body.groups.map((g) => [g.id, g.windows]))
    expect(byId[GRP_F]).toEqual([{ on_at: '2026-08-24T06:00:00.000Z', off_at: '2026-08-24T08:00:00.000Z' }])
    expect(byId[GRP_A]).toEqual([{ on_at: '2026-08-24T16:45:00.000Z', off_at: '2026-08-24T18:10:00.000Z' }])
    expect(body.groups.map((g) => g.id).sort()).toEqual([GRP_A, GRP_F].sort())
    expect(body.ignored_overrides).toEqual([])
    expect(JSON.stringify(body)).not.toContain(GRP_B)
  })

  it('a Saturday with days Mon–Fri gives that group no windows; the other group still has its own', async () => {
    const body = await (await get('?date=2026-08-29')).json()
    expect(body.classes.map((c) => c.name)).toEqual(['Saturday Sweat'])
    const byId = Object.fromEntries(body.groups.map((g) => [g.id, g.windows]))
    expect(byId[GRP_A]).toEqual([])
    expect(byId[GRP_F]).toEqual([{ on_at: '2026-08-29T06:00:00.000Z', off_at: '2026-08-29T08:00:00.000Z' }])
  })

  it('a disabled or scheduleless group has no windows', async () => {
    useDb(world([groupRow({ enabled: false, schedule_mode: 'fixed', fixed_windows: [{ days: [1], on: '07:00', off: '09:00' }] })], []))
    expect((await (await get()).json()).groups).toEqual([{ id: GRP_A, windows: [] }])
  })

  it('names a group whose live override the strip does not show', async () => {
    useDb(world([groupRow({ override: { state: 'on', until: '2026-08-24T22:00:00.000Z', set_by: OWNER_ID, set_at: '2026-08-24T10:00:00.000Z' } })], []))
    expect((await (await get()).json()).ignored_overrides).toEqual([GRP_A])
  })

  it('works in the location’s zone: "today" in New York', async () => {
    getCurrentUser.mockResolvedValue(OWNER_NY)
    vi.setSystemTime(Date.parse('2026-08-25T02:00:00.000Z')) // 22:00 Monday in New York
    expect((await (await get()).json()).date).toBe('2026-08-24')
  })

  it('refuses a malformed or impossible date', async () => {
    for (const q of ['?date=2026-02-30', '?date=tomorrow', '?date=24-08-2026']) {
      const res = await get(q)
      expect(res.status, q).toBe(400)
    }
  })

  it('refuses a date more than 60 days away', async () => {
    expect((await get('?date=2026-10-23')).status).toBe(200)
    expect((await get('?date=2026-10-24')).status).toBe(400)
    expect((await get('?date=2026-06-25')).status).toBe(200)
    expect((await get('?date=2026-06-24')).status).toBe(400)
  })

  it('a timetable that cannot be read is a 502 naming it', async () => {
    useDb({ ...defaultWorld(), selectError: { class_occurrences: { message: 'pg down' } } })
    const res = await get()
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('occurrences')
  })

  it('403s staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await get()).status).toBe(403)
  })
})
