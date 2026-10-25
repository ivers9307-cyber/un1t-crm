// TZ.6 — run-challenge-events runs hourly and acts for each challenge's studio
// at its daily slot (08:00 UTC for Europe/Dublin, as before; 08:00 local
// elsewhere), with "today" read in that studio's calendar.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let challengeRows = []
const claims = new Map()
const DUBLIN = { id: 'loc-dub', timezone: 'Europe/Dublin' }
const NYC = { id: 'loc-ny', timezone: 'America/New_York' }

vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ shortName: 'UN1T' })) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(async () => ({ sent: 1, invalidated: 0, failed: 0, skipped: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/challenges-io', () => ({ computeStandings: vi.fn(async () => []), computeCollective: vi.fn(async () => ({ total: 0, target: 10, pct: 0 })) }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  function builder(table) {
    const st = { eqs: {}, is: {} }
    const b = {}
    for (const m of ['or', 'order', 'range', 'select']) b[m] = () => b
    b.eq = (c, v) => { st.eqs[c] = v; return b }
    b.is = (c, v) => { st.is[c] = v; return b }
    b.update = (patch) => { st.patch = patch; return b }
    b.then = (res, rej) => {
      let out
      if (st.patch) {
        const [column, value] = Object.entries(st.patch)[0]
        const row = challengeRows.find((r) => r.id === st.eqs.id)
        const won = row && row[column] == null
        if (won) row[column] = value
        out = { data: won ? [{ id: row.id }] : [], error: null }
      } else if (table === 'challenges') out = { data: challengeRows.map((r) => ({ ...r })), error: null }
      else if (table === 'champ_push_tokens') out = { data: [{ contact_id: 'c-1' }], error: null }
      else out = { data: [], error: null }
      return Promise.resolve(out).then(res, rej)
    }
    return b
  }
  return { createServerClient: () => withSlotTables({ from: builder }, { locations: [DUBLIN, NYC], claims }) }
})

const { GET } = await import('./route')
const { sendCustomerPush } = await import('@/lib/customer-push')
const req = () => new Request('https://x.test/api/cron/run-challenge-events', { headers: { authorization: 'Bearer shh' } })
const START = (id, location_id, starts_on) => ({ id, location_id, name: 'C', mode: 'individual', metric: 'points', starts_on, ends_on: '2026-12-31', target: null, announced_start_at: null, announced_end_at: null, announced_target_at: null })
const at = async (iso) => { vi.setSystemTime(Date.parse(iso)); return (await GET(req())).json() }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'shh'
  claims.clear()
})

describe('TZ.6 run-challenge-events', () => {
  it('Europe/Dublin announces a START at 08:00 UTC (09:00 IST), not at 07:00 UTC (08:00 IST)', async () => {
    challengeRows = [START('ch-d', DUBLIN.id, '2026-07-01')]
    expect(await at('2026-07-01T07:00:00Z')).toMatchObject({ started: 0 })
    expect(await at('2026-07-01T08:00:00Z')).toMatchObject({ started: 1 })
    expect(sendCustomerPush).toHaveBeenCalledTimes(1)
  })

  it('America/New_York announces at 08:00 local, not at the Dublin UTC hour', async () => {
    // 08:00 EST on 1 Dec is 13:00Z; at 08:00Z it is 03:00 in New York.
    challengeRows = [START('ch-n', NYC.id, '2026-12-01')]
    expect(await at('2026-12-01T08:00:00Z')).toMatchObject({ started: 0 }) // 03:00 EST
    expect(await at('2026-12-01T13:00:00Z')).toMatchObject({ started: 1 })
  })

  it('the claim holds: a second tick the same local day does not act again', async () => {
    challengeRows = [START('ch-d', DUBLIN.id, '2026-07-01')]
    await at('2026-07-01T08:00:00Z')
    challengeRows = [START('ch-d2', DUBLIN.id, '2026-07-01')] // appears after the slot
    expect(await at('2026-07-01T08:00:40Z')).toMatchObject({ started: 0, slot: { already: 2 } }) // a re-run in the hour
    expect(await at('2026-07-01T09:00:00Z')).toMatchObject({ started: 0, slot: { due: 0 } }) // Dublin: no later tick
  })
})
