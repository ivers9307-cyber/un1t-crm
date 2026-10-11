// tz-17.dublin.test.js — TZ.17 ⚠️ (approved by Richard, 11 Oct 2026).
//
// TZ.17 corrects dates that were computed on the UTC day (or the host clock,
// which is UTC on Vercel) instead of the studio's or the member's day. For a
// Europe/Dublin studio that changes ONLY:
//   • 00:00-01:00 Irish summer time, where "today" (the week, the month) is now
//     the studio's rather than the UTC one, and
//   • a 23:xx timetable slot on the spring-forward day (29 Mar 2026), which no
//     longer lands a day late, and a 01:xx slot on the fall-back day (25 Oct
//     2026, when 01:xx happens twice), which now resolves to the same (GMT)
//     01:xx as every other wall clock in the platform;
//   • the deposit-link expiry note, which printed UTC: it is Dublin time now
//     (an hour later on the note all summer).
// (`{{current_year}}` is unchanged for Dublin: Dublin is on GMT at New Year.)
//
// This file runs on a UTC host clock (what Vercel runs). TZ.17 proved, against
// a frozen copy of the pre-change code, that Dublin output was identical at
// every instant outside those windows; that comparison was retired in TZ.18b.
// What stays: the corrected answers inside the windows (e.g. 2026-07-01T23:30Z,
// 00:30 IST on 2 Jul, is 2026-07-02 / July) as fixed values, and Dublin pinned
// by fixed values around both 2026 EU DST changes. zoned-time ≡ dublin-time
// stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'UTC'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }))
vi.mock('@/components/ui', () => ({ Button: () => null, Field: () => null }))
vi.mock('lucide-react', () => ({ AlertCircle: () => null }))

const { flowClassDay } = await import('./whatsapp-flow/handler.js')
const { eventReminderWindow } = await import('./sequences/cron-triggers.js')
const { toDateInput } = await import('@/components/ConsultationForm.jsx')
const { zonedDateString } = await import('./agent/approval-suggest.js')
const goals = await import('./goals.js')
const PA = await import('@shared/progress-analytics')
const { manualClassOccurrences } = await import('./manual-timetable.js')
const { createdAtWindow } = await import('./ads/attribution.js')
const { applyMergeTags } = await import('./postmark.js')
const cars = await import('./cars.js')
const { stravaTitleDate } = await import('./external-export.js')
const { streakCandidateWindow } = await import('./nudge-windows.js')
const { challengeDaysLeft } = await import('../../mobile/lib/member/challenge-countdown.js')
const { idleBoardClock } = await import('./tv-board-time.js')
const Z = await import('@/lib/location-time')
const { allowanceYearIn } = await import('./allowance-year.js')

const D = 'Europe/Dublin'
const H = 3600_000
const DAY = 24 * H
const ms = (iso) => Date.parse(iso)
const iso = (t) => new Date(t).toISOString()
const MIDNIGHT_IST = ms('2026-07-01T23:30:00Z') // 00:30 IST, Thu 2 Jul 2026

// The one window TZ.17 moves for Dublin: the Dublin day differs from the UTC day.
const inMidnightHour = (t) => Z.dayStrIn(t, D) !== iso(t).slice(0, 10)
// Every hour of 2026 (on the half hour, plus every DST-edge minute).
const HOURS = []
for (let t = ms('2026-01-01T00:30:00Z'); t < ms('2027-01-01T00:00:00Z'); t += H) HOURS.push(t)
HOURS.push(...['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z'].map(ms))

// The Dublin pins: 23:30 GMT on a winter night; 23:30 GMT the night before the
// spring-forward; 23:30 IST and 00:30 IST (Mon) either side of the first IST
// midnight; 00:30 IST on the fall-back Sunday; 23:30 GMT that same Sunday; a
// summer noon.
const PINS = [
  '2026-01-15T23:30:00Z', '2026-03-28T23:30:00Z', '2026-03-29T22:30:00Z', '2026-03-29T23:30:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T23:30:00Z', '2026-07-01T12:00:00Z',
]
const PIN_DAYS = ['2026-01-15', '2026-03-28', '2026-03-29', '2026-03-30', '2026-10-25', '2026-10-25', '2026-07-01']

describe('the window itself', () => {
  it('is exactly 23:00-24:00 UTC during Irish summer time', () => {
    expect(inMidnightHour(MIDNIGHT_IST)).toBe(true)
    expect(inMidnightHour(ms('2026-07-01T22:59:00Z'))).toBe(false)
    expect(inMidnightHour(ms('2026-07-02T00:00:00Z'))).toBe(false)
    expect(inMidnightHour(ms('2026-01-15T23:30:00Z'))).toBe(false) // GMT: no window
    const inside = HOURS.filter(inMidnightHour)
    expect(inside.length).toBeGreaterThan(200) // one hour on each IST day of 2026
    for (const t of inside) expect(new Date(t).getUTCHours()).toBe(23)
  })
})

describe('WhatsApp Flow — a class sits under its studio day', () => {
  const cls = (t) => ({ starts_at: iso(t), day: Z.dayStrIn(t, D) }) // public-classes' shape (TZ.7)
  it('Dublin pinned values', () => {
    expect(PINS.map((t) => flowClassDay(cls(ms(t))))).toEqual(PIN_DAYS)
    expect(flowClassDay({ starts_at: '2026-03-29T23:30:00Z' })).toBe('2026-03-29') // an older payload with no day
  })
  it('00:30 IST on 2 Jul is a 2 Jul class (it was listed under 1 Jul)', () => {
    expect(flowClassDay(cls(MIDNIGHT_IST))).toBe('2026-07-02')
  })
})

describe('event_reminder — a booking is its studio wall clock', () => {
  const wall = (t) => { const p = Z.instantToZonedParts(t, D); return { booking_date: p.dateKey, start_time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}:00` } }
  const matchesNew = (nowMs, hb, b) => {
    const w = eventReminderWindow(nowMs, hb, D)
    const bMs = Z.zonedWallClockToInstant(b.booking_date, b.start_time, D)
    return b.booking_date >= w.loDay && b.booking_date <= w.hiDay && bMs >= w.loMs && bMs <= w.hiMs
  }
  it('Dublin pinned values: a 24h reminder matches 23-25h before the real start, in GMT, IST and on both change days', () => {
    for (const start of ['2026-01-15T18:00:00Z', '2026-03-29T17:00:00Z', '2026-03-30T00:30:00Z', '2026-10-25T18:00:00Z'].map(ms)) {
      const b = wall(start)
      expect([-25 * H - 60_000, -25 * H, -24 * H, -23 * H, -23 * H + 60_000].map((o) => matchesNew(start + o, 24, b))).toEqual([false, true, true, true, false])
    }
    expect(wall(ms('2026-03-29T17:00:00Z'))).toEqual({ booking_date: '2026-03-29', start_time: '18:00:00' })
    expect(eventReminderWindow(ms('2026-10-24T18:00:00Z'), 24, D)).toEqual({ loMs: ms('2026-10-25T17:00:00Z'), hiMs: ms('2026-10-25T19:00:00Z'), loDay: '2026-10-25', hiDay: '2026-10-25' })
  })
  it('summer: a 24h reminder now matches 23-25h before the REAL start (it matched 22-24h)', () => {
    const start = ms('2026-07-03T17:00:00Z') // 18:00 IST
    const b = wall(start)
    expect(matchesNew(start - 25 * H, 24, b)).toBe(true)
    expect(matchesNew(start - 22 * H - 60_000, 24, b)).toBe(false)
  })
  it("a 00:30 IST booking is in its studio day's pre-filter", () => {
    const w = eventReminderWindow(MIDNIGHT_IST - 2 * H, 2, D)
    expect([w.loDay, w.hiDay]).toEqual(['2026-07-01', '2026-07-02'])
  })
})

describe("ConsultationForm — an existing consultation's day", () => {
  it('Dublin pinned values', () => {
    expect(PINS.map((t) => toDateInput(t, D))).toEqual(PIN_DAYS)
  })
  it('rows the form saved (12:00 UTC anchors) show the same day for every date', () => {
    for (let t = ms('2026-01-01T12:00:00Z'); t < ms('2027-01-01T00:00:00Z'); t += DAY) {
      expect(toDateInput(iso(t), D)).toBe(iso(t).slice(0, 10))
    }
  })
  it('00:30 IST on 2 Jul shows 2 Jul (it showed 1 Jul)', () => {
    expect(toDateInput(iso(MIDNIGHT_IST), D)).toBe('2026-07-02')
  })
})

describe("approval suggestion — the prompt's today", () => {
  it('Dublin pinned values', () => {
    expect(PINS.map((t) => zonedDateString(ms(t), D))).toEqual([
      'Thu Jan 15 2026', 'Sat Mar 28 2026', 'Sun Mar 29 2026', 'Mon Mar 30 2026',
      'Sun Oct 25 2026', 'Sun Oct 25 2026', 'Wed Jul 01 2026',
    ])
  })
  it('00:30 IST on 2 Jul is Thu Jul 02 2026 (it was Wed Jul 01 2026)', () => {
    expect(zonedDateString(MIDNIGHT_IST, D)).toBe('Thu Jul 02 2026')
  })
})

describe('goals (web) — weeks and months on the member calendar', () => {
  it('Dublin pinned values: the week and month start at Dublin midnight', () => {
    expect(PINS.map((t) => goals.startOfIsoWeek(new Date(t), D).toISOString())).toEqual([
      '2026-01-12T00:00:00.000Z', '2026-03-23T00:00:00.000Z', '2026-03-23T00:00:00.000Z', '2026-03-29T23:00:00.000Z',
      '2026-10-18T23:00:00.000Z', '2026-10-18T23:00:00.000Z', '2026-06-28T23:00:00.000Z',
    ])
    expect(PINS.map((t) => goals.startOfMonth(new Date(t), D).toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
      '2026-09-30T23:00:00.000Z', '2026-09-30T23:00:00.000Z', '2026-06-30T23:00:00.000Z',
    ])
    // 23:30 IST Sun 29 Mar is last week; 00:30 IST Mon 30 Mar is this week.
    const spring = [{ started_at: '2026-03-29T22:30:00Z', effort_points: 20 }, { started_at: '2026-03-29T23:30:00Z', effort_points: 30 }]
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 100 }, spring, new Date('2026-03-30T12:00:00Z'), D).current).toBe(30)
    // On 1 Nov, 00:30 GMT Sun 1 Nov counts toward November; 23:30 GMT Sat 31 Oct does not.
    const autumn = [{ started_at: '2026-10-31T23:30:00Z', effort_points: 20 }, { started_at: '2026-11-01T00:30:00Z', effort_points: 30 }]
    expect(goals.computeProgress({ kind: 'monthly_points', target_value: 100 }, autumn, new Date('2026-11-01T12:00:00Z'), D).current).toBe(30)
  })
  it('a session at 00:30 IST on Monday 6 Jul counts in that week and month (it fell to the week before)', () => {
    const s = [{ started_at: '2026-07-05T23:30:00Z', effort_points: 50 }]
    const now = new Date('2026-07-06T12:00:00Z')
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 100 }, s, now, D).current).toBe(50)
    const july = new Date('2026-07-01T12:00:00Z')
    const firstOfJuly = [{ started_at: '2026-06-30T23:30:00Z', effort_points: 40 }] // 00:30 IST 1 Jul
    expect(goals.computeProgress({ kind: 'monthly_points', target_value: 100 }, firstOfJuly, july, D).current).toBe(40)
  })
  it('at 00:30 IST on Mon 6 Jul, last week is over (the UTC week still counted it)', () => {
    const lastWeek = [{ started_at: '2026-07-04T10:00:00Z', effort_points: 70 }] // Sat
    const now = new Date('2026-07-05T23:30:00Z')
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 100 }, lastWeek, now, D).current).toBe(0)
  })
  it('at 00:30 IST on 2 Jul the month is July', () => {
    expect(goals.startOfMonth(new Date(MIDNIGHT_IST), D).toISOString()).toBe('2026-06-30T23:00:00.000Z')
  })
})

describe('progress analytics (phone OTA + champ-app) — weeks and months on the member calendar', () => {
  it('Dublin pinned values: weeklyBuckets, monthlyRecap and the best week around both EU clock changes', () => {
    const s = [
      '2026-03-29T22:30:00Z', // 23:30 IST Sun 29 Mar: week of 23 Mar, March
      '2026-03-29T23:30:00Z', // 00:30 IST Mon 30 Mar: week of 30 Mar
      '2026-10-24T23:30:00Z', // 00:30 IST Sun 25 Oct: week of 19 Oct
      '2026-10-25T23:30:00Z', // 23:30 GMT Sun 25 Oct: week of 19 Oct
      '2026-10-26T00:30:00Z', // 00:30 GMT Mon 26 Oct: week of 26 Oct
      '2026-03-31T23:30:00Z', // 00:30 IST Wed 1 Apr: week of 30 Mar, April
    ].map((t, i) => ({ started_at: t, ended_at: iso(ms(t) + 45 * 60_000), effort_points: 10 * (i + 1), id: `s${i}` }))
    const now = ms('2026-11-04T12:00:00Z')
    expect(PA.weeklyBuckets(s, now, 33, D).filter((b) => b.count).map((b) => [b.label, b.count, b.points]))
      .toEqual([['23 Mar', 1, 10], ['30 Mar', 2, 80], ['19 Oct', 2, 70], ['26 Oct', 1, 50]])
    expect(PA.monthlyRecap(s, now, 9, D).months.filter((m) => m.count).map((m) => [m.label, m.count]))
      .toEqual([['Mar 2026', 2], ['Apr 2026', 1], ['Oct 2026', 3]])
    expect(PA.personalRecords(s, D).bestWeekPoints).toStrictEqual({ value: 80, weekStartMs: ms('2026-03-30T00:00:00Z') }) // a date anchor, rendered in UTC
  })
  it('a session at 00:30 IST on Monday 6 Jul is in the week of 6 Jul (it was in the week of 29 Jun)', () => {
    const s = [{ started_at: '2026-07-05T23:30:00Z', ended_at: '2026-07-06T00:15:00Z', effort_points: 30 }]
    const now = ms('2026-07-08T12:00:00Z')
    const w = PA.weeklyBuckets(s, now, 2, D)
    expect(w.map((b) => [b.label, b.count])).toEqual([['29 Jun', 0], ['6 Jul', 1]])
    expect(PA.personalRecords(s, D).bestWeekPoints.weekStartMs).toBe(ms('2026-07-06T00:00:00Z')) // a date anchor, rendered in UTC
  })
  it('a session at 00:30 IST on 2 Jul... and at 00:30 IST on 1 Jul, is a July session', () => {
    const s = [{ started_at: '2026-06-30T23:30:00Z', ended_at: '2026-07-01T00:15:00Z', effort_points: 30 }]
    const julyRecap = PA.monthlyRecap(s, ms('2026-07-15T12:00:00Z'), 2, D).months
    expect(julyRecap.map((m) => [m.label, m.count])).toEqual([['Jun 2026', 0], ['Jul 2026', 1]])
    // and at 00:30 IST on 1 Jul the recap's current month is already July
    expect(PA.monthlyRecap([], ms('2026-06-30T23:30:00Z'), 1, D).months[0].label).toBe('Jul 2026')
  })
})

describe('manual timetable — the canonical solver', () => {
  const at = (dow, time) => ({ dow, time, name: 'Class' })
  it('Dublin pinned values: wall clocks on both change days, summer and winter', () => {
    const w = (day, time) => iso(Z.zonedWallClockToInstant(day, time, D))
    expect(w('2026-03-29', '00:30')).toBe('2026-03-29T00:30:00.000Z') // GMT
    expect(w('2026-03-29', '02:00')).toBe('2026-03-29T01:00:00.000Z') // IST, the first IST minute
    expect(w('2026-10-25', '00:30')).toBe('2026-10-24T23:30:00.000Z') // IST
    expect(w('2026-10-25', '02:30')).toBe('2026-10-25T02:30:00.000Z') // GMT
    expect(w('2026-07-06', '06:30')).toBe('2026-07-06T05:30:00.000Z')
    expect(w('2026-01-15', '09:00')).toBe('2026-01-15T09:00:00.000Z')
  })
  // Two Dublin changes, both on a clock-change Sunday: a 23:xx slot on the
  // spring-forward day no longer lands a day late, and a 01:xx slot on the
  // fall-back day (01:xx happens twice) now resolves to the GMT 01:xx, as
  // every other Dublin wall clock in the platform does (zonedWallClockToInstant);
  // the one-pass solver took the IST 01:xx.
  it('01:30 on 25 Oct is the GMT 01:30 (the pre-TZ.17 solver took the IST one, 00:30Z)', () => {
    expect(iso(Z.zonedWallClockToInstant('2026-10-25', '01:30', D))).toBe('2026-10-25T01:30:00.000Z')
    const out = manualClassOccurrences({ slots: [at(1, '06:30'), at(7, '01:30'), at(7, '23:45')], now: ms('2026-10-19T00:00:00Z'), minNoticeHours: 0, days: 7, zone: D })
    expect(out.map((c) => [c.day, c.time, c.starts_at])).toEqual([
      ['2026-10-19', '06:30', '2026-10-19T05:30:00.000Z'],
      ['2026-10-25', '01:30', '2026-10-25T01:30:00.000Z'],
      ['2026-10-25', '23:45', '2026-10-25T23:45:00.000Z'],
    ])
  })
  it('the 23:15 Sunday class on 29 Mar is listed on 29 Mar at 22:15Z (it showed a day late)', () => {
    const out = manualClassOccurrences({ slots: [at(7, '23:15')], now: ms('2026-03-29T06:00:00Z'), minNoticeHours: 0, days: 1, zone: D })
    expect(out.map((c) => [c.day, c.starts_at])).toEqual([['2026-03-29', '2026-03-29T22:15:00.000Z']])
  })
  it('every slot of a normal summer week lands on its Dublin wall clock', () => {
    const SLOTS = []
    for (let dow = 1; dow <= 7; dow++) for (let m = 0; m < 24 * 60; m += 15) SLOTS.push(at(dow, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`))
    const out = manualClassOccurrences({ slots: SLOTS, now: ms('2026-07-06T00:00:00Z'), minNoticeHours: 0, days: 7, zone: D })
    for (const c of out) expect(c.starts_at).toBe(iso(Z.zonedWallClockToInstant(c.day, c.time, D)))
    const pick = (day, time) => out.find((c) => c.day === day && c.time === time)?.starts_at
    expect(pick('2026-07-06', '06:30')).toBe('2026-07-06T05:30:00.000Z')
    expect(pick('2026-07-12', '23:45')).toBe('2026-07-12T22:45:00.000Z')
  })
})

describe('ads dashboard — booked requests by the dashboard day', () => {
  it('Dublin pinned values: the window runs Dublin midnight to Dublin midnight', () => {
    expect(createdAtWindow('2026-06-10', '2026-07-09', D)).toEqual({ startIso: '2026-06-09T23:00:00.000Z', endIso: '2026-07-09T23:00:00.000Z' })
    expect(createdAtWindow('2026-01-10', '2026-02-09', D)).toEqual({ startIso: '2026-01-10T00:00:00.000Z', endIso: '2026-02-10T00:00:00.000Z' })
    expect(createdAtWindow('2026-03-01', '2026-03-31', D)).toEqual({ startIso: '2026-03-01T00:00:00.000Z', endIso: '2026-03-31T23:00:00.000Z' })
    expect(createdAtWindow('2026-10-01', '2026-10-31', D)).toEqual({ startIso: '2026-09-30T23:00:00.000Z', endIso: '2026-11-01T00:00:00.000Z' })
    expect(PINS.map((t) => Z.dateKeyIn(t, D))).toEqual(PIN_DAYS)
  })
  it('a request at 00:30 IST on 2 Jul is a 2 Jul booking (it was 1 Jul)', () => {
    expect(Z.dateKeyIn(iso(MIDNIGHT_IST), D)).toBe('2026-07-02')
  })
})

describe('{{current_year}} — unchanged for Dublin', () => {
  it('Dublin is on GMT at New Year, so the year flips at UTC midnight', () => {
    for (const [t, year] of [['2026-12-31T23:59:00Z', '2026'], ['2027-01-01T00:00:00Z', '2027'], ['2027-01-01T00:30:00Z', '2027'], [iso(MIDNIGHT_IST), '2026']]) {
      vi.useFakeTimers(); vi.setSystemTime(ms(t))
      try {
        expect(applyMergeTags('{{current_year}}', {}, { zone: D })).toBe(year)
        expect(applyMergeTags('{{current_year}}', {})).toBe(year)
      } finally { vi.useRealTimers() }
    }
  })
})

describe('cars reports — the studio calendar', () => {
  it('Dublin pinned values: YTD start and the 12 monthly keys/labels', () => {
    expect(cars.carsYearStartIso(ms('2026-07-15T12:00:00Z'), D)).toBe('2026-01-01T00:00:00.000Z')
    expect(cars.carsYearStartIso(ms('2026-01-01T00:30:00Z'), D)).toBe('2026-01-01T00:00:00.000Z')
    expect(cars.carsYearStartIso(ms('2025-12-31T23:30:00Z'), D)).toBe('2025-01-01T00:00:00.000Z')
    const months = cars.computeReportMetrics([], { now: new Date('2026-07-15T12:00:00Z'), zone: D }).monthlyPerformance.map((b) => [b.key, b.label])
    expect(months).toHaveLength(12)
    expect([months[0], months[11]]).toEqual([['2025-08', 'Aug 25'], ['2026-07', 'Jul 26']])
    const jan = cars.computeReportMetrics([], { now: new Date('2026-01-01T00:30:00Z'), zone: D }).monthlyPerformance.map((b) => b.key)
    expect([jan[0], jan[11]]).toEqual(['2025-02', '2026-01'])
  })
  it('a car completed 00:30 IST on 1 Jul is a July car (it was June)', () => {
    const car = { status: 'completed', completed_at: '2026-06-30T23:30:00Z', created_at: '2026-06-01T10:00:00Z' }
    const m = cars.computeReportMetrics([car], { now: new Date('2026-07-15T12:00:00Z'), zone: D })
    const byKey = Object.fromEntries(m.monthlyPerformance.map((b) => [b.key, b.completedCount]))
    expect([byKey['2026-06'], byKey['2026-07']]).toEqual([0, 1])
  })
  it('the deposit expiry note shows Dublin time (it showed UTC): changes for every IST instant', () => {
    expect(cars.depositExpiryLabel('2026-01-15T14:30:00Z', D)).toBe('15/1/2026, 14:30:00')
    expect(cars.depositExpiryLabel('2026-07-15T14:30:00Z', D)).toBe('15/7/2026, 15:30:00')
    expect(cars.depositExpiryLabel('2026-10-25T00:30:00Z', D)).toBe('25/10/2026, 01:30:00') // IST 01:30
    expect(cars.depositExpiryLabel('2026-10-25T01:30:00Z', D)).toBe('25/10/2026, 01:30:00') // GMT 01:30
  })
})

describe('Strava title — the session day', () => {
  it('Dublin pinned values', () => {
    expect(PINS.map((t) => stravaTitleDate(t, D))).toEqual(['15/1/2026', '28/3/2026', '29/3/2026', '30/3/2026', '25/10/2026', '25/10/2026', '1/7/2026'])
  })
  it('00:30 IST on 2 Jul is 2/7/2026 (it was 1/7/2026)', () => {
    expect(stravaTitleDate(iso(MIDNIGHT_IST), D)).toBe('2/7/2026')
  })
})

describe("streak-at-risk — the studio's yesterday", () => {
  const slotAt = (t) => ({ day: Z.dayStrIn(t, D), zone: D })
  it('the dedup key at the Dublin slot (11:00 UTC) is the slot date, every day of 2026', () => {
    for (let t = ms('2026-01-01T11:00:00Z'); t < ms('2027-01-01T00:00:00Z'); t += DAY) {
      expect(streakCandidateWindow(slotAt(t)).dedupKey).toBe(iso(t).slice(0, 10))
    }
  })
  it('Dublin pinned values: yesterday is the Dublin day, 23 or 25 hours long after a clock change', () => {
    const w = (t) => { const x = streakCandidateWindow(slotAt(ms(t))); return [iso(x.yestMs), iso(x.todayMs)] }
    expect(w('2026-01-15T11:00:00Z')).toEqual(['2026-01-14T00:00:00.000Z', '2026-01-15T00:00:00.000Z'])
    expect(w('2026-03-30T11:00:00Z')).toEqual(['2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z']) // 23 h
    expect(w('2026-10-25T11:00:00Z')).toEqual(['2026-10-23T23:00:00.000Z', '2026-10-24T23:00:00.000Z'])
    expect(w('2026-10-26T11:00:00Z')).toEqual(['2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z']) // 25 h
  })
  it('summer: the window is the Dublin yesterday (an hour earlier than the UTC one)', () => {
    const jul = ms('2026-07-02T11:00:00Z')
    const w = streakCandidateWindow(slotAt(jul))
    expect([iso(w.yestMs), iso(w.todayMs)]).toEqual(['2026-06-30T23:00:00.000Z', '2026-07-01T23:00:00.000Z'])
    // 00:30 IST on 2 Jul is today, not yesterday (the UTC window counted it)
    expect(MIDNIGHT_IST >= w.yestMs && MIDNIGHT_IST < w.todayMs).toBe(false)
  })
})

describe('TV gym board — the month', () => {
  it('Dublin: from 00:00 GMT on the 1st in GMT months; from 00:00 IST on the 1st in IST months', () => {
    expect(iso(Z.monthStartMsIn(ms('2026-01-15T12:00:00Z'), D))).toBe('2026-01-01T00:00:00.000Z')
    expect(iso(Z.monthStartMsIn(ms('2026-03-31T22:30:00Z'), D))).toBe('2026-03-01T00:00:00.000Z') // 23:30 IST 31 Mar
    expect(iso(Z.monthStartMsIn(ms('2026-03-31T23:30:00Z'), D))).toBe('2026-03-31T23:00:00.000Z') // 00:30 IST 1 Apr
    expect(iso(Z.monthStartMsIn(ms('2026-10-31T23:30:00Z'), D))).toBe('2026-09-30T23:00:00.000Z') // 23:30 GMT 31 Oct
    expect(iso(Z.monthStartMsIn(ms('2026-11-01T00:30:00Z'), D))).toBe('2026-11-01T00:00:00.000Z')
    expect(iso(Z.monthStartMsIn(MIDNIGHT_IST, D))).toBe('2026-06-30T23:00:00.000Z')
  })
})

describe('member home — the challenge countdown (phone OTA)', () => {
  it('Dublin pinned values', () => {
    expect(challengeDaysLeft('2026-03-29', ms('2026-03-28T23:30:00Z'), D)).toBe(1)
    expect(challengeDaysLeft('2026-03-30', ms('2026-03-29T23:30:00Z'), D)).toBe(0) // 00:30 IST Mon 30 Mar
    expect(challengeDaysLeft('2026-10-25', ms('2026-10-24T23:30:00Z'), D)).toBe(0) // 00:30 IST Sun 25 Oct
    expect(challengeDaysLeft('2026-10-26', ms('2026-10-25T23:30:00Z'), D)).toBe(1) // 23:30 GMT Sun 25 Oct
    expect(challengeDaysLeft('2026-01-20', ms('2026-01-15T12:00:00Z'), D)).toBe(5)
    expect(challengeDaysLeft('2026-01-14', ms('2026-01-15T12:00:00Z'), D)).toBe(-1)
  })
  it('00:30 IST on 2 Jul: a challenge ending 2 Jul ends today (it said tomorrow)', () => {
    expect(challengeDaysLeft('2026-07-02', MIDNIGHT_IST, D)).toBe(0)
    expect(challengeDaysLeft(null, MIDNIGHT_IST, D)).toBeNull()
  })
})

describe('cast board — no server-rendered clock', () => {
  it('before mount (now = null) the idle clock is empty; after, it is the studio clock as before', () => {
    expect(idleBoardClock(null, D)).toEqual({ hh: '', mm: '', day: '' })
    expect(idleBoardClock(null, null)).toEqual({ hh: '', mm: '', day: '' })
    expect(idleBoardClock(new Date(MIDNIGHT_IST), D)).toMatchObject({ hh: '00', mm: '30' })
  })
})

describe("the studio's today and month (today feed, live-class target banner)", () => {
  it('the feed uses the studio day: 00:30 IST on 2 Jul is 2 Jul (the UTC host said 1 Jul)', () => {
    expect(Z.todayStrIn(D, MIDNIGHT_IST)).toBe('2026-07-02')
    expect(PINS.map((t) => Z.todayStrIn(D, ms(t)))).toEqual(PIN_DAYS)
  })
  it('live-class target-hit month: the banked month is the Dublin month', () => {
    expect(Z.monthKeyIn(ms('2026-06-30T23:30:00Z'), D)).toBe('2026-07') // the UTC host said June
    expect(Z.monthKeyIn(ms('2026-03-31T22:30:00Z'), D)).toBe('2026-03')
    expect(Z.monthKeyIn(ms('2026-03-31T23:30:00Z'), D)).toBe('2026-04')
    expect(Z.monthKeyIn(ms('2026-10-31T23:30:00Z'), D)).toBe('2026-10')
    expect(Z.monthKeyIn(ms('2026-12-31T23:59:00Z'), D)).toBe('2026-12')
    expect(Z.monthKeyIn(ms('2027-01-01T00:00:00Z'), D)).toBe('2027-01')
  })
})

describe('time-off allowance year (TimeOffManager) — the studio year', () => {
  it('Dublin: the same year the browser clock gave a Dublin viewer, at every hour and across New Year', () => {
    const legacyDublinBrowser = (t) => Number(Z.dayStrIn(t, D).slice(0, 4)) // new Date().getFullYear() in a Dublin browser
    for (const t of [...HOURS, ms('2026-12-31T23:59:00Z'), ms('2027-01-01T00:00:00Z')]) expect(allowanceYearIn(D, t)).toBe(legacyDublinBrowser(t))
  })
})
