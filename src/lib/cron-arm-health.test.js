// HEARTBEAT.1 — the two arms that ride another cron's schedule, and when one
// of their runs counts as clean enough to stamp the arm's own heartbeat row.
// Pure predicates, plus two drift guards that run the REAL arms down their
// zero-work path, so a renamed counter or a changed "nothing to do" shape
// cannot silently turn every quiet tick into a missed stamp.

import { describe, it, expect, vi } from 'vitest'

// The arms' collaborators, mocked exactly as their own test files do. The
// zero-work paths below return before touching any of them.
vi.mock('./roster-read', () => ({ fetchApiShiftRows: vi.fn() }))
vi.mock('./notify', () => ({ notifyUsers: vi.fn() }))
vi.mock('./push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn() }))
vi.mock('./roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const {
  SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT, REPLACE_NOTICES_HEARTBEAT, SHIFT_ARM_FAULT_KEYS,
  shiftReminderArmHealthy, runwayArmHealthy, replaceNoticeArmHealthy,
} = await import('./cron-arm-health')
const { runShiftReminders } = await import('./shift-reminders')
const { runRosterRunwayAlerts } = await import('./roster-runway-notify')
const { runReplaceNotices } = await import('./shift-replace-notify')

const SHIFT_CLEAN = {
  quiet_hours: 0, shift_candidates: 2, shift_pushed: 1, shift_emailed: 0, shift_skipped_dup: 1,
  shift_skipped_no_recipient: 0, shift_send_failed: 0, shift_send_threw: 0, shift_claim_failed: 0, shift_read_capped: 0,
}
const RUNWAY_CLEAN = { locations: 2, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0 }

describe('heartbeat row names', () => {
  it('are the kebab-case names mig 633 seeds (the migration test cross-checks the SQL)', () => {
    expect(SHIFT_REMINDERS_HEARTBEAT).toBe('shift-reminders')
    expect(ROSTER_RUNWAY_HEARTBEAT).toBe('roster-runway')
  })

  it('REPLACE.1a — the held replace-notice arm has its own row name (seeded later; stampHeartbeat is UPDATE-only, so until then a stamp is a logged no-op)', () => {
    expect(REPLACE_NOTICES_HEARTBEAT).toBe('replace-notices')
  })
})

describe('shiftReminderArmHealthy', () => {
  it('a clean run with work done is healthy', () => {
    expect(shiftReminderArmHealthy(SHIFT_CLEAN)).toBe(true)
  })

  it('a run with nothing to send is healthy: a quiet day, and a quiet-hours tick', () => {
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 })).toBe(true)
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, quiet_hours: 1, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 })).toBe(true)
  })

  it('a counter the summary does not carry reads as 0 (an older or partial summary is not a fault)', () => {
    expect(shiftReminderArmHealthy({ shift_candidates: 2, shift_pushed: 1 })).toBe(true)
  })

  it.each(['shift_claim_failed', 'shift_send_threw', 'shift_read_capped'])('%s > 0 is a fault in the arm itself: not healthy', (key) => {
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, [key]: 1 })).toBe(false)
  })

  it('a failed DELIVERY is not an arm fault: the claim was released and the next tick retries it', () => {
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, shift_send_failed: 3 })).toBe(true)
  })

  it.each([undefined, null, 'ok', 0, [SHIFT_CLEAN]])('a run that returned %j has not shown it ran: not healthy', (v) => {
    expect(shiftReminderArmHealthy(v)).toBe(false)
  })

  it('the fault keys are exactly the three it gates on', () => {
    expect([...SHIFT_ARM_FAULT_KEYS].sort()).toEqual(['shift_claim_failed', 'shift_read_capped', 'shift_send_threw'])
    expect(Object.isFrozen(SHIFT_ARM_FAULT_KEYS)).toBe(true)
  })
})

describe('runwayArmHealthy', () => {
  it('a clean run is healthy, and so is a day with nothing to announce or held back by quiet hours', () => {
    expect(runwayArmHealthy(RUNWAY_CLEAN)).toBe(true)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, alerts: 0, sent: 0 })).toBe(true)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, quiet_hours: 1, sent: 0 })).toBe(true)
    expect(runwayArmHealthy({ locations: 0, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 })).toBe(true)
  })

  it('a delivery failure inside a run that completed is still healthy (it rides in last_outcome; the claim is released for tomorrow)', () => {
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, failed: 1 })).toBe(true)
  })

  it('the parent\'s error outcome ({ error }) is not healthy, whatever else it carries', () => {
    expect(runwayArmHealthy({ error: 'runway read failed: blocks down' })).toBe(false)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, error: 'x' })).toBe(false)
  })

  it.each([undefined, null, 'ok', 1, [RUNWAY_CLEAN]])('a run that returned %j has not shown it ran: not healthy', (v) => {
    expect(runwayArmHealthy(v)).toBe(false)
  })
})

describe('replaceNoticeArmHealthy (REPLACE.1a)', () => {
  const CLEAN = { rows: 2, groups: 1, silent: 0, quiet: 0, fresh: 0, errors: 0 }

  it('a clean run is healthy, and so are a quiet-hours tick and a tick with nothing held', () => {
    expect(replaceNoticeArmHealthy(CLEAN)).toBe(true)
    expect(replaceNoticeArmHealthy({ ...CLEAN, groups: 0, quiet: 2 })).toBe(true)
    expect(replaceNoticeArmHealthy({ rows: 0, groups: 0, silent: 0, quiet: 0, fresh: 0, errors: 0 })).toBe(true)
  })

  it('errors > 0 (a read, a stamp or a notify that threw) is a fault in the arm itself', () => {
    expect(replaceNoticeArmHealthy({ ...CLEAN, errors: 1 })).toBe(false)
  })

  it.each([undefined, null, 'ok', 0, [CLEAN]])('a run that returned %j has not shown it ran: not healthy', (v) => {
    expect(replaceNoticeArmHealthy(v)).toBe(false)
  })
})

// Drift guards: the arms' REAL zero-work outcomes must read as healthy.
describe('the real arms, on their zero-work paths', () => {
  it('runShiftReminders with no locations returns its full summary shape, every fault key 0, and it is healthy', async () => {
    const summary = await runShiftReminders(null, { locations: [] })
    for (const key of SHIFT_ARM_FAULT_KEYS) expect(summary).toHaveProperty(key, 0)
    expect(shiftReminderArmHealthy(summary)).toBe(true)
  })

  it('runShiftReminders in quiet hours (02:00 Dublin) returns quiet_hours: 1 before any read, and it is healthy', async () => {
    const db = { from: () => { throw new Error('quiet hours must not read') } }
    const summary = await runShiftReminders(db, {
      nowMs: Date.UTC(2026, 8, 25, 1, 0), // 02:00 IST
      locations: [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin' }],
    })
    expect(summary.quiet_hours).toBe(1)
    expect(shiftReminderArmHealthy(summary)).toBe(true)
  })

  it('runRosterRunwayAlerts with no locations returns its outcome, and it is healthy', async () => {
    const b = { select: () => b, then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej) }
    const outcome = await runRosterRunwayAlerts({ from: () => b }, { nowMs: Date.UTC(2026, 8, 25, 8, 0) })
    expect(outcome).toEqual({ locations: 0, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 })
    expect(runwayArmHealthy(outcome)).toBe(true)
  })

  it('runReplaceNotices with nothing held returns its counts, errors 0, and it is healthy', async () => {
    const b = {}
    for (const m of ['select', 'is', 'eq', 'gte', 'order', 'limit']) b[m] = () => b
    b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
    const stats = await runReplaceNotices({ from: () => b }, { nowMs: Date.UTC(2026, 8, 25, 8, 0), todayStr: '2026-09-25' })
    expect(stats).toEqual({ rows: 0, groups: 0, silent: 0, quiet: 0, fresh: 0, errors: 0 })
    expect(replaceNoticeArmHealthy(stats)).toBe(true)
  })
})
