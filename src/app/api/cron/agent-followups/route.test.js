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
vi.mock('@/lib/agent/trial-done-runner', () => ({ runTrialDoneOutreach: vi.fn() }))
vi.mock('@/lib/agent/checkin-day-rollup', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, rollupCheckinDay: vi.fn(real.rollupCheckinDay) }
})

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAgentFollowups, runFirstClassCheckins } from '@/lib/agent/followups'
import { runTrialDoneOutreach } from '@/lib/agent/trial-done-runner'
import { runHandoffSlaSweep } from '@/lib/agent/handoff-sla'
import { rollupCheckinDay } from '@/lib/agent/checkin-day-rollup'

const req = (auth = 'Bearer s') => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })
function hbDb(result) {
  const b = { select: () => b, eq: () => b, maybeSingle: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }
  return { from: vi.fn(() => b) }
}
// The parent's own stamp (TRIALDONE.7: the trial-done arm stamps a row of its own too).
const outcome = () => stampHeartbeat.mock.calls.find(([name]) => name === 'agent-followups')[1]
const armStamps = () => stampHeartbeat.mock.calls.filter(([name]) => name === 'trial-done-outreach')

beforeEach(() => {
  process.env.CRON_SECRET = 's'
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 9, 0))) // 10:00 Dublin
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runAgentFollowups.mockResolvedValue({ nudges: 0, templates: 0, skipped: 0 })
  runFirstClassCheckins.mockResolvedValue({ candidates: 2, freeform: 0, templates: 1, skipped: 1, reasons: { human_active: 1 } })
  runTrialDoneOutreach.mockResolvedValue({ openers: 1, followups: 0, skipped: 2, reasons: { too_soon: 2 } })
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
    expect(Object.keys(outcome()).sort()).toEqual(['approvalsSla', 'autoResolve', 'checkins', 'checkins_day', 'followups', 'handoffSla', 'trial_done'])
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

  // TZ.18b — the rollup is ONE platform-wide row, keyed on the platform calendar
  // (PLATFORM_TZ = Europe/Dublin), byte-identical to the old dublinDayStr key.
  it.each([
    ['2026-07-01T23:30:00Z', '2026-07-02'], // 00:30 IST: the Dublin day, not the UTC day
    ['2026-01-15T23:30:00Z', '2026-01-15'], // 23:30 GMT
    ['2026-03-29T00:30:00Z', '2026-03-29'], // spring-forward night, 00:30 GMT
    ['2026-10-24T23:30:00Z', '2026-10-25'], // fall-back night, 00:30 IST
    ['2026-11-01T04:30:00Z', '2026-11-01'], // the US fall-back night is an ordinary Dublin morning
  ])('the checkins_day key at %s is the platform day %s', async (at, day) => {
    vi.setSystemTime(new Date(at))
    createServerClient.mockReturnValue(hbDb({ data: null, error: null }))
    await GET(req())
    expect(outcome().checkins_day.day).toBe(day)
  })

  it('a check-in runner that threw is counted as a failed tick', async () => {
    runFirstClassCheckins.mockRejectedValue(new Error('boom'))
    createServerClient.mockReturnValue(hbDb({ data: null, error: null }))
    await GET(req())
    expect(outcome().checkins).toBeNull()
    expect(outcome().checkins_day).toMatchObject({ ticks: 1, failed_ticks: 1 })
  })

  // TRIALDONE.4 — the trial-done opener rides the same tick, after the check-ins.
  it('runs the trial-done outreach after the check-ins and carries its counts on the heartbeat', async () => {
    const order = []
    runFirstClassCheckins.mockImplementation(async () => { order.push('checkins'); return { candidates: 0, freeform: 0, templates: 0, skipped: 0, reasons: {} } })
    runTrialDoneOutreach.mockImplementation(async () => { order.push('trial_done'); return { openers: 1, followups: 0, skipped: 2, reasons: { too_soon: 2 } } })
    const db = hbDb({ data: null, error: null })
    createServerClient.mockReturnValue(db)
    const res = await GET(req())
    expect(order).toEqual(['checkins', 'trial_done'])
    expect(runTrialDoneOutreach).toHaveBeenCalledWith(db)
    expect(outcome().trial_done).toEqual({ openers: 1, followups: 0, skipped: 2, reasons: { too_soon: 2 } })
    expect((await res.json()).trial_done).toEqual({ openers: 1, followups: 0, skipped: 2, reasons: { too_soon: 2 } })
  })

  it('a trial-done runner that threw does not stop the tick or the stamp', async () => {
    runTrialDoneOutreach.mockRejectedValue(new Error('boom'))
    createServerClient.mockReturnValue(hbDb({ data: null, error: null }))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(outcome().trial_done).toBeNull()
    expect(outcome().checkins).toMatchObject({ templates: 1 })
  })
})

// TRIALDONE.7 — the trial-done arm stamps its OWN row, 'trial-done-outreach'
// (mig 757), only on a clean outcome (cron-arm-health.js trialDoneArmHealthy).
describe('GET /api/cron/agent-followups — the trial-done arm heartbeat', () => {
  beforeEach(() => { createServerClient.mockReturnValue(hbDb({ data: null, error: null })) })
  afterEach(() => {
    stampHeartbeat.mockImplementation(() => Promise.resolve())
    runHandoffSlaSweep.mockImplementation(async () => ({}))
  })

  it('a clean run stamps the arm row with its outcome, and the parent row too', async () => {
    await GET(req())
    expect(armStamps()).toEqual([['trial-done-outreach', { openers: 1, followups: 0, skipped: 2, reasons: { too_soon: 2 } }]])
    expect(stampHeartbeat).toHaveBeenCalledWith('agent-followups', expect.any(Object))
  })

  it('an idle run (every studio off) stamps: nothing to send is healthy', async () => {
    runTrialDoneOutreach.mockResolvedValue({ openers: 0, followups: 0, skipped: 0, reasons: {} })
    await GET(req())
    expect(armStamps()).toHaveLength(1)
  })

  it('a run with a fault of its own does not stamp the arm row (the parent still stamps)', async () => {
    runTrialDoneOutreach.mockResolvedValue({ openers: 0, followups: 0, skipped: 1, reasons: { deals_read_failed: 1 } })
    await GET(req())
    expect(armStamps()).toEqual([])
    expect(outcome().trial_done).toEqual({ openers: 0, followups: 0, skipped: 1, reasons: { deals_read_failed: 1 } })
  })

  it('a throw does not stamp the arm row (the parent still stamps)', async () => {
    runTrialDoneOutreach.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(armStamps()).toEqual([])
    expect(outcome().trial_done).toBeNull()
  })

  it('ROUTEWRAP.C9 — the arm is stamped after the run, beside the parent (defineCron stamps both)', async () => {
    const order = []
    stampHeartbeat.mockImplementation(async (name) => { order.push(`stamp:${name}`) })
    runHandoffSlaSweep.mockImplementation(async () => { order.push('handoff-sla'); return {} })
    await GET(req())
    expect(order).toEqual(['handoff-sla', 'stamp:agent-followups', 'stamp:trial-done-outreach'])
  })

  it('a later step that throws answers a fixed 500 and no parent stamp, but the clean arm keeps its stamp', async () => {
    rollupCheckinDay.mockImplementationOnce(() => { throw new Error('rollup exploded: secret detail') })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Follow-ups tick failed' })
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['trial-done-outreach'])
  })

  it('a stamp that rejects costs neither the tick nor the parent stamp', async () => {
    stampHeartbeat.mockImplementation(async (name) => { if (name === 'trial-done-outreach') throw new Error('db down') })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledWith('agent-followups', expect.any(Object))
  })
})

// ROUTEWRAP.C9 — on defineCron with the same stamps as before.
describe('GET /api/cron/agent-followups — defineCron stamp paths', () => {
  beforeEach(() => { createServerClient.mockReturnValue(hbDb({ data: null, error: null })) })
  afterEach(() => { runHandoffSlaSweep.mockImplementation(async () => ({})) })

  it('401: nothing read, nothing run, nothing stamped', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(runAgentFollowups).not.toHaveBeenCalled()
    expect(runTrialDoneOutreach).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean tick answers 200 success and stamps exactly its own row and the trial-done arm', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['agent-followups', 'trial-done-outreach'])
  })

  it('an arm that failed answers success:false with 200 and still stamps its own row, naming the arm', async () => {
    runHandoffSlaSweep.mockRejectedValue(new Error('handoffs: relation secret down'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, arm_errors: ['handoff_sla'] })
    expect(JSON.stringify(body)).not.toContain('secret down')
    expect(outcome()).toMatchObject({ arm_errors: ['handoff_sla'], handoffSla: null })
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['agent-followups', 'trial-done-outreach'])
  })

  it('a follow-ups tick that throws answers a fixed 500 and stamps nothing', async () => {
    runAgentFollowups.mockRejectedValue(new Error('conversations: secret detail'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Follow-ups tick failed' })
    expect(runTrialDoneOutreach).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
