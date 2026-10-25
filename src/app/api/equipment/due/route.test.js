// EQUIP-MAINT.2 — route tests for the due-list route.
//
// The route's whole job is telling "not set up" apart from "nothing
// due" — a dormant location (no settings row, or enabled: false) must
// come back as { enabled: false }, never an empty due list that reads
// as "all clear".

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) => {
    let input
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(await request.json())
      if (!parsed.success) {
        return { status: 400, json: async () => ({ success: false, error: 'Invalid body.' }) }
      }
      input = parsed.data
    }
    return handler({
      user: h.user,
      db: {},
      locationId: h.locationId,
      request,
      input,
      params: ctx?.params ? await ctx.params : undefined,
    })
  },
}))
vi.mock('@/lib/equipment-db', () => ({
  getSettings: vi.fn(),
  listDueEquipment: vi.fn(),
  listOutOfServiceEquipment: vi.fn(),
}))

import { GET } from './route.js'
import { getSettings, listDueEquipment, listOutOfServiceEquipment } from '@/lib/equipment-db'

function req() {
  return { headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/equipment/due', () => {
  it('returns enabled: false when there is no settings row at all', async () => {
    getSettings.mockResolvedValue(null)
    const res = await GET(req(), {})
    const body = await res.json()
    expect(body.data.enabled).toBe(false)
    expect(body.data.due).toEqual([])
    expect(body.data.outOfService).toEqual([])
    expect(listDueEquipment).not.toHaveBeenCalled()
    expect(listOutOfServiceEquipment).not.toHaveBeenCalled()
  })

  it('returns enabled: false when the settings row exists but is switched off', async () => {
    getSettings.mockResolvedValue({ location_id: 'loc-1', inspection_day_of_week: 2, enabled: false })
    const res = await GET(req(), {})
    const body = await res.json()
    expect(body.data.enabled).toBe(false)
    expect(listDueEquipment).not.toHaveBeenCalled()
  })

  it('returns the due and out-of-service lists when enabled', async () => {
    getSettings.mockResolvedValue({ location_id: 'loc-1', inspection_day_of_week: 2, enabled: true })
    listDueEquipment.mockResolvedValue([{ id: 'eq-1', name: 'Treadmill 3' }])
    listOutOfServiceEquipment.mockResolvedValue([{ id: 'eq-2', name: 'Rower 1' }])
    const res = await GET(req(), {})
    const body = await res.json()
    expect(body.data.enabled).toBe(true)
    expect(body.data.inspectionDayOfWeek).toBe(2)
    expect(body.data.due).toEqual([{ id: 'eq-1', name: 'Treadmill 3' }])
    expect(body.data.outOfService).toEqual([{ id: 'eq-2', name: 'Rower 1' }])
  })
})

// TZ.8b — "today" is the studio's own day (the active studio's timezone).
describe('GET /api/equipment/due — the studio\'s day (TZ.8b)', () => {
  const NY_DAY_START = Date.parse('2026-11-01T04:00:00Z') // 00:00 EDT, the US fall-back day
  const NY_DAY_END = Date.parse('2026-11-02T04:59:00Z') // 23:59 EST: a 25-hour day
  const todayAt = async (ms, timezone) => {
    vi.useFakeTimers({ toFake: ['Date'], now: ms })
    h.user = { ...h.user, activeLocation: { id: 'loc-1', timezone } }
    getSettings.mockResolvedValue({ location_id: 'loc-1', inspection_day_of_week: 0, enabled: true })
    listDueEquipment.mockResolvedValue([])
    listOutOfServiceEquipment.mockResolvedValue([])
    const body = await (await GET(req(), {})).json()
    vi.useRealTimers()
    return { today: body.data.today, asked: listDueEquipment.mock.calls.at(-1)[2] }
  }

  it('a New York item due 2026-11-01 is due today from 04:00Z on 1 Nov to 04:59Z on 2 Nov', async () => {
    expect((await todayAt(NY_DAY_START - 60_000, 'America/New_York')).today).toBe('2026-10-31')
    for (let ms = NY_DAY_START; ms <= NY_DAY_END; ms += 15 * 60_000) {
      const { today, asked } = await todayAt(ms, 'America/New_York')
      expect(today).toBe('2026-11-01')
      expect(asked).toBe('2026-11-01')
    }
    expect((await todayAt(NY_DAY_END + 60_000, 'America/New_York')).today).toBe('2026-11-02')
    // Summer: 23:30 EDT on 30 Jun is still 30 Jun in New York (1 Jul in Dublin).
    expect((await todayAt(Date.parse('2026-07-01T03:30:00Z'), 'America/New_York')).today).toBe('2026-06-30')
  })

  it('a Dublin studio is byte-identical to the old Dublin day (and a dormant one echoes it too)', async () => {
    // TZ.18b: the old dublinTodayStr answers, pinned as literals.
    for (const [iso, legacy] of [['2026-03-29T00:59:00Z', '2026-03-29'], ['2026-03-29T01:00:00Z', '2026-03-29'],
      ['2026-06-30T22:59:00Z', '2026-06-30'], ['2026-06-30T23:00:00Z', '2026-07-01'], ['2026-10-24T23:30:00Z', '2026-10-25'],
      ['2026-10-25T00:59:00Z', '2026-10-25'], ['2026-10-25T01:00:00Z', '2026-10-25'], ['2026-12-31T23:30:00Z', '2026-12-31']]) {
      const ms = Date.parse(iso)
      expect((await todayAt(ms, 'Europe/Dublin')).today).toBe(legacy)
      expect((await todayAt(ms, null)).today).toBe(legacy)
    }
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-06-30T23:30:00Z') })
    h.user = { ...h.user, activeLocation: { id: 'loc-1', timezone: 'America/New_York' } }
    getSettings.mockResolvedValue(null)
    expect((await (await GET(req(), {})).json()).data.today).toBe('2026-06-30')
    vi.useRealTimers()
  })
})
