// RUNWAY.1 — the roster-runway arm's WIRING inside the daily contract-reminders
// cron. The contract half has no route test of its own; this file pins only
// what RUNWAY.1 added: the arm runs, its outcome is recorded on the heartbeat,
// its failure is contained AND visible, and neither arm can stop the other.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let contractRows = []
function makeBuilder() {
  const b = {}
  for (const m of ['select', 'in', 'lt', 'order', 'range', 'update', 'eq']) b[m] = () => b
  b.then = (resolve, reject) => Promise.resolve({ data: contractRows, error: null }).then(resolve, reject)
  return b
}
const fakeDb = { from: () => makeBuilder() }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/contracts', () => ({ reminderDue: vi.fn(() => false) }))
vi.mock('@/lib/contracts-email', () => ({ sendContractReminderEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/roster-runway-notify', () => ({ runRosterRunwayAlerts: vi.fn() }))

const { GET } = await import('./route.js')
const { runRosterRunwayAlerts } = await import('@/lib/roster-runway-notify')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')
const { reminderDue } = await import('@/lib/contracts')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const OUTCOME = { locations: 3, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0 }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  contractRows = []
  reminderDue.mockReset().mockReturnValue(false)
  runRosterRunwayAlerts.mockReset().mockResolvedValue(OUTCOME)
})

describe('GET /api/cron/contract-reminders — roster runway arm', () => {
  it('401 without the cron bearer, and the runway arm never runs', async () => {
    expect((await GET(req('Bearer wrong'))).status).toBe(401)
    expect(runRosterRunwayAlerts).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('runs the arm with the service-role client and records its outcome on the heartbeat and the response', async () => {
    const res = await GET(req())
    expect(runRosterRunwayAlerts).toHaveBeenCalledWith(fakeDb)
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', {
      checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, runway: OUTCOME, runway_arm_failed: 0,
    })
    expect(await res.json()).toEqual({
      success: true, checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, runway: OUTCOME, runway_arm_failed: 0,
    })
  })

  it('a throwing arm is logged, VISIBLE in the response and the heartbeat, and the contract half still runs and stamps', async () => {
    runRosterRunwayAlerts.mockRejectedValue(new Error('runway read failed: blocks down'))
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith('cron-contract-reminders', 'roster runway arm threw', expect.anything())
    // The contract half was not skipped: it read its candidate and judged it.
    expect(reminderDue).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', expect.objectContaining({
      checked: 1, runway: { error: 'runway read failed: blocks down' }, runway_arm_failed: 1,
    }))
    expect(await res.json()).toMatchObject({
      success: true, checked: 1, runway: { error: 'runway read failed: blocks down' }, runway_arm_failed: 1,
    })
  })

  it('a throw with no message is still a visible failure', async () => {
    runRosterRunwayAlerts.mockRejectedValue(undefined)
    expect(await (await GET(req())).json()).toMatchObject({ runway: { error: 'runway arm failed' }, runway_arm_failed: 1 })
  })

  it('and vice versa: the contract half throwing cannot cost the runway arm its run', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    reminderDue.mockImplementation(() => { throw new Error('contracts blew up') })
    await expect(GET(req())).rejects.toThrow('contracts blew up')
    expect(runRosterRunwayAlerts).toHaveBeenCalledTimes(1)
    // Unchanged from before RUNWAY.1: a crashed contract run does not stamp.
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
