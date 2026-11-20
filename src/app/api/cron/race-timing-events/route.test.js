// TZ.6 — a wave's race_date + start_time is wall clock in the RACE's location
// zone (Europe/Dublin for every UN1T studio, as before), so the 1 h milestone
// lands an hour before the local start in New York too.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let regs = []
let regsError = null
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/contact-events', () => ({
  emitEvent: vi.fn(async () => true),
  applyTagRules: vi.fn(async () => {}),
  EVENT_TYPES: { RACE_STARTS_IN_24H: 'race.starts_in_24h', RACE_STARTS_IN_1H: 'race.starts_in_1h', RACE_COMPLETED_24H_AGO: 'race.completed_24h_ago' },
}))
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: () => {
      const b = {}
      for (const m of ['select', 'eq', 'gte', 'lte']) b[m] = () => b
      b.then = (res, rej) => Promise.resolve(regsError ? { data: null, error: regsError } : { data: regs, error: null }).then(res, rej)
      return b
    },
  })),
}))

const { GET } = await import('./route')
const { emitEvent } = await import('@/lib/contact-events')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const req = () => new Request('https://x.test/api/cron/race-timing-events', { headers: { authorization: 'Bearer shh' } })
const REG = (timezone) => ({
  id: 'reg-1', contact_id: null, status: 'confirmed', race_event_id: 'race-1',
  race: { id: 'race-1', name: 'Relay', kind: 'race', location_id: timezone ? 'loc-1' : null, race_date: '2026-07-04', locations: timezone ? { id: 'loc-1', timezone } : null },
  wave: { id: 'w-1', start_time: '10:00:00' },
  teams: { id: 't', team_members: [{ id: 'm', name: 'Runner', email: 'runner@example.test', role: 'captain', contact_id: 'c-1' }] },
})
const oneHourEvents = () => emitEvent.mock.calls.filter(([a]) => a.eventType === 'race.starts_in_1h').length
const at = async (iso) => { vi.setSystemTime(Date.parse(iso)); await GET(req()) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'shh'
  regsError = null
})

describe('TZ.6 race-timing-events', () => {
  it('Europe/Dublin (and a race with no location): a 10:00 IST wave is 09:00Z, so the 1 h milestone fires at 08:00Z', async () => {
    for (const tz of ['Europe/Dublin', null]) {
      regs = [REG(tz)]
      emitEvent.mockClear()
      await at('2026-07-04T08:00:00Z')
      expect(oneHourEvents(), String(tz)).toBe(1)
    }
  })

  it('America/New_York: a 10:00 EDT wave is 14:00Z, so nothing at 08:00Z and the milestone at 13:00Z', async () => {
    regs = [REG('America/New_York')]
    await at('2026-07-04T08:00:00Z')
    expect(oneHourEvents()).toBe(0)
    await at('2026-07-04T13:00:00Z')
    expect(oneHourEvents()).toBe(1)
  })
})

describe('race-timing-events on defineCron (ROUTEWRAP.C8)', () => {
  const bare = (auth) => new Request('https://x.test/api/cron/race-timing-events', { headers: auth ? { authorization: auth } : {} })

  it('401 without the secret: nothing read, nothing emitted, nothing stamped', async () => {
    regs = [REG('Europe/Dublin')]
    vi.setSystemTime(Date.parse('2026-07-04T08:00:00Z'))
    for (const auth of [null, 'Bearer wrong']) expect((await GET(bare(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(bare('Bearer undefined'))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a completed loop stamps exactly race-timing-events with its counts and answers them', async () => {
    regs = [REG('Europe/Dublin')]
    vi.setSystemTime(Date.parse('2026-07-04T08:00:00Z'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const stats = { emitted: 1, skipped: 0, errors: 0 }
    expect(await res.json()).toEqual({ success: true, stats })
    expect(stampHeartbeat.mock.calls).toEqual([['race-timing-events', stats]])
  })

  it('an unreadable registrations list is a 500 with a fixed line (no DB text) and no stamp', async () => {
    regsError = { code: 'XX000', message: 'relation db.internal refused' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read registrations' })
    expect(logError).toHaveBeenCalledWith('race-timing-events', 'registrations read failed', { err: regsError })
    expect(emitEvent).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

