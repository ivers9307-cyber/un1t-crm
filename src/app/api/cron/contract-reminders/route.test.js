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

let clients = 0
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { clients++; return fakeDb } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/contracts', () => ({ reminderDue: vi.fn(() => false) }))
vi.mock('@/lib/contracts-email', () => ({ sendContractReminderEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/roster-runway-notify', () => ({ runRosterRunwayAlerts: vi.fn() }))
vi.mock('@/lib/qualification-digest', () => ({ runQualificationDigest: vi.fn() }))
// TZ.6 — this file's subject is not the daily-slot gate: every location is due
// for the contract half AND both arms' own slots, on the 08:00 UTC tick
// (route.tz6.test.js covers the gate and each arm's per-studio slot).
vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({
  ...(await importOriginal()),
  gateDailySlot: vi.fn((await import('@/lib/cron-daily-slot.test-helpers')).openGate),
}))

const { GET } = await import('./route.js')
const { runRosterRunwayAlerts } = await import('@/lib/roster-runway-notify')
const { runQualificationDigest } = await import('@/lib/qualification-digest')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError, logWarn } = await import('@/lib/log')
const { reminderDue } = await import('@/lib/contracts')
const { gateDailySlot } = await import('@/lib/cron-daily-slot')
const { openGate } = await import('@/lib/cron-daily-slot.test-helpers')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const OUTCOME = { locations: 3, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0 }
const QUALS = { organizations: 1, recipients: 1, rows: 2, nothing_due: 0, quiet_hours: 0, sent: 1, emailed: 0, email_failed: 0, deduped: 0, failed: 0, stamp_failed: 0 }
// HEARTBEAT.1 — the heartbeat rows this run stamped, in call order
// (ROUTEWRAP.C9: defineCron stamps the job's own row, then the arms).
const stampedNames = () => stampHeartbeat.mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-10-01T08:00:00Z'))
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  stampHeartbeat.mockImplementation(async () => {})
  contractRows = []
  clients = 0
  gateDailySlot.mockImplementation(openGate)
  reminderDue.mockReset().mockReturnValue(false)
  runRosterRunwayAlerts.mockReset().mockResolvedValue(OUTCOME)
  runQualificationDigest.mockReset().mockResolvedValue(QUALS)
})

describe('GET /api/cron/contract-reminders — roster runway arm', () => {
  it('401 without the cron bearer, and the runway arm never runs', async () => {
    expect((await GET(req('Bearer wrong'))).status).toBe(401)
    expect(runRosterRunwayAlerts).not.toHaveBeenCalled()
    expect(runQualificationDigest).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(clients).toBe(0)
  })

  it('a clean slot tick stamps exactly its own row and both arm rows', async () => {
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat.mock.calls).toEqual([
      ['contract-reminders', expect.objectContaining({ runway_arm_failed: 0, qualification_arm_failed: 0 })],
      ['roster-runway', OUTCOME],
      ['qualification-digest', QUALS],
    ])
  })

  it('ROUTEWRAP.C9 — an arm whose gate faults answers 500 and success:false, yet the slot tick still stamps contract-reminders (and the clean arm)', async () => {
    gateDailySlot.mockImplementation(async (db, slotName, opts) => (slotName === 'roster-runway'
      ? { ok: false, faulted: true, slots: new Map(), summary: { zones: 'unreadable' } }
      : openGate(db, slotName, opts)))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, runway_arm_failed: 1, qualification_arm_failed: 0 })
    expect(runRosterRunwayAlerts).not.toHaveBeenCalled()
    const [own] = stampHeartbeat.mock.calls
    expect(own).toEqual(['contract-reminders', expect.objectContaining({ runway_arm_failed: 1, runway: expect.objectContaining({ error: expect.any(String) }) })])
    expect(stampedNames()).toEqual(['contract-reminders', 'qualification-digest'])
  })

  it('ROUTEWRAP.C9 — the contract gate unreadable answers 500 and stamps no contract-reminders; the clean arms keep theirs', async () => {
    gateDailySlot.mockImplementation(async (db, slotName, opts) => (slotName === 'contract-reminders'
      ? { ok: false, faulted: true, slots: new Map(), summary: { zones: 'unreadable' } }
      : openGate(db, slotName, opts)))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, runway: OUTCOME, qualifications: QUALS })
    expect(stampedNames()).toEqual(['roster-runway', 'qualification-digest'])
  })

  it('runs the arm with the service-role client and records its outcome on the heartbeat and the response', async () => {
    const res = await GET(req())
    expect(runRosterRunwayAlerts).toHaveBeenCalledWith(fakeDb, { nowMs: Date.parse('2026-10-01T08:00:00Z'), isDue: expect.any(Function) })
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', {
      checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, undelivered: 0, runway: OUTCOME, runway_arm_failed: 0,
      qualifications: QUALS, qualification_arm_failed: 0,
    })
    expect(await res.json()).toEqual({
      success: true, checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, undelivered: 0, runway: OUTCOME, runway_arm_failed: 0,
      qualifications: QUALS, qualification_arm_failed: 0,
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
      checked: 1, runway: { error: 'runway arm failed' }, runway_arm_failed: 1,
    }))
    // ROUTEWRAP.C9 — a fixed line: the thrown text stays in the log.
    const body = await res.json()
    expect(body).toMatchObject({
      success: true, checked: 1, runway: { error: 'runway arm failed' }, runway_arm_failed: 1,
    })
    expect(JSON.stringify(body)).not.toContain('blocks down')
  })

  it('a throw with no message is still a visible failure', async () => {
    runRosterRunwayAlerts.mockRejectedValue(undefined)
    expect(await (await GET(req())).json()).toMatchObject({ runway: { error: 'runway arm failed' }, runway_arm_failed: 1 })
  })

  it('and vice versa: the contract half throwing cannot cost the runway arm its run', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    reminderDue.mockImplementation(() => { throw new Error('contracts blew up') })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Contract reminders run failed' })
    expect(logError).toHaveBeenCalledWith('cron-contract-reminders', 'contract half threw', expect.anything())
    expect(runRosterRunwayAlerts).toHaveBeenCalledTimes(1)
    // Unchanged from before RUNWAY.1: a crashed contract run does not stamp
    // 'contract-reminders'. HEARTBEAT.1: the runway arm had already run clean
    // and keeps its own row's stamp, so a contract crash never reads as a runway one.
    expect(stampedNames()).toEqual(['roster-runway', 'qualification-digest'])
  })
})

// HEARTBEAT.1 — the runway arm has a heartbeat row of its own ('roster-runway',
// mig 633). 'contract-reminders' is stamped whatever the arm did and the
// health-check reads only is_stale, so runway_arm_failed: 1 every day paged
// nobody. The row is stamped right after the arm (before the contract half can
// crash) and ONLY when it returned an outcome and did not throw.
describe('GET /api/cron/contract-reminders — roster-runway heartbeat', () => {
  it('a clean arm: roster-runway is stamped with the arm\'s outcome beside contract-reminders', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway', 'qualification-digest'])
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
    expect(stampedNames()).toEqual(['contract-reminders', 'qualification-digest'])
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', {
      checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, undelivered: 0, runway: { error: 'runway arm failed' }, runway_arm_failed: 1,
      qualifications: QUALS, qualification_arm_failed: 0,
    })
  })

  it('an arm that resolves with nothing has not shown it ran: not stamped', async () => {
    runRosterRunwayAlerts.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders', 'qualification-digest'])
  })

  it('an arm that resolves with an { error } outcome is not stamped', async () => {
    runRosterRunwayAlerts.mockResolvedValue({ error: 'something' })
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders', 'qualification-digest'])
  })

  it('a rejecting roster-runway stamp cannot cost the contract half its run, its stamp or its 200', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    stampHeartbeat.mockImplementation((name) =>
      name === 'roster-runway' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(reminderDue).toHaveBeenCalledTimes(1)
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway', 'qualification-digest'])
    expect(logWarn).toHaveBeenCalledWith('cron.contract-reminders', 'arm heartbeat failed', { arm: 'roster-runway', err: expect.any(Error) })
  })
})

// QUALS.1 — the weekly qualification digest is the third arm, with its own
// heartbeat row ('qualification-digest', mig 635): stamped after the runway
// arm and BEFORE the contract half can crash, only when it returned an
// outcome without { error }. Isolated both ways, like the runway arm.
describe('GET /api/cron/contract-reminders — qualification digest arm', () => {
  it('runs with the service-role client and stamps its own row with its outcome, after the runway arm', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    await GET(req())
    expect(runQualificationDigest).toHaveBeenCalledWith(fakeDb, { nowMs: Date.parse('2026-10-01T08:00:00Z'), isDue: expect.any(Function) })
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway', 'qualification-digest'])
    expect(stampHeartbeat).toHaveBeenCalledWith('qualification-digest', QUALS)
  })

  it('a throwing digest is logged and visible, is not stamped, and costs neither the runway arm nor the contracts', async () => {
    runQualificationDigest.mockRejectedValue(new Error('qualifications read failed: down'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith('cron-contract-reminders', 'qualification digest arm threw', expect.anything())
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway'])
    expect(await res.json()).toMatchObject({
      qualifications: { error: 'qualification digest arm failed' }, qualification_arm_failed: 1, runway_arm_failed: 0,
    })
  })

  it('an { error } outcome, or nothing at all, is not stamped', async () => {
    runQualificationDigest.mockResolvedValue({ error: 'x' })
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway'])
    stampHeartbeat.mockClear()
    runQualificationDigest.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway'])
  })

  it('a runway arm that throws does not stop the digest', async () => {
    runRosterRunwayAlerts.mockRejectedValue(new Error('runway down'))
    await GET(req())
    expect(runQualificationDigest).toHaveBeenCalledTimes(1)
    expect(stampedNames()).toEqual(['contract-reminders', 'qualification-digest'])
  })

  it('a rejecting qualification-digest stamp is logged and costs the contracts nothing', async () => {
    stampHeartbeat.mockImplementation((name) =>
      name === 'qualification-digest' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['contract-reminders', 'roster-runway', 'qualification-digest'])
    expect(logWarn).toHaveBeenCalledWith('cron.contract-reminders', 'arm heartbeat failed', { arm: 'qualification-digest', err: expect.any(Error) })
  })
})
