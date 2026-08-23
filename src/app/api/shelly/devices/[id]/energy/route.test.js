// SHELLY-UI.5 — one device's daily kWh.
//
// Three things this suite is for:
//
//  1. THE WINDOW IS THE LOCATION'S CALENDAR, not UTC's and not the server's.
//     The `day` column is the day in locations.timezone at sample time (mig
//     562), so a New York studio reading at 02:30 UTC must be asked about
//     YESTERDAY. Asserted with a fixed clock and both zones, so it holds under
//     TZ=Europe/Dublin and TZ=America/New_York alike.
//  2. THE RUN IS CONTIGUOUS ACROSS A DST CHANGE. addDaysISO walks calendar
//     dates, so the 25-hour day is still one bar — the run is asserted to be
//     `days` long with no repeats and no gaps, over the November fall-back.
//  3. IT IS READ PER DEVICE. mig 562's own comment: a location-wide 30-day
//     read is 1,500 rows against a 1,000-row cap that fails silently. The fake
//     holds another device's rows and another location's, and filters on the
//     recorded .eq()s.

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
  LOC_A, LOC_B, DEV_A, DEV_B, BAD_ID, OWNER_A, OWNER_NY, STAFF_A,
  deviceRow, energyRow, makeDb, selectsFrom, ctxFor,
} from '../../../shelly-routes.test-helpers.js'

const getReq = (qs = '') => new Request(`http://localhost/api/shelly/devices/x/energy${qs}`)

const world = (energy = [], deviceOver = {}) => ({
  rows: {
    shelly_devices: [
      deviceRow(deviceOver),
      deviceRow({ id: DEV_B, location_id: LOC_B, name: 'Their plug', device_id: 'ffeedd998877' }),
    ],
    shelly_energy_daily: energy,
  },
})

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
const energyQuery = () => selectsFrom(db, 'shelly_energy_daily')[0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-08-23T12:00:00.000Z'))
  useDb(world())
  getCurrentUser.mockResolvedValue(OWNER_A)
})

afterEach(() => vi.useRealTimers())

describe('GET …/energy — the window', () => {
  it('ends on the LOCATION’s today and runs back `days` days inclusive', async () => {
    const body = await (await GET(getReq('?days=7'), ctxFor(DEV_A))).json()
    expect(body).toMatchObject({ success: true, device_id: DEV_A, from: '2026-08-17', to: '2026-08-23' })
    expect(body.days).toHaveLength(7)
    expect(body.days[0].day).toBe('2026-08-17')
    expect(body.days[6].day).toBe('2026-08-23')
  })

  it('uses the location’s zone for "today", not UTC', async () => {
    // 02:30 UTC is still the 22nd in New York.
    vi.setSystemTime(Date.parse('2026-08-23T02:30:00.000Z'))
    getCurrentUser.mockResolvedValue(OWNER_NY)
    const body = await (await GET(getReq('?days=2'), ctxFor(DEV_A))).json()
    expect(body.to).toBe('2026-08-22')
    expect(body.from).toBe('2026-08-21')

    // The same instant in Dublin is already the 23rd — so the assertion above
    // is about the zone and not about the clock.
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await (await GET(getReq('?days=2'), ctxFor(DEV_A))).json()).to).toBe('2026-08-23')
  })

  it('stays contiguous across a DST change — the 25-hour day is still one bar', async () => {
    // US DST ends 2026-11-01.
    vi.setSystemTime(Date.parse('2026-11-03T17:00:00.000Z'))
    getCurrentUser.mockResolvedValue(OWNER_NY)
    const body = await (await GET(getReq('?days=7'), ctxFor(DEV_A))).json()
    const days = body.days.map((d) => d.day)
    expect(days).toEqual([
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
      '2026-11-01', '2026-11-02', '2026-11-03',
    ])
    expect(new Set(days).size).toBe(7)
    expect(body.from).toBe('2026-10-28')
    expect(body.to).toBe('2026-11-03')
  })

  it('bounds the query the same way it bounds the answer', async () => {
    await GET(getReq('?days=30'), ctxFor(DEV_A))
    const q = energyQuery()
    expect(q.limit).toBe(30)
    expect(q.gte).toEqual({ day: '2026-07-25' })
    expect(q.lte).toEqual({ day: '2026-08-23' })
    expect(q.orders.map(([c]) => c)).toEqual(['day'])
    expect(q.cols).toBe('day, wh_total, samples, resets')
  })
})

describe('GET …/energy — the days parameter', () => {
  it('defaults to 30 when absent', async () => {
    const body = await (await GET(getReq(), ctxFor(DEV_A))).json()
    expect(body.days).toHaveLength(30)
  })

  it('defaults to 30 for a bare ?days= too', async () => {
    const body = await (await GET(getReq('?days='), ctxFor(DEV_A))).json()
    expect(body.days).toHaveLength(30)
  })

  it('accepts 1 — today only', async () => {
    const body = await (await GET(getReq('?days=1'), ctxFor(DEV_A))).json()
    expect(body.days).toHaveLength(1)
    expect(body.from).toBe(body.to)
  })

  it('400s junk and out-of-range values, in the shape the client renders', async () => {
    for (const qs of ['?days=abc', '?days=0', '?days=91', '?days=-5', '?days=2.5']) {
      const res = await GET(getReq(qs), ctxFor(DEV_A))
      expect(res.status, qs).toBe(400)
      const body = await res.json()
      expect(body.issues?.[0]?.message || body.error).toEqual(expect.any(String))
    }
  })
})

describe('GET …/energy — the rows', () => {
  it('zero-fills a missing day, and says so with samples:0', async () => {
    useDb(world([energyRow({ day: '2026-08-23', wh_total: 1500, samples: 1440, resets: 1 })]))
    const body = await (await GET(getReq('?days=3'), ctxFor(DEV_A))).json()
    expect(body.days).toEqual([
      { day: '2026-08-21', kwh: 0, samples: 0, resets: 0 },
      { day: '2026-08-22', kwh: 0, samples: 0, resets: 0 },
      { day: '2026-08-23', kwh: 1.5, samples: 1440, resets: 1 },
    ])
  })

  it('rounds kWh to three places', async () => {
    useDb(world([energyRow({ day: '2026-08-23', wh_total: 1234.567 })]))
    const body = await (await GET(getReq('?days=1'), ctxFor(DEV_A))).json()
    expect(body.days[0].kwh).toBe(1.235)
  })

  it('reads a numeric column that arrives as a string', async () => {
    // numeric(14,3) can be serialised as a string by a driver; 0 would be a
    // measurement we never made.
    useDb(world([energyRow({ day: '2026-08-23', wh_total: '2500.000' })]))
    expect((await (await GET(getReq('?days=1'), ctxFor(DEV_A))).json()).days[0].kwh).toBe(2.5)
  })

  it('answers null — never 0 — for a value it cannot read', async () => {
    useDb(world([energyRow({ day: '2026-08-23', wh_total: null })]))
    expect((await (await GET(getReq('?days=1'), ctxFor(DEV_A))).json()).days[0].kwh).toBeNull()
  })

  it('is read PER DEVICE and per location', async () => {
    useDb(world([
      energyRow({ day: '2026-08-23', wh_total: 1000 }),
      energyRow({ day: '2026-08-23', device_id: DEV_B, location_id: LOC_B, wh_total: 9999 }),
    ]))
    const body = await (await GET(getReq('?days=1'), ctxFor(DEV_A))).json()
    expect(body.days[0].kwh).toBe(1)
    expect(energyQuery().filters).toEqual({ location_id: LOC_A, device_id: DEV_A })
  })
})

describe('GET …/energy — the gates', () => {
  it('404s a malformed id and a foreign id identically, without reading energy', async () => {
    const malformed = await GET(getReq(), ctxFor(BAD_ID))
    const foreign = await GET(getReq(), ctxFor(DEV_B))
    expect(malformed.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await malformed.json()).toEqual(await foreign.json())
    expect(selectsFrom(db, 'shelly_energy_daily')).toEqual([])
  })

  it('500s a failed energy read rather than reporting a flat zero month', async () => {
    useDb({ ...world(), selectError: { shelly_energy_daily: { message: 'db down' } } })
    expect((await GET(getReq(), ctxFor(DEV_A))).status).toBe(500)
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await GET(getReq(), ctxFor(DEV_A))).status).toBe(403)
  })
})
