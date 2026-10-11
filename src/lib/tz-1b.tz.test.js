// tz-1b.tz.test.js — TZ.1b. The three private wall-clock solvers
// (push-reminders localToUtc, checklist-instances parseLocalToUtcMs/tzOffsetMs +
// todayInTimezone, staff-attendance resolveScheduledAt) now delegate to the
// canonical solver in shared/zoned-time.js.
//
// TZ.1b diffed the change against a frozen copy of the pre-change bodies:
// Europe/Dublin identical everywhere, America/New_York and Australia/Sydney
// identical except on the old one-pass error band and the spring-forward gap.
// That byte-identity sweep was retired in TZ.18b. What stays:
//   • Europe/Dublin: pinned by fixed values around both 2026 EU DST changes
//     (zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js).
//   • America/New_York and Australia/Sydney: every quarter-hour of every 2026
//     day reads back as the wall clock asked for, and the spring-forward gap
//     follows the one documented gap rule per module.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test: proves nothing reads the host clock
import { describe, it, expect } from 'vitest'

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

// The three solvers, each reduced to a comparable value (ISO string or null).
const SOLVERS = {
  localToUtc: (d, t, z) => localToUtc(d, t, z)?.toISOString() ?? null,
  resolveScheduledAt: (d, t, z) => resolveScheduledAt(d, t, z)?.toISOString() ?? null,
  computeDeadlineAt: (d, t, z) => computeDeadlineAt([{ block_date: d, end_time: t }], z),
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
// Every quarter-hour slot of 2026 (outside `gap`) whose answer does NOT read
// back as the wall clock asked for, as 'YYYY-MM-DD HH:MM:SS'.
function misreads(name, zone, gap) {
  const out = []
  for (const d of DAYS_2026) {
    for (const t of QUARTERS) {
      const slot = `${d} ${t}`
      if (gap.includes(slot)) continue
      if (wallOf(SOLVERS[name](d, t, zone), zone) !== slot) out.push(slot)
    }
  }
  return out
}
// todayInTimezone at every quarter-hour instant of 2026 that disagrees with the
// zone's own calendar date / weekday.
function todayMisreads(zone) {
  const bad = []
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 15 * 60_000) {
    const at = new Date(ms)
    const date = wallOf(at.toISOString(), zone).slice(0, 10)
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay()
    if (JSON.stringify(todayInTimezone(at, zone)) !== JSON.stringify({ date, dow })) bad.push(at.toISOString())
  }
  return bad
}

describe('TZ.1b Europe/Dublin pinned values', () => {
  it.each(Object.keys(SOLVERS))('%s', (name) => {
    for (const [d, t, expected] of [
      ['2026-01-15', '09:00:00', '2026-01-15T09:00:00.000Z'], // winter (GMT)
      ['2026-07-01', '09:00:00', '2026-07-01T08:00:00.000Z'], // summer (IST)
      ['2026-03-28', '23:30:00', '2026-03-28T23:30:00.000Z'], // eve of spring-forward
      ['2026-03-29', '00:59:00', '2026-03-29T00:59:00.000Z'], // last GMT minute
      ['2026-03-29', '02:00:00', '2026-03-29T01:00:00.000Z'], // first IST hour
      ['2026-10-25', '00:30:00', '2026-10-24T23:30:00.000Z'], // still IST
      ['2026-10-25', '02:00:00', '2026-10-25T02:00:00.000Z'], // GMT again
    ]) expect(SOLVERS[name](d, t, D)).toBe(expected)
  })

  it('todayInTimezone flips at Dublin midnight, across both changes', () => {
    for (const [iso, expected] of [
      ['2026-01-15T23:59:00Z', { date: '2026-01-15', dow: 4 }],
      ['2026-03-28T23:59:00Z', { date: '2026-03-28', dow: 6 }],
      ['2026-03-29T00:00:00Z', { date: '2026-03-29', dow: 0 }],
      ['2026-06-30T22:59:00Z', { date: '2026-06-30', dow: 2 }],
      ['2026-06-30T23:00:00Z', { date: '2026-07-01', dow: 3 }],
      ['2026-10-24T23:00:00Z', { date: '2026-10-25', dow: 0 }],
      ['2026-10-25T23:59:00Z', { date: '2026-10-25', dow: 0 }],
      ['2026-10-26T00:00:00Z', { date: '2026-10-26', dow: 1 }],
    ]) expect(todayInTimezone(new Date(iso), D)).toEqual(expected)
  })

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

  it('a 23:30 checklist deadline on 29 Mar 2026 is 22:30Z', () => {
    expect(computeDeadlineAt([{ block_date: '2026-03-29', end_time: '23:30:00' }], D)).toBe('2026-03-29T22:30:00.000Z')
  })
})

describe('TZ.1b America/New_York: every slot reads back; the gap follows one rule per module', () => {
  const zone = NY
  const GAP = span('2026-03-08', '02:00', '03:00')

  // Before TZ.1b, localToUtc's single pass read the offset on the wrong side of
  // the change for 02:00-06:59 on 8 Mar and 02:00-05:59 on 1 Nov: an hour wrong.
  it.each(Object.keys(SOLVERS))('%s: every quarter-hour of 2026 outside the gap reads back as asked', (name) => {
    expect(misreads(name, zone, GAP)).toEqual([])
  }, 120_000)

  it('inside the old localToUtc error band: 8 Mar 04:00 EDT and 1 Nov 03:00 EST', () => {
    expect(localToUtc('2026-03-08', '04:00:00', zone).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(localToUtc('2026-11-01', '03:00:00', zone).toISOString()).toBe('2026-11-01T08:00:00.000Z')
  })

  it('the gap (8 Mar 02:30, which does not exist) follows one rule per module', () => {
    // Wall clocks resolve EARLIER (01:30 EST), the canonical rule (legacy
    // localToUtc and resolveScheduledAt gave the LATER instant here).
    expect(localToUtc('2026-03-08', '02:30:00', zone).toISOString()).toBe('2026-03-08T06:30:00.000Z')
    expect(resolveScheduledAt('2026-03-08', '02:30:00', zone).toISOString()).toBe('2026-03-08T06:30:00.000Z')
    // A checklist deadline resolves LATER (03:30 EDT), as Dublin's always has
    // (legacy gave the EARLIER instant here, and the LATER one in Dublin).
    expect(computeDeadlineAt([{ block_date: '2026-03-08', end_time: '02:30:00' }], zone)).toBe('2026-03-08T07:30:00.000Z')
  })

  it('the repeated hour (1 Nov 01:30) is unchanged: the FIRST 01:30 (EDT)', () => {
    for (const name of Object.keys(SOLVERS)) {
      expect(SOLVERS[name]('2026-11-01', '01:30:00', zone)).toBe('2026-11-01T05:30:00.000Z')
    }
  })

  it('a 09:00 wall clock is 13:00Z in summer and 14:00Z in winter', () => {
    for (const name of Object.keys(SOLVERS)) {
      expect(SOLVERS[name]('2026-07-01', '09:00:00', zone)).toBe('2026-07-01T13:00:00.000Z')
      expect(SOLVERS[name]('2026-12-01', '09:00:00', zone)).toBe('2026-12-01T14:00:00.000Z')
    }
  })

  it('the day of the week and date flip at New York midnight', () => {
    expect(todayInTimezone(new Date('2026-07-01T03:59:00Z'), zone)).toEqual({ date: '2026-06-30', dow: 2 })
    expect(todayInTimezone(new Date('2026-07-01T04:00:00Z'), zone)).toEqual({ date: '2026-07-01', dow: 3 })
    expect(todayInTimezone(new Date('2026-11-01T04:59:00Z'), zone)).toEqual({ date: '2026-11-01', dow: 0 })
  })

  it("todayInTimezone: every quarter-hour instant of 2026 is New York's own date and weekday", () => {
    expect(todayMisreads(zone)).toEqual([])
  }, 60_000)
})

describe('TZ.1b Australia/Sydney (southern hemisphere, positive offset)', () => {
  const zone = SYD
  const GAP = span('2026-10-04', '02:00', '03:00')
  // Before TZ.1b, localToUtc's single pass was an hour wrong for the 10 local
  // hours before each change (the naive guess sat on the other side of the
  // 16:00Z change).
  it.each(Object.keys(SOLVERS))('%s: every quarter-hour of 2026 outside the gap reads back as asked', (name) => {
    expect(misreads(name, zone, GAP)).toEqual([])
  }, 120_000)
  it('the gap (4 Oct 02:30) and the repeated hour (5 Apr 02:30)', () => {
    // Gap: wall clocks EARLIER (01:30 AEST), a checklist deadline LATER (03:30 AEDT).
    expect(SOLVERS.localToUtc('2026-10-04', '02:30:00', zone)).toBe('2026-10-03T15:30:00.000Z')
    expect(SOLVERS.resolveScheduledAt('2026-10-04', '02:30:00', zone)).toBe('2026-10-03T15:30:00.000Z')
    expect(SOLVERS.computeDeadlineAt('2026-10-04', '02:30:00', zone)).toBe('2026-10-03T16:30:00.000Z')
    // Repeated hour: all three take the SECOND 02:30 (AEST).
    for (const name of Object.keys(SOLVERS)) expect(SOLVERS[name]('2026-04-05', '02:30:00', zone)).toBe('2026-04-04T16:30:00.000Z')
  })
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
    // [solver, date, time, Dublin answer, New York answer]
    ['localToUtc', '2026-02-30', '10:00', '2026-03-02T10:00:00.000Z', '2026-03-02T15:00:00.000Z'], // rolls over
    ['localToUtc', '2026-06-15', '9:5', '2026-06-15T08:05:00.000Z', '2026-06-15T13:05:00.000Z'],
    ['localToUtc', '2026-06-15', '10:00:30', '2026-06-15T09:00:30.000Z', '2026-06-15T14:00:30.000Z'],
    ['localToUtc', 'not-a-date', '10:00', null, null],
    ['localToUtc', '2026-06-15', null, null, null],
    ['localToUtc', null, '10:00', null, null],
    ['resolveScheduledAt', '2026-02-30', '10:00', '2026-03-02T10:00:00.000Z', '2026-03-02T15:00:00.000Z'],
    ['resolveScheduledAt', '2026-06-15', '9:5', '2026-06-15T08:05:00.000Z', '2026-06-15T13:05:00.000Z'],
    ['resolveScheduledAt', '2026-06-15', '10:00:30', '2026-06-15T09:00:30.000Z', '2026-06-15T14:00:30.000Z'],
    ['resolveScheduledAt', '2026-06-15', '10', '2026-06-15T09:00:00.000Z', '2026-06-15T14:00:00.000Z'],
    ['resolveScheduledAt', '2026-06-15', 'x', null, null],
    ['resolveScheduledAt', null, '10:00', null, null],
    ['computeDeadlineAt', '2026-06-15', '10:00:30', '2026-06-15T09:00:30.000Z', '2026-06-15T14:00:30.000Z'],
    ['computeDeadlineAt', '2026-06-15', '10:00', '2026-06-15T09:00:00.000Z', '2026-06-15T14:00:00.000Z'],
    ['computeDeadlineAt', '2026-06-15', '10:00Z', '2026-06-15T09:00:00.000Z', '2026-06-15T14:00:00.000Z'],
    ['computeDeadlineAt', '2026-06-15', '10:00+05:00', '2026-06-15T09:00:00.000Z', '2026-06-15T14:00:00.000Z'],
    ['computeDeadlineAt', '2026-02-30', '10:00', '2026-03-02T10:00:00.000Z', '2026-03-02T15:00:00.000Z'],
    ['computeDeadlineAt', '2026-06-15', '9:5', null, null],
  ])('%s(%s, %s) in Dublin and New York', (name, d, t, dublin, newYork) => {
    expect(SOLVERS[name](d, t, D)).toBe(dublin)
    expect(SOLVERS[name](d, t, NY)).toBe(newYork)
  })

  it('a non-numeric seconds field still throws RangeError from resolveScheduledAt', () => {
    expect(() => resolveScheduledAt('2026-06-15', '10:00:xx', D)).toThrow(RangeError)
  })

  it('a fractional-seconds deadline keeps its milliseconds (legacy smeared them through the offset, to .750)', () => {
    // Legacy read the offset to the whole second, so the dropped .250 came back
    // as a 250 ms error, doubled: .750. Shift times are whole minutes in
    // practice; this is pinned so the one sub-second difference is on record.
    const blocks = [{ block_date: '2026-06-15', end_time: '10:00:30.250' }]
    expect(computeDeadlineAt(blocks, D)).toBe('2026-06-15T09:00:30.250Z')
  })

  it('an invalid zone: localToUtc returns null, the others throw RangeError, as before', () => {
    for (const z of ['Not/AZone', '']) {
      expect(localToUtc('2026-06-15', '10:00', z)).toBeNull()
    }
    expect(() => resolveScheduledAt('2026-06-15', '10:00', 'Not/AZone')).toThrow(RangeError)
    expect(() => todayInTimezone(new Date(), 'Not/AZone')).toThrow(RangeError)
    const blocks = [{ block_date: '2026-06-15', end_time: '10:00' }]
    expect(() => computeDeadlineAt(blocks, 'Not/AZone')).toThrow(RangeError)
  })

  it('the zone defaults are unchanged: resolveScheduledAt UTC; checklist Europe/Dublin', () => {
    expect(resolveScheduledAt('2026-07-01', '09:00').toISOString()).toBe('2026-07-01T09:00:00.000Z')
    expect(computeDeadlineAt([{ block_date: '2026-07-01', end_time: '09:00' }], null)).toBe('2026-07-01T08:00:00.000Z')
    expect(todayInTimezone(new Date('2026-07-01T23:30:00Z'), null)).toEqual({ date: '2026-07-02', dow: 4 })
  })

  it('localToUtc with NO zone now means Europe/Dublin (legacy read the host zone; no caller omits it)', () => {
    expect(localToUtc('2026-07-01', '09:00')?.toISOString()).toBe('2026-07-01T08:00:00.000Z')
    // Host is America/Los_Angeles in this file: the legacy answer was LA's 09:00 (16:00Z).
  })
})
