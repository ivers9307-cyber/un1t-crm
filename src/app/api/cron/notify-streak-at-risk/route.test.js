// C31 PUSHNITS.1 — the streak-at-risk cron read each candidate's last 10 days
// of sessions and DISCARDED the error: a failed chunk left those members with
// no history, so their streak computed as 0 and the nudge was skipped in
// silence, and the run stamped its heartbeat as a clean one. A failed read is
// never an empty answer: the chunk is retried once, then its members are
// skipped (not judged on a partial history), counted, logged with logError,
// and the heartbeat is withheld. The same holds for the candidate read.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/customer-nudge-claim', () => ({
  readReachableContacts: vi.fn(async (_db, ids) => ({ reachable: new Set(ids), failed: 0 })),
  sendNudgeOnce: vi.fn(async () => ({ status: 'sent' })),
  nudgeFailed: (s) => s === 'claim_failed' || s === 'released' || s === 'release_failed',
}))

import { GET } from './route'
import { withSlotTables } from '@/lib/cron-daily-slot.test-helpers'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { sendNudgeOnce } from '@/lib/customer-nudge-claim'

const NOW = Date.parse('2026-09-16T11:00:00Z') // a Wednesday, well clear of DST
const DAY = 24 * 3600 * 1000
const at = (daysAgo) => new Date(NOW - daysAgo * DAY - 3 * 3600 * 1000).toISOString() // 08:00 UTC that day
const DOWN = { code: 'XX000', message: 'down' }

// Candidates: the `select('contact_id')` read. History: `select('contact_id, started_at')`.
// TZ.6: the daily-slot gate's tables (one Europe/Dublin studio) and the
// members' home locations ride along.
const DUBLIN = { id: 'loc-dub', timezone: 'Europe/Dublin' }
function fakeDb({ candidates, history, candidateError = null, historyErrors = [], home = DUBLIN.id, locations = [DUBLIN], claims, claimError }) {
  let historyCalls = 0
  const windows = []
  fakeDb.windows = windows
  return withSlotTables({
    from(table) {
      if (table === 'contacts') {
        const b = { select: () => b, in: (_c, ids) => { b.ids = ids; return b }, then: (res, rej) => Promise.resolve({ data: b.ids.map((id) => ({ id, location_id: home })), error: null }).then(res, rej) }
        return b
      }
      if (table !== 'heart_rate_sessions') throw new Error(`unexpected ${table}`)
      const q = { cols: null }
      const b = {
        select: (cols) => { q.cols = cols; return b },
        not: () => b, gte: (_c, v) => { q.gte = v; return b }, lt: (_c, v) => { q.lt = v; return b }, order: () => b, in: () => b,
        range: () => b,
        then(res, rej) {
          let out
          if (q.cols === 'contact_id') {
            windows.push([q.gte, q.lt])
            out = candidateError ? { data: null, error: candidateError } : { data: candidates.map((c) => ({ contact_id: c })), error: null }
          } else {
            const err = historyErrors[historyCalls++]
            out = err ? { data: null, error: err } : { data: history, error: null }
          }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }, { locations, claims, ...(claimError ? { claimError } : {}) })
}

// c-1 trained the last three days (streak 3, ending yesterday) → at risk.
const HISTORY = [at(1), at(2), at(3)].map((started_at) => ({ contact_id: 'c-1', started_at }))
const req = () => new Request('https://x.test/api/cron/notify-streak-at-risk', { headers: { authorization: 'Bearer shh' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})

describe('notify-streak-at-risk — a failed read is never an empty answer', () => {
  it('pin: a clean run nudges the at-risk member and stamps', async () => {
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY }))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, at_risk: 1, nudged: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('notify-streak-at-risk')
  })

  it('a history read that fails once is retried and the member is still nudged', async () => {
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, historyErrors: [DOWN] }))
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, nudged: 1, history_unread: 0 })
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a history read that keeps failing skips those members (counted, logged) and withholds the heartbeat', async () => {
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, historyErrors: [DOWN, DOWN] }))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toMatchObject({ ok: false, nudged: 0, history_unread: 1 })
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron-streak-risk', expect.stringMatching(/history read failed/), expect.objectContaining({ contacts: 1 }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed candidate read is not "nobody trained yesterday": logged, 500, no stamp', async () => {
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, candidateError: DOWN }))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toMatchObject({ ok: false, candidates_unread: 1 })
    expect(logError).toHaveBeenCalledWith('cron-streak-risk', expect.stringMatching(/candidate read failed/), expect.any(Object))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('TZ.6 notify-streak-at-risk acts per home studio at its daily slot', () => {
  it('a Dublin studio acts at 11:00 UTC only: 10:00 UTC reads nothing and, a quiet tick, never stamps', async () => {
    vi.setSystemTime(Date.parse('2026-09-16T10:00:00Z'))
    const db = fakeDb({ candidates: ['c-1'], history: HISTORY })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, candidates: 0, nudged: 0, slot: { due: 0 } })
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('the 11:00 UTC tick acts once; a re-run in the hour finds it claimed and the 12:00 tick finds nothing due', async () => {
    const claims = new Map()
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, claims }))
    expect(await (await GET(req())).json()).toMatchObject({ nudged: 1 })
    vi.setSystemTime(NOW + 60_000)
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, claims }))
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, nudged: 0, slot: { due: 2, already: 2 } })
    vi.setSystemTime(NOW + 3600_000)
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, claims }))
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, nudged: 0, slot: { due: 0 } })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(sendNudgeOnce).toHaveBeenCalledTimes(1)
    expect(sendNudgeOnce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dedupKey: '2026-09-16' }))
  })

  // TZ.17 ⚠️ — a Dublin studio's "yesterday" is its own local day now (it was
  // the UTC day, kept by TZ.6): in Irish summer time it runs 23:00Z → 23:00Z.
  // In winter (GMT) it is the exact window it always read.
  it('a Dublin studio reads its own local yesterday (TZ.17); New York reads its own local day', async () => {
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY }))
    await GET(req())
    expect(fakeDb.windows).toEqual([['2026-09-14T23:00:00.000Z', '2026-09-15T23:00:00.000Z']])
    vi.setSystemTime(Date.parse('2026-01-14T11:00:00Z'))
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY }))
    await GET(req())
    expect(fakeDb.windows).toEqual([['2026-01-13T00:00:00.000Z', '2026-01-14T00:00:00.000Z']])
    vi.setSystemTime(NOW)
    vi.setSystemTime(Date.parse('2026-09-16T15:00:00Z'))
    const NYC = { id: 'loc-ny', timezone: 'America/New_York' }
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, home: NYC.id, locations: [NYC] }))
    await GET(req())
    expect(fakeDb.windows).toEqual([['2026-09-15T04:00:00.000Z', '2026-09-16T04:00:00.000Z']])
  })

  it('a New York member is not nudged at 11:00 UTC (07:00 EDT) but is at 11:00 EDT, keyed on the New York day', async () => {
    const NYC = { id: 'loc-ny', timezone: 'America/New_York' }
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, home: NYC.id, locations: [DUBLIN, NYC] }))
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, nudged: 0 })
    vi.setSystemTime(Date.parse('2026-09-16T15:00:00Z'))
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, home: NYC.id, locations: [DUBLIN, NYC] }))
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, nudged: 1 })
    expect(sendNudgeOnce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c-1', dedupKey: '2026-09-16' }))
  })

  it('TZ.17: a member whose only session yesterday was at 00:30 IST is now a candidate (the UTC window missed them)', async () => {
    // Trained Sun 13, Mon 14 and at 00:30 IST on Tue 15 Sep (23:30Z on the 14th).
    const hist = ['2026-09-13T08:00:00Z', '2026-09-14T08:00:00Z', '2026-09-14T23:30:00Z'].map((started_at) => ({ contact_id: 'c-1', started_at }))
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: hist }))
    const body = await (await GET(req())).json()
    expect(fakeDb.windows[0][0] <= '2026-09-14T23:30:00.000Z' && '2026-09-14T23:30:00.000Z' < fakeDb.windows[0][1]).toBe(true)
    expect(body).toMatchObject({ ok: true, at_risk: 1, nudged: 1 })
    expect(sendNudgeOnce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dedupKey: '2026-09-16' }))
  })

  it('TZ.17 exactly once on the deploy day: the key is the date the cron always used, and the day is claimed once', async () => {
    // Every day of 2026 at the Dublin slot (11:00 UTC) the key is the UTC date
    // the pre-TZ.17 cron used, so a nudge the old code sent today and one the
    // new code would send today share one ledger key (sendNudgeOnce is
    // idempotent on it), and the slot claim stops a second run that day.
    const claims = new Map()
    for (let t = Date.parse('2026-01-01T11:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 7 * DAY) {
      vi.setSystemTime(t)
      vi.mocked(sendNudgeOnce).mockClear()
      createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: [1, 2, 3].map((d) => ({ contact_id: 'c-1', started_at: new Date(t - d * DAY - 3 * 3600_000).toISOString() })), claims }))
      await GET(req())
      expect(sendNudgeOnce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dedupKey: new Date(t).toISOString().slice(0, 10) }))
      createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: [], claims }))
      expect(await (await GET(req())).json()).toMatchObject({ nudged: 0, slot: { claimed: 0 } })
      expect(sendNudgeOnce).toHaveBeenCalledTimes(1)
    }
  })

  it('the streak is judged on the member\'s home studio zone (New York member at the New York slot)', async () => {
    // 23:30 EDT on Mon 14 and Tue 15 Sep, and Sun 13: a 3-day New York streak ending yesterday.
    vi.setSystemTime(Date.parse('2026-09-16T15:00:00Z')) // 11:00 EDT
    const NYC = { id: 'loc-ny', timezone: 'America/New_York' }
    const hist = ['2026-09-13T16:00:00Z', '2026-09-15T03:30:00Z', '2026-09-16T03:30:00Z'].map((started_at) => ({ contact_id: 'c-1', started_at }))
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: hist, home: NYC.id, locations: [NYC] }))
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, at_risk: 1, nudged: 1 })
  })

  it('a claim-write error at the slot tick acts for nobody: 500, no stamp, no send', async () => {
    createServerClient.mockReturnValue(fakeDb({ candidates: ['c-1'], history: HISTORY, claimError: () => DOWN }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable zone acts for nobody: 500, no stamp, no send', async () => {
    const db = fakeDb({ candidates: ['c-1'], history: HISTORY })
    const real = db.from
    createServerClient.mockReturnValue({ ...db, from: (t) => (t === 'locations' ? { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: DOWN }) }) }) } : real(t)) })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
