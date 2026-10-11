// TZ.6 — notify-winback runs hourly and acts for each member's home studio at
// its daily slot: 10:00 UTC for a Europe/Dublin studio (as before), 10:00 local
// elsewhere, at most once per studio per local day.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/customer-nudge-claim', () => ({
  readReachableContacts: vi.fn(async (_db, ids) => ({ reachable: new Set(ids), failed: 0 })),
  sendNudgeOnce: vi.fn(async () => ({ status: 'sent' })),
  nudgeFailed: (s) => s === 'claim_failed' || s === 'released' || s === 'release_failed',
}))
vi.mock('@/lib/customer-notifications', () => ({
  attendanceDrop: vi.fn(() => ({ dropping: true })),
  buildWinbackPush: vi.fn(() => ({ title: 't', body: 'b' })),
}))

import { GET } from './route'
import { withSlotTables } from '@/lib/cron-daily-slot.test-helpers'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { sendNudgeOnce } from '@/lib/customer-nudge-claim'

const DUBLIN = { id: 'loc-dub', timezone: 'Europe/Dublin' }
const NYC = { id: 'loc-ny', timezone: 'America/New_York' }
const HOMES = { 'c-dub': DUBLIN.id, 'c-ny': NYC.id }

function fakeDb({ claims } = {}) {
  const sessions = { from: 0 }
  return withSlotTables({
    from(table) {
      const b = { cols: null }
      Object.assign(b, {
        select: (cols) => { b.cols = cols; return b },
        not: () => b, gte: () => b, order: () => b, range: () => b,
        in: (_c, ids) => { b.ids = ids; return b },
        then(res, rej) {
          let data
          if (table === 'contacts') data = b.ids.map((id) => ({ id, location_id: HOMES[id] }))
          else if (table === 'heart_rate_sessions' && b.cols === 'contact_id') data = sessions.from++ ? [] : Object.keys(HOMES).map((contact_id) => ({ contact_id }))
          else if (table === 'heart_rate_sessions') data = []
          else throw new Error(`unexpected ${table}`)
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
      })
      return b
    },
  }, { locations: [DUBLIN, NYC], claims })
}

const req = () => new Request('https://x.test/api/cron/notify-winback', { headers: { authorization: 'Bearer shh' } })
const nudged = () => sendNudgeOnce.mock.calls.map(([, a]) => `${a.contactId}@${a.dedupKey}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  process.env.CRON_SECRET = 'shh'
})

describe('TZ.6 notify-winback', () => {
  it('Europe/Dublin acts at 10:00 UTC (11:00 IST), keyed on the month, and only its own members', async () => {
    vi.setSystemTime(Date.parse('2026-07-01T10:00:00Z'))
    createServerClient.mockReturnValue(fakeDb())
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, nudged: 1 })
    expect(nudged()).toEqual(['c-dub@2026-07'])
  })

  it('Europe/Dublin does not act at 10:00 IST (09:00 UTC): a quiet tick that still stamps', async () => {
    vi.setSystemTime(Date.parse('2026-07-01T09:00:00Z'))
    createServerClient.mockReturnValue(fakeDb())
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, nudged: 0 })
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('notify-winback')
  })

  it('America/New_York acts at 10:00 local in both seasons (14:00Z in July, 15:00Z in December)', async () => {
    vi.setSystemTime(Date.parse('2026-07-01T14:00:00Z'))
    createServerClient.mockReturnValue(fakeDb())
    await GET(req())
    vi.setSystemTime(Date.parse('2026-12-01T15:00:00Z'))
    createServerClient.mockReturnValue(fakeDb())
    await GET(req())
    vi.setSystemTime(Date.parse('2026-12-01T14:00:00Z')) // 09:00 EST
    createServerClient.mockReturnValue(fakeDb())
    await GET(req())
    expect(nudged()).toEqual(['c-ny@2026-07', 'c-ny@2026-12'])
  })

  it('the same local day never acts twice, even across the catch-up ticks', async () => {
    const claims = new Map()
    for (const iso of ['2026-07-01T10:00:00Z', '2026-07-01T10:00:30Z', '2026-07-01T11:00:00Z', '2026-07-01T12:00:00Z']) {
      vi.setSystemTime(Date.parse(iso))
      createServerClient.mockReturnValue(fakeDb({ claims }))
      await GET(req())
    }
    expect(nudged()).toEqual(['c-dub@2026-07'])
  })
})
