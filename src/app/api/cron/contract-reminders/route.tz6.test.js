// TZ.6 — contract-reminders runs hourly. A contract's location acts at its
// daily slot (08:00 UTC for Europe/Dublin, as before; 08:00 local elsewhere),
// once per local day. TZ follow-up: the runway and qualification arms have
// daily slots of their own, on the same rule ("08:00 local, Dublin unchanged").
import { describe, it, expect, vi, beforeEach } from 'vitest'

let contractRows = []
const claims = new Map()
const h = vi.hoisted(() => ({ claimError: null }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/contracts', () => ({ reminderDue: vi.fn(() => true) }))
vi.mock('@/lib/contracts-email', () => ({ sendContractReminderEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
// Each arm reports which studios its isDue says are at their slot this tick.
const dueOf = (opts) => ['loc-dub', 'loc-ny'].filter((id) => opts?.isDue?.(id))
vi.mock('@/lib/roster-runway-notify', () => ({ runRosterRunwayAlerts: vi.fn(async (_db, opts) => ({ locations: dueOf(opts).length, due: dueOf(opts) })) }))
vi.mock('@/lib/qualification-digest', () => ({ runQualificationDigest: vi.fn(async (_db, opts) => ({ organizations: dueOf(opts).length, due: dueOf(opts) })) }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  function builder() {
    const st = {}
    const b = {}
    for (const m of ['in', 'lt', 'order', 'range', 'eq', 'select']) b[m] = () => b
    b.update = (patch) => { st.patch = patch; return b }
    b.then = (res, rej) => Promise.resolve(st.patch ? { data: null, error: null } : { data: contractRows, error: null }).then(res, rej)
    return b
  }
  const locations = [{ id: 'loc-dub', timezone: 'Europe/Dublin' }, { id: 'loc-ny', timezone: 'America/New_York' }]
  return { createServerClient: () => withSlotTables({ from: builder }, { locations, claims, claimError: () => h.claimError }) }
})

const { GET } = await import('./route.js')
const { sendContractReminderEmail } = await import('@/lib/contracts-email')
const { runRosterRunwayAlerts } = await import('@/lib/roster-runway-notify')
const { runQualificationDigest } = await import('@/lib/qualification-digest')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const K = (id, location_id) => ({ id, status: 'issued', issued_at: '2026-06-20T09:00:00Z', reminder_count: 0, location_id, profile: { id: 'p1', full_name: 'Test Coach', email: 'coach@example.test' }, template: { name: 'Agreement' } })
const at = async (iso) => { vi.setSystemTime(Date.parse(iso)); return (await GET(req())).json() }
const reminded = () => sendContractReminderEmail.mock.calls.map(([a]) => a.contract.id)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'test-secret'
  claims.clear()
  h.claimError = null
  contractRows = [K('k-dub', 'loc-dub'), K('k-ny', 'loc-ny')]
})

describe('TZ.6 contract-reminders', () => {
  it('Europe/Dublin reminds at 08:00 UTC, not at 07:00 UTC (08:00 IST); only the slot tick stamps', async () => {
    await at('2026-07-01T07:00:00Z')
    expect(reminded()).toEqual([])
    await at('2026-07-01T08:00:00Z')
    expect(reminded()).toEqual(['k-dub'])
    expect(stampHeartbeat.mock.calls.filter(([n]) => n === 'contract-reminders')).toHaveLength(1)
  })

  it('a claim-write error at the slot tick reminds nobody, does not stamp contract-reminders, answers 500', async () => {
    h.claimError = { code: 'XX000', message: 'down' }
    vi.setSystemTime(Date.parse('2026-07-01T08:00:00Z'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(reminded()).toEqual([])
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).not.toContain('contract-reminders')
  })

  it('America/New_York reminds at 08:00 local (12:00Z in summer), once that day', async () => {
    await at('2026-07-01T12:00:00Z')
    await at('2026-07-01T13:00:00Z')
    expect(reminded()).toEqual(['k-ny'])
  })

})

// TZ follow-up — each arm acts for a studio at THAT studio's daily slot, on its
// own claim: 08:00 UTC for Europe/Dublin (the legacy instant, never +1h/+2h),
// 08:00 local elsewhere. Its heartbeat row stamps only on a tick that took one
// of its slots with no fault.
const ARMS = [
  ['roster-runway', () => runRosterRunwayAlerts],
  ['qualification-digest', () => runQualificationDigest],
]
const armDue = (fn) => fn().mock.calls.map(([, opts]) => ['loc-dub', 'loc-ny'].filter((id) => opts.isDue(id)))
const stamps = (name) => stampHeartbeat.mock.calls.filter(([n]) => n === name)
const HOUR = 3600_000

describe.each(ARMS)('TZ follow-up: the %s arm on its own daily slot', (name, fn) => {
  it('Europe/Dublin acts at 08:00 UTC only, summer and winter: not at 07:00 UTC (08:00 IST), not at +1h or +2h', async () => {
    for (const day of ['2026-03-28', '2026-03-29', '2026-07-01', '2026-10-24', '2026-10-25', '2026-12-01']) {
      vi.clearAllMocks()
      for (const h of ['07', '08', '09', '10']) await at(`${day}T${h}:00:00Z`)
      const dublinTicks = fn().mock.calls
        .map(([, opts]) => opts)
        .filter((opts) => opts.isDue('loc-dub'))
        .map((opts) => new Date(opts.nowMs).toISOString())
      expect(dublinTicks, day).toEqual([`${day}T08:00:00.000Z`])
      expect(stamps(name), day).toHaveLength(1)
    }
  })

  it('America/New_York acts at 08:00 local across both 2026 US DST changes, once a day, and never for Dublin on that tick', async () => {
    const days = ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']
    const nyTicks = []
    for (const day of days) {
      const base = Date.parse(`${day}T00:00:00Z`)
      for (let ms = base; ms < base + 24 * HOUR; ms += HOUR) {
        vi.clearAllMocks()
        vi.setSystemTime(ms)
        await GET(req())
        for (const [, opts] of fn().mock.calls) {
          if (opts.isDue('loc-ny')) {
            nyTicks.push(new Date(ms).toISOString())
            expect(opts.isDue('loc-dub')).toBe(false)
          }
        }
      }
    }
    expect(nyTicks).toEqual([
      '2026-03-07T13:00:00.000Z', // 08:00 EST
      '2026-03-08T12:00:00.000Z', // 08:00 EDT (spring forward that morning)
      '2026-03-09T12:00:00.000Z',
      '2026-10-31T12:00:00.000Z', // 08:00 EDT
      '2026-11-01T13:00:00.000Z', // 08:00 EST (fall back that morning)
      '2026-11-02T13:00:00.000Z',
    ])
  })

  it('a quiet hourly tick does not run the arm and does not stamp its row', async () => {
    await at('2026-07-01T03:00:00Z')
    expect(fn()).not.toHaveBeenCalled()
    expect(stamps(name)).toHaveLength(0)
  })

  it('a duplicate invocation in the same hour does not act twice or stamp twice', async () => {
    await at('2026-07-01T08:00:00Z')
    await at('2026-07-01T08:05:00Z')
    expect(armDue(fn)).toEqual([['loc-dub']])
    expect(stamps(name)).toHaveLength(1)
  })

  it('a claim fault acts for nobody, does not stamp the arm row, answers 500; Dublin is not retried at +1h', async () => {
    h.claimError = { code: 'XX000', message: 'down' }
    vi.setSystemTime(Date.parse('2026-07-01T08:00:00Z'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(fn()).not.toHaveBeenCalled()
    expect(stamps(name)).toHaveLength(0)
    h.claimError = null
    await at('2026-07-01T09:00:00Z')
    expect(fn()).not.toHaveBeenCalled()
    expect(stamps(name)).toHaveLength(0)
  })
})

describe('TZ follow-up: the arms claim independently of the contract half and of each other', () => {
  it('each holds its own claim row per studio per local day', async () => {
    await at('2026-07-01T08:00:00Z')
    await at('2026-07-01T12:00:00Z')
    const keys = [...claims.keys()].filter((k) => !k.includes('|none|')).sort()
    expect(keys).toEqual([
      'contract-reminders|loc-dub|2026-07-01', 'contract-reminders|loc-ny|2026-07-01',
      'qualification-digest|loc-dub|2026-07-01', 'qualification-digest|loc-ny|2026-07-01',
      'roster-runway|loc-dub|2026-07-01', 'roster-runway|loc-ny|2026-07-01',
    ])
    expect(reminded()).toEqual(['k-dub', 'k-ny'])
  })

  it('a throwing arm costs the other arm and the contract half nothing, and its own row is not stamped', async () => {
    runRosterRunwayAlerts.mockRejectedValueOnce(new Error('runway down'))
    const body = await at('2026-07-01T08:00:00Z')
    expect(body).toMatchObject({ success: true, runway_arm_failed: 1, qualification_arm_failed: 0, runway: { error: 'runway down' } })
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['qualification-digest', 'contract-reminders'])
    expect(reminded()).toEqual(['k-dub'])
  })
})
