// tz-1b.tz.test.js — TZ.1b. The three private wall-clock solvers
// (push-reminders localToUtc, checklist-instances parseLocalToUtcMs/tzOffsetMs +
// todayInTimezone, staff-attendance resolveScheduledAt) now delegate to the
// canonical solver in shared/zoned-time.js. This file pins the change against
// the FROZEN pre-change bodies (tz-1b.legacy-dublin.test-helpers.js):
//   • Europe/Dublin: identical, every quarter-hour of every 2026 day, every
//     minute of both change days, and every quarter-hour instant for "today".
//   • America/New_York and Australia/Sydney: identical except on the exact
//     slots listed below, and every one of those slots is now correct (it reads
//     back as the wall clock asked for) or, in a spring-forward gap, follows the
//     one documented gap rule.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test: proves nothing reads the host clock
import { describe, it, expect } from 'vitest'

const L = await import('./tz-1b.legacy-dublin.test-helpers.js')
const { localToUtc } = await import('./push-reminders.js')
const { todayInTimezone, computeDeadlineAt } = await import('./checklist-instances.js')
const { resolveScheduledAt, effectiveWindowAt } = await import('./staff-attendance.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
const SYD = 'Australia/Sydney'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 → 02:00 (01:00Z); fall back Sun 25 Oct 02:00 → 01:00 (01:00Z).
// Sydney 2026: fall back Sun 5 Apr 03:00 → 02:00; spring forward Sun 4 Oct 02:00 → 03:00.

const pad = (n) => String(n).padStart(2, '0')
const DAYS_2026 = []
for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 864e5) DAYS_2026.push(new Date(t).toISOString().slice(0, 10))
const times = (step) => {
  const out = []
  for (let m = 0; m < 1440; m += step) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`)
  return out
}
const QUARTERS = times(15)
const MINUTES = times(1)

// The three solvers, each reduced to a comparable value (ISO string or null).
const SOLVERS = {
  localToUtc: {
    now: (d, t, z) => localToUtc(d, t, z)?.toISOString() ?? null,
    old: (d, t, z) => L.localToUtcLegacy(d, t, z)?.toISOString() ?? null,
  },
  resolveScheduledAt: {
    now: (d, t, z) => resolveScheduledAt(d, t, z)?.toISOString() ?? null,
    old: (d, t, z) => L.resolveScheduledAtLegacy(d, t, z)?.toISOString() ?? null,
  },
  computeDeadlineAt: {
    now: (d, t, z) => computeDeadlineAt([{ block_date: d, end_time: t }], z),
    old: (d, t, z) => L.computeDeadlineAtLegacy([{ block_date: d, end_time: t }], z),
  },
}

// Every (day, time) where new !== legacy, as 'YYYY-MM-DD HH:MM:SS'.
function diffs(name, zone, days, slots) {
  const { now, old } = SOLVERS[name]
  const out = []
  for (const d of days) for (const t of slots) if (now(d, t, zone) !== old(d, t, zone)) out.push(`${d} ${t}`)
  return out
}
// The wall clock an instant shows in `zone`, 'YYYY-MM-DD HH:MM:SS'.
const _wf = new Map()
function wallOf(iso, zone) {
  if (!_wf.has(zone)) _wf.set(zone, new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }))
  const p = Object.fromEntries(_wf.get(zone).formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}
// Slots on `day` from `from` (inclusive) to `to` (exclusive), quarter-hours.
const span = (day, from, to) => QUARTERS.filter((t) => t >= from && t < to).map((t) => `${day} ${t}`)

describe('TZ.1b Europe/Dublin is byte-identical to the retired solvers', () => {
  it.each(Object.keys(SOLVERS))('%s: every quarter-hour of every 2026 day', (name) => {
    expect(diffs(name, D, DAYS_2026, QUARTERS)).toEqual([])
  }, 120_000)

  it.each(Object.keys(SOLVERS))('%s: every minute of both change days and the days either side', (name) => {
    const days = ['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26']
    expect(diffs(name, D, days, MINUTES)).toEqual([])
  }, 60_000)

  it('todayInTimezone: every quarter-hour instant of 2026', () => {
    const bad = []
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 15 * 60_000) {
      const at = new Date(ms)
      if (JSON.stringify(todayInTimezone(at, D)) !== JSON.stringify(L.todayInTimezoneLegacy(at, D))) bad.push(at.toISOString())
    }
    expect(bad).toEqual([])
  }, 60_000)

  it('the gap hour (29 Mar 01:30) and the repeated hour (25 Oct 01:30) keep their answers', () => {
    // Gap: localToUtc and resolveScheduledAt resolve EARLIER (00:30 GMT);
    // a checklist deadline resolves LATER (02:30 IST), as each did before.
    expect(localToUtc('2026-03-29', '01:30:00', D).toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(resolveScheduledAt('2026-03-29', '01:30:00', D).toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(computeDeadlineAt([{ block_date: '2026-03-29', end_time: '01:30:00' }], D)).toBe('2026-03-29T01:30:00.000Z')
    // Repeated hour: all three take the SECOND 01:30 (GMT).
    expect(localToUtc('2026-10-25', '01:30:00', D).toISOString()).toBe('2026-10-25T01:30:00.000Z')
    expect(resolveScheduledAt('2026-10-25', '01:30:00', D).toISOString()).toBe('2026-10-25T01:30:00.000Z')
    expect(computeDeadlineAt([{ block_date: '2026-10-25', end_time: '01:30:00' }], D)).toBe('2026-10-25T01:30:00.000Z')
  })

  it('a 23:30 checklist deadline on 29 Mar 2026 equals the legacy answer', () => {
    const blocks = [{ block_date: '2026-03-29', end_time: '23:30:00' }]
    expect(computeDeadlineAt(blocks, D)).toBe(L.computeDeadlineAtLegacy(blocks, D))
    expect(computeDeadlineAt(blocks, D)).toBe('2026-03-29T22:30:00.000Z')
  })
})

describe('TZ.1b America/New_York: only the old one-pass errors and the gap change', () => {
  const zone = NY
  // localToUtc's single pass read the offset on the wrong side of the change for
  // 02:00-06:59 on 8 Mar and 02:00-05:59 on 1 Nov: an hour wrong.
  const LOCAL_TO_UTC = [...span('2026-03-08', '02:00', '07:00'), ...span('2026-11-01', '02:00', '06:00')]
  const GAP = span('2026-03-08', '02:00', '03:00')

  it('localToUtc differs exactly on the old one-pass error band (plus the gap)', () => {
    expect(diffs('localToUtc', zone, DAYS_2026, QUARTERS)).toEqual(LOCAL_TO_UTC)
  }, 120_000)
  it('resolveScheduledAt differs only in the spring-forward gap', () => {
    expect(diffs('resolveScheduledAt', zone, DAYS_2026, QUARTERS)).toEqual(GAP)
  }, 120_000)
  it('computeDeadlineAt differs only in the spring-forward gap', () => {
    expect(diffs('computeDeadlineAt', zone, DAYS_2026, QUARTERS)).toEqual(GAP)
  }, 120_000)

  it('every changed slot outside the gap now reads back as the wall clock asked for; legacy did not', () => {
    for (const slot of LOCAL_TO_UTC.filter((s) => !GAP.includes(s))) {
      const [d, t] = slot.split(' ')
      expect(wallOf(SOLVERS.localToUtc.now(d, t, zone), zone)).toBe(slot)
      expect(wallOf(SOLVERS.localToUtc.old(d, t, zone), zone)).not.toBe(slot)
    }
  })

  it('the gap (8 Mar 02:30, which does not exist) follows one rule per module', () => {
    // Wall clocks resolve EARLIER (01:30 EST), the canonical rule; legacy
    // localToUtc and resolveScheduledAt gave the LATER instant here.
    expect(localToUtc('2026-03-08', '02:30:00', zone).toISOString()).toBe('2026-03-08T06:30:00.000Z')
    expect(resolveScheduledAt('2026-03-08', '02:30:00', zone).toISOString()).toBe('2026-03-08T06:30:00.000Z')
    expect(L.resolveScheduledAtLegacy('2026-03-08', '02:30:00', zone).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // A checklist deadline resolves LATER (03:30 EDT), as Dublin's always has;
    // legacy gave the EARLIER instant here (and the LATER one in Dublin).
    expect(computeDeadlineAt([{ block_date: '2026-03-08', end_time: '02:30:00' }], zone)).toBe('2026-03-08T07:30:00.000Z')
    expect(L.computeDeadlineAtLegacy([{ block_date: '2026-03-08', end_time: '02:30:00' }], zone)).toBe('2026-03-08T06:30:00.000Z')
  })

  it('the repeated hour (1 Nov 01:30) is unchanged: the FIRST 01:30 (EDT)', () => {
    for (const name of Object.keys(SOLVERS)) {
      expect(SOLVERS[name].now('2026-11-01', '01:30:00', zone)).toBe('2026-11-01T05:30:00.000Z')
      expect(SOLVERS[name].old('2026-11-01', '01:30:00', zone)).toBe('2026-11-01T05:30:00.000Z')
    }
  })

  it('a 09:00 wall clock is 13:00Z in summer and 14:00Z in winter', () => {
    for (const name of Object.keys(SOLVERS)) {
      expect(SOLVERS[name].now('2026-07-01', '09:00:00', zone)).toBe('2026-07-01T13:00:00.000Z')
      expect(SOLVERS[name].now('2026-12-01', '09:00:00', zone)).toBe('2026-12-01T14:00:00.000Z')
    }
  })

  it('the day of the week and date flip at New York midnight', () => {
    expect(todayInTimezone(new Date('2026-07-01T03:59:00Z'), zone)).toEqual({ date: '2026-06-30', dow: 2 })
    expect(todayInTimezone(new Date('2026-07-01T04:00:00Z'), zone)).toEqual({ date: '2026-07-01', dow: 3 })
    expect(todayInTimezone(new Date('2026-11-01T04:59:00Z'), zone)).toEqual({ date: '2026-11-01', dow: 0 })
  })

  it('todayInTimezone: every quarter-hour instant of 2026 is unchanged', () => {
    const bad = []
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 15 * 60_000) {
      const at = new Date(ms)
      if (JSON.stringify(todayInTimezone(at, zone)) !== JSON.stringify(L.todayInTimezoneLegacy(at, zone))) bad.push(at.toISOString())
    }
    expect(bad).toEqual([])
  }, 60_000)
})

describe('TZ.1b Australia/Sydney (southern hemisphere, positive offset)', () => {
  const zone = SYD
  // localToUtc's single pass was an hour wrong for the 10 local hours before
  // each change (the naive guess sits on the other side of the 16:00Z change).
  const LOCAL_TO_UTC = [
    ...span('2026-04-04', '16:00', '24:00'), ...span('2026-04-05', '00:00', '02:00'),
    ...span('2026-10-03', '16:00', '24:00'), ...span('2026-10-04', '00:00', '02:00'),
  ]
  it('localToUtc differs exactly on the old one-pass error band, and each changed slot now reads back', () => {
    expect(diffs('localToUtc', zone, DAYS_2026, QUARTERS)).toEqual(LOCAL_TO_UTC)
    for (const slot of LOCAL_TO_UTC) {
      const [d, t] = slot.split(' ')
      expect(wallOf(SOLVERS.localToUtc.now(d, t, zone), zone)).toBe(slot)
      expect(wallOf(SOLVERS.localToUtc.old(d, t, zone), zone)).not.toBe(slot)
    }
  }, 120_000)
  it.each(['resolveScheduledAt', 'computeDeadlineAt'])('%s is unchanged on every quarter-hour of 2026', (name) => {
    expect(diffs(name, zone, DAYS_2026, QUARTERS)).toEqual([])
  }, 120_000)
})

describe('TZ.1b input handling is unchanged', () => {
  it('24:00 rolls over to the next midnight (a Postgres TIME can hold it)', () => {
    expect(localToUtc('2026-07-01', '24:00:00', D).toISOString()).toBe('2026-07-01T23:00:00.000Z')
    expect(resolveScheduledAt('2026-07-01', '24:00', D).toISOString()).toBe('2026-07-01T23:00:00.000Z')
    expect(computeDeadlineAt([{ block_date: '2026-07-01', end_time: '24:00:00' }], D)).toBe('2026-07-01T23:00:00.000Z')
    expect(effectiveWindowAt('2026-07-01', { start_time: '20:00:00', end_time: '24:00:00' }, D).end.toISOString())
      .toBe('2026-07-01T23:00:00.000Z')
  })

  it.each([
    ['localToUtc', '2026-02-30', '10:00'], ['localToUtc', '2026-06-15', '9:5'], ['localToUtc', '2026-06-15', '10:00:30'],
    ['localToUtc', 'not-a-date', '10:00'], ['localToUtc', '2026-06-15', null], ['localToUtc', null, '10:00'],
    ['resolveScheduledAt', '2026-02-30', '10:00'], ['resolveScheduledAt', '2026-06-15', '9:5'],
    ['resolveScheduledAt', '2026-06-15', '10:00:30'], ['resolveScheduledAt', '2026-06-15', '10'],
    ['resolveScheduledAt', '2026-06-15', 'x'], ['resolveScheduledAt', null, '10:00'],
    ['computeDeadlineAt', '2026-06-15', '10:00:30'], ['computeDeadlineAt', '2026-06-15', '10:00'],
    ['computeDeadlineAt', '2026-06-15', '10:00Z'], ['computeDeadlineAt', '2026-06-15', '10:00+05:00'],
    ['computeDeadlineAt', '2026-02-30', '10:00'], ['computeDeadlineAt', '2026-06-15', '9:5'],
  ])('%s(%s, %s) matches legacy in Dublin and New York', (name, d, t) => {
    expect(SOLVERS[name].now(d, t, D)).toBe(SOLVERS[name].old(d, t, D))
    expect(SOLVERS[name].now(d, t, NY)).toBe(SOLVERS[name].old(d, t, NY))
  })

  it('a non-numeric seconds field still throws RangeError from resolveScheduledAt', () => {
    expect(() => resolveScheduledAt('2026-06-15', '10:00:xx', D)).toThrow(RangeError)
    expect(() => L.resolveScheduledAtLegacy('2026-06-15', '10:00:xx', D)).toThrow(RangeError)
  })

  it('a fractional-seconds deadline keeps its milliseconds (legacy smeared them through the offset)', () => {
    // Legacy read the offset to the whole second, so the dropped .250 came back
    // as a 250 ms error, doubled: .750. Shift times are whole minutes in
    // practice; this is pinned so the one sub-second difference is on record.
    const blocks = [{ block_date: '2026-06-15', end_time: '10:00:30.250' }]
    expect(computeDeadlineAt(blocks, D)).toBe('2026-06-15T09:00:30.250Z')
    expect(L.computeDeadlineAtLegacy(blocks, D)).toBe('2026-06-15T09:00:30.750Z')
  })

  it('an invalid zone: localToUtc returns null, the others throw RangeError, as before', () => {
    for (const z of ['Not/AZone', '']) {
      expect(localToUtc('2026-06-15', '10:00', z)).toBeNull()
      expect(L.localToUtcLegacy('2026-06-15', '10:00', z)).toBeNull()
    }
    expect(() => resolveScheduledAt('2026-06-15', '10:00', 'Not/AZone')).toThrow(RangeError)
    expect(() => L.resolveScheduledAtLegacy('2026-06-15', '10:00', 'Not/AZone')).toThrow(RangeError)
    expect(() => todayInTimezone(new Date(), 'Not/AZone')).toThrow(RangeError)
    expect(() => L.todayInTimezoneLegacy(new Date(), 'Not/AZone')).toThrow(RangeError)
    const blocks = [{ block_date: '2026-06-15', end_time: '10:00' }]
    expect(() => computeDeadlineAt(blocks, 'Not/AZone')).toThrow(RangeError)
    expect(() => L.computeDeadlineAtLegacy(blocks, 'Not/AZone')).toThrow(RangeError)
  })

  it('the zone defaults are unchanged: resolveScheduledAt UTC; checklist Europe/Dublin', () => {
    expect(resolveScheduledAt('2026-07-01', '09:00').toISOString()).toBe('2026-07-01T09:00:00.000Z')
    expect(computeDeadlineAt([{ block_date: '2026-07-01', end_time: '09:00' }], null)).toBe('2026-07-01T08:00:00.000Z')
    expect(todayInTimezone(new Date('2026-07-01T23:30:00Z'), null)).toEqual({ date: '2026-07-02', dow: 4 })
  })

  it('localToUtc with NO zone now means Europe/Dublin (legacy read the host zone; no caller omits it)', () => {
    expect(localToUtc('2026-07-01', '09:00')?.toISOString()).toBe('2026-07-01T08:00:00.000Z')
    // Host is America/Los_Angeles in this file: the legacy answer was LA's 09:00.
    expect(L.localToUtcLegacy('2026-07-01', '09:00')?.toISOString()).toBe('2026-07-01T16:00:00.000Z')
  })
})
