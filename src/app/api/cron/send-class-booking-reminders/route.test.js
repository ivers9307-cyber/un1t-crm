// TZ.6 — the class reminder's time label reads the location's zone through
// zoneOfLocation: Europe/Dublin as before (and for a NULL or invalid value),
// New York in New York.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let locations = []
const STARTS = '2026-07-01T23:30:00Z' // 00:30 IST on 2 Jul; 19:30 EDT on 1 Jul
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/customer-nudge-claim', () => ({
  readReachableContacts: vi.fn(async (_db, ids) => ({ reachable: new Set(ids), failed: 0 })),
  sendNudgeOnce: vi.fn(async () => ({ status: 'sent' })),
  nudgeFailed: () => false,
}))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const b = {}
      const eq = {}
      for (const m of ['select', 'not', 'gte', 'lte', 'order', 'range', 'in']) b[m] = () => b
      b.eq = (col, val) => { eq[col] = val; return b }
      // UN1TBOOK.2 — the un1t_online locations read (eq membership_source)
      // answers no studio: these test locations carry no membership_source.
      b.then = (res, rej) => Promise.resolve(table === 'locations'
        ? { data: eq.membership_source ? [] : locations, error: null }
        : { data: [{ id: 'cb-1', contact_id: 'c-1', location_id: 'loc-1', class_name: 'HIIT', starts_at: STARTS }], error: null }).then(res, rej)
      return b
    },
  }),
}))

const { GET } = await import('./route')
const { sendNudgeOnce } = await import('@/lib/customer-nudge-claim')
const req = () => new Request('https://x.test/api/cron/send-class-booking-reminders', { headers: { authorization: 'Bearer shh' } })
const labelFor = async (timezone) => {
  locations = [{ id: 'loc-1', timezone, notification_config: null }]
  sendNudgeOnce.mockClear()
  await GET(req())
  return sendNudgeOnce.mock.calls[0]?.[1]?.payload
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(STARTS) - 30 * 60_000) // the default 30 min lead
  process.env.CRON_SECRET = 'shh'
})

describe('TZ.6 send-class-booking-reminders time label', () => {
  it('Europe/Dublin, a NULL zone and an invalid zone all label in Dublin time', async () => {
    const dublin = JSON.stringify(await labelFor('Europe/Dublin'))
    expect(dublin).toContain('12:30am')
    expect(JSON.stringify(await labelFor(null))).toBe(dublin)
    expect(JSON.stringify(await labelFor('Mars/Olympus'))).toBe(dublin)
  })

  it('America/New_York labels in New York time', async () => {
    expect(JSON.stringify(await labelFor('America/New_York'))).toContain('7:30pm')
  })
})
