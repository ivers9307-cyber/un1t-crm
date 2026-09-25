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
const { logError, logWarn } = await import('@/lib/log')
const { reminderDue } = await import('@/lib/contracts')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const OUTCOME = { locations: 3, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0 }
// HEARTBEAT.1 — the heartbeat rows this run stamped, in call order.
const stampedNames = () => stampHeartbeat.mock.calls.map((c) => c[0])

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  stampHeartbeat.mockImplementation(async () => {})
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
    // Unchanged from before RUNWAY.1: a crashed contract run does not stamp
    // 'contract-reminders'. HEARTBEAT.1: the runway arm had already run clean
    // and stamped its own row, so a contract crash never reads as a runway one.
    expect(stampedNames()).toEqual(['roster-runway'])
  })
})

// HEARTBEAT.1 — the runway arm has a heartbeat row of its own ('roster-runway',
// mig 633). 'contract-reminders' is stamped whatever the arm did and the
// health-check reads only is_stale, so runway_arm_failed: 1 every day paged
// nobody. The row is stamped right after the arm (before the contract half can
// crash) and ONLY when it returned an outcome and did not throw.
describe('GET /api/cron/contract-reminders — roster-runway heartbeat', () => {
  it('a clean arm: roster-runway is stamped with the arm\'s outcome BEFORE the contract half runs, then contract-reminders as before', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    let stampedBeforeContracts = null
    reminderDue.mockImplementation(() => { stampedBeforeContracts ??= stampedNames().slice(); return false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedBeforeContracts).toEqual(['roster-runway'])
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', OUTCOME)
  })

  it('a day with nothing to announce stamps: a quiet day is healthy', async () => {
    const idle = { locations: 3, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 }
    runRosterRunwayAlerts.mockResolvedValue(idle)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', idle)
  })

  it('alerts held back by quiet hours still stamp (the arm ran; the next in-band run sends)', async () => {
    const held = { ...OUTCOME, quiet_hours: 1, sent: 0 }
    runRosterRunwayAlerts.mockResolvedValue(held)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', held)
  })

  it('a delivery failure inside a completed run still stamps (claim released for tomorrow; failed rides in last_outcome)', async () => {
    runRosterRunwayAlerts.mockResolvedValue({ ...OUTCOME, failed: 1 })
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', expect.objectContaining({ failed: 1 }))
  })

  it('the arm THROWS: roster-runway is NOT stamped; contract-reminders is, exactly as before', async () => {
    runRosterRunwayAlerts.mockRejectedValue(new Error('runway read failed: blocks down'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['contract-reminders'])
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', {
      checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, runway: { error: 'runway read failed: blocks down' }, runway_arm_failed: 1,
    })
  })

  it('an arm that resolves with nothing has not shown it ran: not stamped', async () => {
    runRosterRunwayAlerts.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders'])
  })

  it('an arm that resolves with an { error } outcome is not stamped', async () => {
    runRosterRunwayAlerts.mockResolvedValue({ error: 'something' })
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders'])
  })

  it('a rejecting roster-runway stamp cannot cost the contract half its run, its stamp or its 200', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    stampHeartbeat.mockImplementation((name) =>
      name === 'roster-runway' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(reminderDue).toHaveBeenCalledTimes(1)
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
    expect(logWarn).toHaveBeenCalledWith('cron-contract-reminders', 'roster-runway heartbeat failed', expect.anything())
  })
})
