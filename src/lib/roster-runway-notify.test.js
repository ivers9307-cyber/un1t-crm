// RUNWAY.1 — the daily push: who, what, when, and exactly once.
//
// Two layers. `decideRunwayPush` is PURE (no clock, no database): it owns the
// quiet-hours band, the dedup key and the copy, so those are table-tested
// here without a mock in sight. `runRosterRunwayAlerts` is the IO around it,
// tested with the dedup sender and the reader mocked. The recipients, the
// ledger and the email subject are pinned against the REAL push-dedup /
// notify / registry in roster-runway-notify.recipients.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn() }))
vi.mock('./roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { notifyUsersAtRolesOnce } = await import('./push-dedup')
const { fetchRosterRunways } = await import('./roster-runway-data')
const { logWarn } = await import('./log')
const {
  runRosterRunwayAlerts, decideRunwayPush, isInRunwaySendWindow, runwayEventKey,
  RUNWAY_NOTIFY_ROLES, RUNWAY_SEND_FROM, RUNWAY_SEND_UNTIL,
} = await import('./roster-runway-notify')

const NORTH = { id: 'loc-north', name: 'Studio North', timezone: 'Europe/Dublin' }
const SOUTH = { id: 'loc-south', name: 'Studio South', timezone: 'Europe/Dublin' }
const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}
// Sat 19 Sep 2026, 08:00 UTC = 09:00 in Dublin (IST): the cron's own tick.
const CRON_TICK = Date.UTC(2026, 8, 19, 8, 0)

function makeDb(locations, error = null) {
  const selects = []
  const b = {
    select: (cols) => { selects.push(cols); return b },
    then: (res, rej) => Promise.resolve({ data: locations, error }).then(res, rej),
  }
  return { selects, from: (table) => { if (table !== 'locations') throw new Error(`unexpected table ${table}`); return b } }
}

// The reader's shape: every unready week per studio, plus its head.
const runwaysAre = (weeksByLocation) => fetchRosterRunways.mockResolvedValue({
  success: true,
  data: {
    weeksByLocation,
    byLocation: Object.fromEntries(Object.entries(weeksByLocation).map(([id, list]) => [id, list[0] ?? null])),
  },
})

beforeEach(() => {
  logWarn.mockReset()
  notifyUsersAtRolesOnce.mockReset().mockResolvedValue({ sent: 2, skipped: 0, invalidated: 0, failed: 0, emailed: 0, deduped: 0 })
  fetchRosterRunways.mockReset()
  runwaysAre({ [NORTH.id]: [RUNWAY], [SOUTH.id]: [] })
})

// ── quiet hours ──────────────────────────────────────────────────────────
// A staff push that is not a reply to the recipient's own action may only be
// SENT while the studio's wall clock is inside [07:00, 22:00).
describe('isInRunwaySendWindow', () => {
  it('pins the band, and that it IS the shift reminders\' band (one rule for every unprompted staff push)', async () => {
    expect([RUNWAY_SEND_FROM, RUNWAY_SEND_UNTIL]).toEqual(['07:00', '22:00'])
    const shared = await import('./shift-reminders')
    expect([RUNWAY_SEND_FROM, RUNWAY_SEND_UNTIL]).toEqual([shared.NO_REMINDER_BEFORE, shared.NO_REMINDER_FROM])
    for (const ms of [Date.UTC(2026, 8, 19, 5, 59), Date.UTC(2026, 8, 19, 6, 0), Date.UTC(2026, 8, 19, 20, 59), Date.UTC(2026, 8, 19, 21, 0)]) {
      expect(isInRunwaySendWindow(ms, 'Europe/Dublin')).toBe(shared.isInSendWindow(ms, 'Europe/Dublin'))
    }
  })

  // [UTC instant, zone, open?]
  it.each([
    // Summer (IST, UTC+1): 07:00 Dublin is 06:00 UTC.
    [Date.UTC(2026, 8, 19, 5, 59), 'Europe/Dublin', false], // 06:59
    [Date.UTC(2026, 8, 19, 6, 0), 'Europe/Dublin', true],   // 07:00, inclusive
    [Date.UTC(2026, 8, 19, 8, 0), 'Europe/Dublin', true],   // the cron tick
    [Date.UTC(2026, 8, 19, 20, 59), 'Europe/Dublin', true], // 21:59
    [Date.UTC(2026, 8, 19, 21, 0), 'Europe/Dublin', false], // 22:00, exclusive
    [Date.UTC(2026, 8, 19, 23, 30), 'Europe/Dublin', false], // 00:30 next day
    // To the SECOND: the band is [07:00:00, 22:00:00), not "roughly 7 to 10".
    [Date.UTC(2026, 8, 19, 5, 59, 59), 'Europe/Dublin', false], // 06:59:59
    [Date.UTC(2026, 8, 19, 6, 0, 0), 'Europe/Dublin', true],    // 07:00:00
    [Date.UTC(2026, 8, 19, 20, 59, 59), 'Europe/Dublin', true], // 21:59:59
    [Date.UTC(2026, 8, 19, 21, 0, 0), 'Europe/Dublin', false],  // 22:00:00
    // Winter (GMT, UTC+0): 07:00 Dublin is 07:00 UTC.
    [Date.UTC(2026, 0, 15, 6, 59), 'Europe/Dublin', false],
    [Date.UTC(2026, 0, 15, 7, 0), 'Europe/Dublin', true],
    [Date.UTC(2026, 0, 15, 21, 59), 'Europe/Dublin', true],
    [Date.UTC(2026, 0, 15, 22, 0), 'Europe/Dublin', false],
    // Spring forward, Sun 29 Mar 2026 (01:00 GMT -> 02:00 IST, a 23-hour day).
    [Date.UTC(2026, 2, 28, 6, 59), 'Europe/Dublin', false], // the Saturday is still GMT: 06:59
    [Date.UTC(2026, 2, 28, 7, 0), 'Europe/Dublin', true],
    [Date.UTC(2026, 2, 28, 22, 0), 'Europe/Dublin', false], // 22:00 GMT Saturday
    [Date.UTC(2026, 2, 29, 5, 59), 'Europe/Dublin', false], // 06:59 IST
    [Date.UTC(2026, 2, 29, 6, 0), 'Europe/Dublin', true],   // 07:00 IST: an hour EARLIER in UTC than the day before
    [Date.UTC(2026, 2, 29, 8, 0), 'Europe/Dublin', true],   // the cron tick, now 09:00
    [Date.UTC(2026, 2, 29, 20, 59), 'Europe/Dublin', true], // 21:59 IST
    [Date.UTC(2026, 2, 29, 21, 0), 'Europe/Dublin', false], // 22:00 IST
    // Fall back, Sun 25 Oct 2026 (02:00 IST -> 01:00 GMT, a 25-hour day).
    [Date.UTC(2026, 9, 24, 20, 59), 'Europe/Dublin', true],  // Saturday 21:59 IST
    [Date.UTC(2026, 9, 24, 21, 0), 'Europe/Dublin', false],  // Saturday 22:00 IST
    [Date.UTC(2026, 9, 25, 0, 30), 'Europe/Dublin', false],  // 01:30 IST, the first time round
    [Date.UTC(2026, 9, 25, 1, 30), 'Europe/Dublin', false],  // 01:30 GMT, the second
    [Date.UTC(2026, 9, 25, 6, 0), 'Europe/Dublin', false],   // 06:00 GMT: 07:00 yesterday, NOT today
    [Date.UTC(2026, 9, 25, 6, 59), 'Europe/Dublin', false],
    [Date.UTC(2026, 9, 25, 7, 0), 'Europe/Dublin', true],
    [Date.UTC(2026, 9, 25, 8, 0), 'Europe/Dublin', true],    // the cron tick, now 08:00
    [Date.UTC(2026, 9, 25, 21, 59), 'Europe/Dublin', true],
    [Date.UTC(2026, 9, 25, 22, 0), 'Europe/Dublin', false],
    // Another zone: the band is the STUDIO's wall clock, not Dublin's.
    [Date.UTC(2026, 8, 19, 8, 0), 'America/New_York', false], // 04:00 in New York
    [Date.UTC(2026, 8, 19, 11, 0), 'America/New_York', true], // 07:00
    [Date.UTC(2026, 8, 19, 8, 0), 'Asia/Tokyo', true],        // 17:00
    [Date.UTC(2026, 8, 19, 13, 0), 'Asia/Tokyo', false],      // 22:00
  ])('%i in %s -> %s', (nowMs, tz, open) => {
    expect(isInRunwaySendWindow(nowMs, tz)).toBe(open)
  })

  it('an unreadable clock is CLOSED: never push on a guess', () => {
    expect(isInRunwaySendWindow(NaN, 'Europe/Dublin')).toBe(false)
    expect(isInRunwaySendWindow(undefined, 'Europe/Dublin')).toBe(false)
  })
})

describe('decideRunwayPush — pure', () => {
  it('ready -> nothing', () => {
    expect(decideRunwayPush({ runway: null, location: NORTH, nowMs: CRON_TICK })).toEqual({ send: false, reason: 'ready' })
  })

  it('unready, inside the band -> the key and the whole payload', () => {
    expect(decideRunwayPush({ runway: RUNWAY, location: NORTH, nowMs: CRON_TICK })).toEqual({
      send: true,
      timezoneFallback: false,
      eventKey: 'roster_runway:loc-north:2026-09-28:amber',
      payload: {
        title: 'Studio North: week of 28 Sep is not ready',
        body: 'Starts in 9 days: 34 of 34 shifts have no coach, not published.',
        category: 'schedule',
        emailSubject: 'Studio North: week of 28 Sep is not ready',
        data: { type: 'roster_runway', location_id: NORTH.id, week_start: '2026-09-28', severity: 'amber' },
      },
    })
  })

  it('unready, outside the band -> nothing, whatever the severity (a future cron move cannot push at night)', () => {
    const night = Date.UTC(2026, 8, 19, 2, 20) // 03:20 Dublin, the roster cron's hour
    expect(decideRunwayPush({ runway: RUNWAY, location: NORTH, nowMs: night }))
      .toEqual({ send: false, reason: 'quiet_hours', timezoneFallback: false })
    expect(decideRunwayPush({ runway: { ...RUNWAY, severity: 'red', daysAway: 1 }, location: NORTH, nowMs: night }))
      .toMatchObject({ send: false, reason: 'quiet_hours' })
  })

  it("the studio's own timezone decides, and a missing one is Dublin with no complaint", () => {
    const tick = { runway: RUNWAY, nowMs: CRON_TICK }
    expect(decideRunwayPush({ ...tick, location: { ...NORTH, timezone: 'America/New_York' } })).toMatchObject({ send: false, reason: 'quiet_hours', timezoneFallback: false })
    expect(decideRunwayPush({ ...tick, location: { ...NORTH, timezone: null } })).toMatchObject({ send: true, timezoneFallback: false })
    expect(decideRunwayPush({ ...tick, location: { id: NORTH.id, name: NORTH.name } })).toMatchObject({ send: true, timezoneFallback: false })
  })

  it.each(['', '   ', 'Mars/Olympus', 'Europe/Dubln', 42, {}, []])(
    'an invalid or empty timezone (%j) falls back to Dublin, says so, and never throws',
    (timezone) => {
      expect(decideRunwayPush({ runway: RUNWAY, location: { ...NORTH, timezone }, nowMs: CRON_TICK }))
        .toMatchObject({ send: true, timezoneFallback: true })
      // ...and it is DUBLIN's band that then applies, not "always open".
      expect(decideRunwayPush({ runway: RUNWAY, location: { ...NORTH, timezone }, nowMs: Date.UTC(2026, 8, 19, 2, 20) }))
        .toEqual({ send: false, reason: 'quiet_hours', timezoneFallback: true })
    },
  )

  it('the subject is its own: never the schedule category\'s "has been published"', () => {
    const d = decideRunwayPush({ runway: RUNWAY, location: NORTH, nowMs: CRON_TICK })
    expect(d.payload.emailSubject).toBe(d.payload.title)
    expect(d.payload.emailSubject).not.toMatch(/published$/i)
  })

  it('the key changes with severity and week, and with nothing else', () => {
    expect(runwayEventKey('L', RUNWAY)).toBe('roster_runway:L:2026-09-28:amber')
    expect(runwayEventKey('L', { ...RUNWAY, severity: 'red', daysAway: 4, staffed: 10 })).toBe('roster_runway:L:2026-09-28:red')
    expect(RUNWAY_NOTIFY_ROLES).toEqual(['owner', 'manager', 'head_coach'])
  })
})

describe('runRosterRunwayAlerts', () => {
  it('pushes once for the unready studio, to the roles that can publish, under the schedule category', async () => {
    const db = makeDb([NORTH, SOUTH])
    const outcome = await runRosterRunwayAlerts(db, { nowMs: CRON_TICK })

    expect(db.selects).toEqual(['id, name, timezone'])
    // "today" is the DUBLIN day of the instant, not the host's.
    expect(fetchRosterRunways).toHaveBeenCalledWith(db, [NORTH.id, SOUTH.id], { todayIso: '2026-09-19' })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledWith(
      db,
      'roster_runway:loc-north:2026-09-28:amber',
      NORTH.id,
      ['owner', 'manager', 'head_coach'],
      {
        title: 'Studio North: week of 28 Sep is not ready',
        body: 'Starts in 9 days: 34 of 34 shifts have no coach, not published.',
        category: 'schedule',
        emailSubject: 'Studio North: week of 28 Sep is not ready',
        data: { type: 'roster_runway', location_id: NORTH.id, week_start: '2026-09-28', severity: 'amber' },
      },
    )
    expect(outcome).toEqual({ locations: 2, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0 })
  })

  it('"today" follows Dublin across midnight: 23:30 UTC on the 19th is already the 20th there (IST)', async () => {
    await runRosterRunwayAlerts(makeDb([NORTH]), { nowMs: Date.UTC(2026, 8, 19, 23, 30) })
    expect(fetchRosterRunways).toHaveBeenCalledWith(expect.anything(), [NORTH.id], { todayIso: '2026-09-20' })
  })

  it('outside the band: NOTHING is sent and the dedup sender is never reached, so no key is claimed', async () => {
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH, SOUTH]), { nowMs: Date.UTC(2026, 8, 19, 2, 20) })
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(outcome).toEqual({ locations: 2, alerts: 1, quiet_hours: 1, sent: 0, emailed: 0, deduped: 0, failed: 0 })
  })

  it('the band is per studio: one asleep, one awake', async () => {
    const west = { ...SOUTH, timezone: 'America/New_York' } // 04:00 there at the tick
    runwaysAre({ [NORTH.id]: [RUNWAY], [west.id]: [RUNWAY] })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH, west]), { nowMs: CRON_TICK })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersAtRolesOnce.mock.calls[0][2]).toBe(NORTH.id)
    expect(outcome).toMatchObject({ alerts: 2, quiet_hours: 1, sent: 2 })
  })

  it('an invalid timezone warns ONCE for that studio and still sends on Dublin time', async () => {
    const outcome = await runRosterRunwayAlerts(makeDb([{ ...NORTH, timezone: 'Mars/Olympus' }]), { nowMs: CRON_TICK })
    expect(outcome).toMatchObject({ alerts: 1, sent: 2 })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('roster-runway', expect.stringMatching(/invalid timezone/), { locationId: NORTH.id, timezone: 'Mars/Olympus' })
  })

  it('EVERY unready week is announced, each under its own key: a gap next week cannot hide the week after', async () => {
    const nextWeek = { ...RUNWAY, weekStart: '2026-09-21', daysAway: 2, severity: 'red', blocks: 30, staffed: 29, unstaffed: 1, published: 30, unpublished: 0 }
    runwaysAre({ [NORTH.id]: [nextWeek, RUNWAY] })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH]), { nowMs: CRON_TICK })
    expect(notifyUsersAtRolesOnce.mock.calls.map((c) => [c[1], c[4].body])).toEqual([
      ['roster_runway:loc-north:2026-09-21:red', 'Starts in 2 days: 1 of 30 shifts has no coach.'],
      ['roster_runway:loc-north:2026-09-28:amber', 'Starts in 9 days: 34 of 34 shifts have no coach, not published.'],
    ])
    expect(outcome).toMatchObject({ locations: 1, alerts: 2, sent: 4 })
  })

  it('an invalid timezone still warns once for the studio, not once per week', async () => {
    runwaysAre({ [NORTH.id]: [{ ...RUNWAY, weekStart: '2026-09-21', daysAway: 2, severity: 'red' }, RUNWAY] })
    await runRosterRunwayAlerts(makeDb([{ ...NORTH, timezone: 'Mars/Olympus' }]), { nowMs: CRON_TICK })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(2)
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('a second run the same day is reported as deduped, not as a send', async () => {
    notifyUsersAtRolesOnce.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 2 })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH]), { nowMs: CRON_TICK })
    expect(outcome).toMatchObject({ alerts: 1, sent: 0, deduped: 2 })
  })

  it('nothing unready -> nothing sent', async () => {
    runwaysAre({ [NORTH.id]: [] })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH]), { nowMs: CRON_TICK })
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ locations: 1, alerts: 0 })
  })

  it("one studio's send throwing does not cost the next studio its alert", async () => {
    runwaysAre({ [NORTH.id]: [RUNWAY], [SOUTH.id]: [RUNWAY] })
    notifyUsersAtRolesOnce.mockRejectedValueOnce(new Error('expo down'))
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH, SOUTH]), { nowMs: CRON_TICK })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(2)
    expect(outcome).toMatchObject({ alerts: 2, failed: 1, sent: 2 })
  })

  it('a failed read throws BEFORE anything is sent, so the cron can record it', async () => {
    await expect(runRosterRunwayAlerts(makeDb(null, { message: 'down' }), { nowMs: CRON_TICK })).rejects.toThrow(/locations read failed/)
    fetchRosterRunways.mockResolvedValue({ success: false, error: 'blocks down' })
    await expect(runRosterRunwayAlerts(makeDb([NORTH]), { nowMs: CRON_TICK })).rejects.toThrow(/runway read failed: blocks down/)
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
  })
})
