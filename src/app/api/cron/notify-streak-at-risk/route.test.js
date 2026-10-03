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
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { sendNudgeOnce } from '@/lib/customer-nudge-claim'

const NOW = Date.parse('2026-09-16T11:00:00Z') // a Wednesday, well clear of DST
const DAY = 24 * 3600 * 1000
const at = (daysAgo) => new Date(NOW - daysAgo * DAY - 3 * 3600 * 1000).toISOString() // 08:00 UTC that day
const DOWN = { code: 'XX000', message: 'down' }

// Candidates: the `select('contact_id')` read. History: `select('contact_id, started_at')`.
function fakeDb({ candidates, history, candidateError = null, historyErrors = [] }) {
  let historyCalls = 0
  return {
    from(table) {
      if (table !== 'heart_rate_sessions') throw new Error(`unexpected ${table}`)
      const q = { cols: null }
      const b = {
        select: (cols) => { q.cols = cols; return b },
        not: () => b, gte: () => b, lt: () => b, order: () => b, in: () => b,
        range: () => b,
        then(res, rej) {
          let out
          if (q.cols === 'contact_id') {
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
  }
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
