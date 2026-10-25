// TZ.10 — "run now" applies the window that is active by the SCHEDULE's
// studio clock (the active location's zone), the same clock the reconcile cron
// plans in; GET /api/sonos/schedules hands the page that zone with the rows.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getCurrentUser = vi.fn()
vi.mock('@/lib/auth', () => ({ getCurrentUser: (...a) => getCurrentUser(...a) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const SCHEDULE_ID = 'b0000000-0000-0000-0000-000000000001'
const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const schedule = {
  id: SCHEDULE_ID, location_id: LOC, enabled: true, player_ids: ['RINCON_1'], override: null, last_applied: null,
  windows: [{ days: [1, 2, 3, 4, 5, 6, 7], on: '06:00', off: '22:00', volume: 30, favorite_id: 'fv' }],
}
const db = {
  from: () => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain,
      limit: async () => ({ data: [schedule], error: null }),
      maybeSingle: async () => ({ data: schedule, error: null }),
    }
    return chain
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

const withFreshToken = vi.fn(async () => ({ ok: true, token: 'tok', householdId: 'HH' }))
const sonosGetGroups = vi.fn(async () => ({ ok: true, body: { groups: [{ id: 'G', playerIds: ['RINCON_1'] }], players: [] } }))
vi.mock('@/lib/sonos/client', () => ({
  getSonosConfig: () => ({ clientId: 'a' }),
  withFreshToken: (...a) => withFreshToken(...a),
  sonosGetGroups: (...a) => sonosGetGroups(...a),
}))
const applyOpen = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/sonos/apply', () => ({ applyOpen: (...a) => applyOpen(...a) }))

const { POST } = await import('./route.js')
const { GET } = await import('../../route.js')

const userIn = (timezone) => ({ id: 'u1', activeLocation: { id: LOC, name: 'Studio', timezone } })
const run = () => POST(new Request('http://x'), { params: Promise.resolve({ id: SCHEDULE_ID }) })

describe('TZ.10 Sonos run-now follows the studio clock', () => {
  beforeEach(() => { vi.useFakeTimers(); withFreshToken.mockClear(); sonosGetGroups.mockClear(); applyOpen.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it('07:30Z Sun 8 Mar is 03:30 in New York: no window, and no Sonos call', async () => {
    vi.setSystemTime(new Date('2026-03-08T07:30:00Z'))
    getCurrentUser.mockResolvedValue(userIn('America/New_York'))
    const res = await run()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'No window is active right now' })
    expect(withFreshToken).not.toHaveBeenCalled()
    expect(applyOpen).not.toHaveBeenCalled()
  })

  it('the same instant is 07:30 in Dublin: the window opens, as it always did', async () => {
    vi.setSystemTime(new Date('2026-03-08T07:30:00Z'))
    getCurrentUser.mockResolvedValue(userIn('Europe/Dublin'))
    const res = await run()
    expect(res.status).toBe(200)
    expect(applyOpen.mock.calls[0][1].plan).toMatchObject({ action: 'open', windowOnAt: Date.parse('2026-03-08T06:00:00Z') })
  })

  it('10:30Z is 06:30 EDT, the first morning of DST: New York\'s window opened at 10:00Z', async () => {
    vi.setSystemTime(new Date('2026-03-08T10:30:00Z'))
    getCurrentUser.mockResolvedValue(userIn('America/New_York'))
    const res = await run()
    expect(res.status).toBe(200)
    expect(applyOpen.mock.calls[0][1].plan).toMatchObject({ action: 'open', windowOnAt: Date.parse('2026-03-08T10:00:00Z') })
  })
})

describe('TZ.10 GET /api/sonos/schedules returns the zone with the schedules', () => {
  it('the active location\'s canonical zone', async () => {
    getCurrentUser.mockResolvedValue(userIn('America/New_York'))
    expect(await (await GET()).json()).toMatchObject({ success: true, schedules: [schedule], timezone: 'America/New_York' })
  })
  it('a NULL column is the platform zone', async () => {
    getCurrentUser.mockResolvedValue(userIn(null))
    expect(await (await GET()).json()).toMatchObject({ timezone: 'Europe/Dublin' })
  })
})
