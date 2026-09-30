// src/app/api/cron/agent-followups/route.test.js
// CHECKINSTALL.1 — the route folds each check-in tick into
// last_outcome.checkins_day, reading the row it is about to overwrite.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/agent/followups', () => ({ runAgentFollowups: vi.fn(), runFirstClassCheckins: vi.fn() }))
vi.mock('@/lib/agent/handoff-sla', () => ({
  runHandoffSlaSweep: vi.fn(async () => ({})), runHandoffAutoResolve: vi.fn(async () => ({})),
}))
vi.mock('@/lib/agent/approvals-sla', () => ({ runApprovalsSlaSweep: vi.fn(async () => ({})) }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAgentFollowups, runFirstClassCheckins } from '@/lib/agent/followups'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer s' : null) } })
function hbDb(result) {
  const b = { select: () => b, eq: () => b, maybeSingle: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }
  return { from: vi.fn(() => b) }
}
const outcome = () => stampHeartbeat.mock.calls[0][1]

beforeEach(() => {
  process.env.CRON_SECRET = 's'
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 9, 0))) // 10:00 Dublin
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runAgentFollowups.mockResolvedValue({ nudges: 0, templates: 0, skipped: 0 })
  runFirstClassCheckins.mockResolvedValue({ candidates: 2, freeform: 0, templates: 1, skipped: 1, reasons: { human_active: 1 } })
})
afterEach(() => { vi.useRealTimers(); console.error.mockRestore?.() })

describe('GET /api/cron/agent-followups — checkins_day', () => {
  it('adds this tick to the same Dublin day it read back', async () => {
    createServerClient.mockReturnValue(hbDb({ data: { last_outcome: { checkins_day: {
      day: '2026-09-30', ticks: 1, daytime_ticks: 1, failed_ticks: 0, candidates: 2, freeform: 0, templates: 0, skipped: 2,
      reasons: { human_active: 1, too_soon: 1 }, previous: null,
    } } }, error: null }))
    await GET(req())
    expect(outcome().checkins).toMatchObject({ templates: 1 }) // the per-tick tally is still there
    expect(outcome().checkins_day).toMatchObject({ day: '2026-09-30', ticks: 2, candidates: 4, templates: 1, skipped: 3 })
    expect(outcome().checkins_day.reasons).toEqual({ human_active: 2, too_soon: 1 })
  })

  it('the stamp keeps every other arm alongside checkins_day', async () => {
    createServerClient.mockReturnValue(hbDb({ data: null, error: null }))
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('agent-followups', expect.any(Object))
    expect(Object.keys(outcome()).sort()).toEqual(['approvalsSla', 'autoResolve', 'checkins', 'checkins_day', 'followups', 'handoffSla'])
    expect(outcome().followups).toEqual({ nudges: 0, templates: 0, skipped: 0 })
    expect(outcome().handoffSla).toEqual({})
    expect(outcome().autoResolve).toEqual({})
    expect(outcome().approvalsSla).toEqual({})
  })

  it('a failed heartbeat read restarts the day flagged carry_failed (never a silent zero)', async () => {
    createServerClient.mockReturnValue(hbDb({ data: null, error: { message: 'timeout' } }))
    await GET(req())
    expect(outcome().checkins_day).toMatchObject({ day: '2026-09-30', ticks: 1, carry_failed: true })
  })

  it('a thrown heartbeat read is the same flagged restart', async () => {
    createServerClient.mockReturnValue(hbDb(new TypeError('fetch failed')))
    await GET(req())
    expect(outcome().checkins_day.carry_failed).toBe(true)
  })

  it('a check-in runner that threw is counted as a failed tick', async () => {
    runFirstClassCheckins.mockRejectedValue(new Error('boom'))
    createServerClient.mockReturnValue(hbDb({ data: null, error: null }))
    await GET(req())
    expect(outcome().checkins).toBeNull()
    expect(outcome().checkins_day).toMatchObject({ ticks: 1, failed_ticks: 1 })
  })
})
