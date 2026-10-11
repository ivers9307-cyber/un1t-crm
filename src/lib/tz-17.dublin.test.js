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
// This file runs on a UTC host clock (what Vercel runs) and proves both halves
// against the FROZEN pre-change code (tz-17.legacy-dublin.test-helpers.js):
//   1. at every instant OUTSIDE those windows, Dublin output is identical;
//   2. at 2026-07-01T23:30:00Z (00:30 IST on 2 Jul) the Dublin answer is the
//      corrected one (2026-07-02 / July), which the old code got wrong.
process.env.TZ = 'UTC'
import { describe, it, expect, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }))
vi.mock('@/components/ui', () => ({ Button: () => null, Field: () => null }))
vi.mock('lucide-react', () => ({ AlertCircle: () => null }))

const L = await import('./tz-17.legacy-dublin.test-helpers.js')
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

const D = 'Europe/Dublin'
const H = 3600_000
const DAY = 24 * H
const ms = (iso) => Date.parse(iso)
const iso = (t) => new Date(t).toISOString()
const MIDNIGHT_IST = ms('2026-07-01T23:30:00Z') // 00:30 IST, Thu 2 Jul 2026

// The one window TZ.17 moves for Dublin: the Dublin day differs from the UTC day.
const inMidnightHour = (t) => Z.dayStrIn(t, D) !== iso(t).slice(0, 10)
// Every hour of 2026 (on the half hour, plus every DST-edge minute), and the subset outside the window.
const HOURS = []
for (let t = ms('2026-01-01T00:30:00Z'); t < ms('2027-01-01T00:00:00Z'); t += H) HOURS.push(t)
HOURS.push(...['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z'].map(ms))
const OUTSIDE = HOURS.filter((t) => !inMidnightHour(t))
// Instants that start a Dublin week or month inside the window move their bucket too.
const PERIOD_EDGE = (t) => inMidnightHour(t)

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
  it('Dublin, outside the window: the same day as before', () => {
    for (const t of OUTSIDE) expect(flowClassDay(cls(t))).toBe(L.flowClassDayLegacy(cls(t)))
  })
  it('00:30 IST on 2 Jul is a 2 Jul class (it was listed under 1 Jul)', () => {
    expect(flowClassDay(cls(MIDNIGHT_IST))).toBe('2026-07-02')
    expect(L.flowClassDayLegacy(cls(MIDNIGHT_IST))).toBe('2026-07-01')
  })
})

describe('event_reminder — a booking is its studio wall clock', () => {
  const wall = (t) => { const p = Z.instantToZonedParts(t, D); return { booking_date: p.dateKey, start_time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}:00` } }
  const matchesNew = (nowMs, hb, b) => {
    const w = eventReminderWindow(nowMs, hb, D)
    const bMs = Z.zonedWallClockToInstant(b.booking_date, b.start_time, D)
    return b.booking_date >= w.loDay && b.booking_date <= w.hiDay && bMs >= w.loMs && bMs <= w.hiMs
  }
  it('winter (GMT): identical to before at every tick of a week, for every booking hour', () => {
    for (let now = ms('2026-01-12T00:00:00Z'); now < ms('2026-01-19T00:00:00Z'); now += 5 * 60_000 * 7) {
      for (let k = 0; k < 48; k++) {
        const b = wall(now + k * H)
        expect(matchesNew(now, 24, b)).toBe(L.eventReminderLegacy(now, 24, b).matches)
      }
    }
  })
  it('summer: a 24h reminder now matches 23-25h before the REAL start (it matched 22-24h)', () => {
    const start = ms('2026-07-03T17:00:00Z') // 18:00 IST
    const b = wall(start)
    expect(matchesNew(start - 25 * H, 24, b)).toBe(true)
    expect(L.eventReminderLegacy(start - 25 * H, 24, b).matches).toBe(false)
    expect(matchesNew(start - 22 * H - 60_000, 24, b)).toBe(false)
    expect(L.eventReminderLegacy(start - 22 * H - 60_000, 24, b).matches).toBe(true)
  })
  it("a 00:30 IST booking is in its studio day's pre-filter", () => {
    const w = eventReminderWindow(MIDNIGHT_IST - 2 * H, 2, D)
    expect([w.loDay, w.hiDay]).toEqual(['2026-07-01', '2026-07-02'])
  })
})

describe("ConsultationForm — an existing consultation's day", () => {
  it('Dublin, outside the window: the same day as before', () => {
    for (const t of OUTSIDE) expect(toDateInput(iso(t), D)).toBe(L.toDateInputLegacy(iso(t), D))
  })
  it('rows the form saved (12:00 UTC anchors) show the same day for every date', () => {
    for (let t = ms('2026-01-01T12:00:00Z'); t < ms('2027-01-01T00:00:00Z'); t += DAY) {
      expect(toDateInput(iso(t), D)).toBe(iso(t).slice(0, 10))
    }
  })
  it('00:30 IST on 2 Jul shows 2 Jul (it showed 1 Jul)', () => {
    expect(toDateInput(iso(MIDNIGHT_IST), D)).toBe('2026-07-02')
    expect(L.toDateInputLegacy(iso(MIDNIGHT_IST), D)).toBe('2026-07-01')
  })
})

describe("approval suggestion — the prompt's today", () => {
  it('Dublin, outside the window: byte-identical to Date#toDateString on the UTC host', () => {
    for (const t of OUTSIDE) expect(zonedDateString(t, D)).toBe(L.approvalTodayLegacy(t))
  })
  it('00:30 IST on 2 Jul is Thu Jul 02 2026 (it was Wed Jul 01 2026)', () => {
    expect(zonedDateString(MIDNIGHT_IST, D)).toBe('Thu Jul 02 2026')
    expect(L.approvalTodayLegacy(MIDNIGHT_IST)).toBe('Wed Jul 01 2026')
  })
})

// A member's sessions: one at 18:00 UTC on each of the 120 days before `now`.
const sessionsBefore = (now, extra = []) => {
  const out = []
  for (let i = 0; i < 120; i++) {
    const t = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() - i, 18)
    if (t < now) out.push({ started_at: iso(t), ended_at: iso(t + 45 * 60_000), effort_points: 10 + (i % 7), peak_hr_bpm: 150 + (i % 20), id: `s${i}` })
  }
  return out.concat(extra)
}
const NOWS = OUTSIDE.filter((_, i) => i % 23 === 0) // ~370 instants across 2026

describe('goals (web) — weeks and months on the member calendar', () => {
  it('Dublin, outside the window, sessions outside the window: computeProgress is unchanged', () => {
    for (const now of NOWS) {
      const s = sessionsBefore(now)
      for (const kind of goals.GOAL_KINDS) {
        const goal = { kind, target_value: 100 }
        expect(goals.computeProgress(goal, s, new Date(now), D).current).toBe(L.computeProgressCurrentLegacy(goal, s, new Date(now)).current)
      }
    }
  })
  it('a session at 00:30 IST on Monday 6 Jul counts in that week and month (it fell to the week before)', () => {
    const s = [{ started_at: '2026-07-05T23:30:00Z', effort_points: 50 }]
    const now = new Date('2026-07-06T12:00:00Z')
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 100 }, s, now, D).current).toBe(50)
    expect(L.computeProgressCurrentLegacy({ kind: 'weekly_points' }, s, now).current).toBe(0)
    const july = new Date('2026-07-01T12:00:00Z')
    const firstOfJuly = [{ started_at: '2026-06-30T23:30:00Z', effort_points: 40 }] // 00:30 IST 1 Jul
    expect(goals.computeProgress({ kind: 'monthly_points', target_value: 100 }, firstOfJuly, july, D).current).toBe(40)
    expect(L.computeProgressCurrentLegacy({ kind: 'monthly_points' }, firstOfJuly, july).current).toBe(0)
  })
  it('at 00:30 IST on Mon 6 Jul, last week is over (the UTC week still counted it)', () => {
    const lastWeek = [{ started_at: '2026-07-04T10:00:00Z', effort_points: 70 }] // Sat
    const now = new Date('2026-07-05T23:30:00Z')
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 100 }, lastWeek, now, D).current).toBe(0)
    expect(L.computeProgressCurrentLegacy({ kind: 'weekly_points' }, lastWeek, now).current).toBe(70)
  })
  it('at 00:30 IST on 2 Jul the month is July', () => {
    expect(goals.startOfMonth(new Date(MIDNIGHT_IST), D).toISOString()).toBe('2026-06-30T23:00:00.000Z')
    expect(L.startOfMonthLegacy(new Date(MIDNIGHT_IST)).toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('progress analytics (phone OTA + champ-app) — weeks and months on the member calendar', () => {
  it('Dublin, outside the window: weeklyBuckets, monthlyRecap and the best week are unchanged', () => {
    for (const now of NOWS.filter((_, i) => i % 3 === 0)) {
      const s = sessionsBefore(now)
      expect(PA.weeklyBuckets(s, now, 12, D)).toStrictEqual(L.weeklyBucketsLegacy(s, now, 12))
      expect(PA.monthlyRecap(s, now, 6, D)).toStrictEqual(L.monthlyRecapLegacy(s, now, 6))
      expect(PA.personalRecords(s, D).bestWeekPoints).toStrictEqual(L.personalRecordsLegacy(s, D).bestWeekPoints)
    }
  })
  it('a session at 00:30 IST on Monday 6 Jul is in the week of 6 Jul (it was in the week of 29 Jun)', () => {
    const s = [{ started_at: '2026-07-05T23:30:00Z', ended_at: '2026-07-06T00:15:00Z', effort_points: 30 }]
    const now = ms('2026-07-08T12:00:00Z')
    const w = PA.weeklyBuckets(s, now, 2, D)
    expect(w.map((b) => [b.label, b.count])).toEqual([['29 Jun', 0], ['6 Jul', 1]])
    expect(L.weeklyBucketsLegacy(s, now, 2).map((b) => [b.label, b.count])).toEqual([['29 Jun', 1], ['6 Jul', 0]])
    expect(PA.personalRecords(s, D).bestWeekPoints.weekStartMs).toBe(ms('2026-07-06T00:00:00Z')) // a date anchor, rendered in UTC
  })
  it('a session at 00:30 IST on 2 Jul... and at 00:30 IST on 1 Jul, is a July session', () => {
    const s = [{ started_at: '2026-06-30T23:30:00Z', ended_at: '2026-07-01T00:15:00Z', effort_points: 30 }]
    const julyRecap = PA.monthlyRecap(s, ms('2026-07-15T12:00:00Z'), 2, D).months
    expect(julyRecap.map((m) => [m.label, m.count])).toEqual([['Jun 2026', 0], ['Jul 2026', 1]])
    expect(L.monthlyRecapLegacy(s, ms('2026-07-15T12:00:00Z'), 2).months.map((m) => [m.label, m.count])).toEqual([['Jun 2026', 1], ['Jul 2026', 0]])
    // and at 00:30 IST on 1 Jul the recap's current month is already July
    expect(PA.monthlyRecap([], ms('2026-06-30T23:30:00Z'), 1, D).months[0].label).toBe('Jul 2026')
  })
})

describe('manual timetable — the canonical solver', () => {
  const at = (dow, time) => ({ dow, time, name: 'Class' })
  const SLOTS = []
  for (let dow = 1; dow <= 7; dow++) for (let m = 0; m < 24 * 60; m += 15) SLOTS.push(at(dow, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`))
  // Two Dublin changes, both on a clock-change Sunday: a 23:xx slot on the
  // spring-forward day no longer lands a day late, and a 01:xx slot on the
  // fall-back day (01:xx happens twice) now resolves to the GMT 01:xx, as
  // every other Dublin wall clock in the platform does (zonedWallClockToInstant);
  // the one-pass solver took the IST 01:xx.
  it('Dublin: every quarter-hour slot of every day of 2026 lands where it did, except 23:xx on 29 Mar and 01:xx on 25 Oct', () => {
    const changed = []
    for (let day = ms('2026-01-01T00:00:00Z'); day < ms('2027-01-01T00:00:00Z'); day += DAY) {
      const dateKey = iso(day).slice(0, 10)
      for (let m = 0; m < 24 * 60; m += 15) {
        const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
        const now = Z.zonedWallClockToInstant(dateKey, time, D)
        const legacy = L.zonedWallClockMsOnePassLegacy(dateKey, time, D)
        if (now !== legacy) changed.push(`${dateKey} ${time}`)
      }
    }
    expect(changed).toEqual([
      ...['00', '15', '30', '45'].map((mm) => `2026-03-29 23:${mm}`),
      ...['00', '15', '30', '45'].map((mm) => `2026-10-25 01:${mm}`),
    ])
    expect(iso(Z.zonedWallClockToInstant('2026-10-25', '01:30', D))).toBe('2026-10-25T01:30:00.000Z') // GMT 01:30
    expect(iso(L.zonedWallClockMsOnePassLegacy('2026-10-25', '01:30', D))).toBe('2026-10-25T00:30:00.000Z') // IST 01:30
  })
  it('the 23:15 Sunday class on 29 Mar is listed on 29 Mar at 22:15Z (it showed a day late)', () => {
    const out = manualClassOccurrences({ slots: [at(7, '23:15')], now: ms('2026-03-29T06:00:00Z'), minNoticeHours: 0, days: 1, zone: D })
    expect(out.map((c) => [c.day, c.starts_at])).toEqual([['2026-03-29', '2026-03-29T22:15:00.000Z']])
    expect(iso(L.zonedWallClockMsOnePassLegacy('2026-03-29', '23:15', D))).toBe('2026-03-30T22:15:00.000Z')
  })
  it('every slot of a normal week is unchanged', () => {
    const out = manualClassOccurrences({ slots: SLOTS, now: ms('2026-07-06T00:00:00Z'), minNoticeHours: 0, days: 7, zone: D })
    for (const c of out) expect(c.starts_at).toBe(iso(L.zonedWallClockMsOnePassLegacy(c.day, c.time, D)))
  })
})

describe('ads dashboard — booked requests by the dashboard day', () => {
  it('Dublin, outside the window: the same requests are in the window, on the same trend day', () => {
    const { startIso, endIso } = createdAtWindow('2026-06-10', '2026-07-09', D)
    for (let t = ms('2026-06-08T00:30:00Z'); t < ms('2026-07-12T00:00:00Z'); t += H) {
      if (inMidnightHour(t)) continue
      const created = iso(t)
      expect(created >= startIso && created < endIso).toBe(L.adsCreatedAtInWindowLegacy(created, '2026-06-10', '2026-07-09'))
      expect(Z.dateKeyIn(created, D)).toBe(L.adsTrendDayLegacy(created))
    }
  })
  it('a request at 00:30 IST on 2 Jul is a 2 Jul booking (it was 1 Jul)', () => {
    expect(Z.dateKeyIn(iso(MIDNIGHT_IST), D)).toBe('2026-07-02')
    expect(L.adsTrendDayLegacy(iso(MIDNIGHT_IST))).toBe('2026-07-01')
  })
})

describe('{{current_year}} — unchanged for Dublin', () => {
  it('Dublin is on GMT at New Year, so the year flips at the same instant as before', () => {
    for (const t of [ms('2026-12-31T23:59:00Z'), ms('2027-01-01T00:00:00Z'), ms('2027-01-01T00:30:00Z'), MIDNIGHT_IST]) {
      vi.useFakeTimers(); vi.setSystemTime(t)
      try {
        expect(applyMergeTags('{{current_year}}', {}, { zone: D })).toBe(L.currentYearLegacy())
        expect(applyMergeTags('{{current_year}}', {})).toBe(L.currentYearLegacy())
      } finally { vi.useRealTimers() }
    }
  })
})

describe('cars reports — the studio calendar', () => {
  it('Dublin: YTD and the 12 monthly keys/labels are unchanged; bounds move only for IST months', () => {
    for (const now of NOWS) {
      const legacy = L.carsPeriodsLegacy(now)
      const m = cars.computeReportMetrics([], { now: new Date(now), zone: D })
      expect(m.monthlyPerformance.map((b) => [b.key, b.label])).toEqual(legacy.months.map((b) => [b.key, b.label]))
      expect(cars.carsYearStartIso(now, D)).toBe(L.carsExportYearStartLegacy(now))
    }
  })
  it('a car completed 00:30 IST on 1 Jul is a July car (it was June)', () => {
    const car = { status: 'completed', completed_at: '2026-06-30T23:30:00Z', created_at: '2026-06-01T10:00:00Z' }
    const m = cars.computeReportMetrics([car], { now: new Date('2026-07-15T12:00:00Z'), zone: D })
    const byKey = Object.fromEntries(m.monthlyPerformance.map((b) => [b.key, b.completedCount]))
    expect([byKey['2026-06'], byKey['2026-07']]).toEqual([0, 1])
  })
  it('the deposit expiry note shows Dublin time (it showed UTC): changes for every IST instant', () => {
    expect(cars.depositExpiryLabel('2026-01-15T14:30:00Z', D)).toBe(L.depositExpiryLabelLegacy('2026-01-15T14:30:00Z'))
    expect(cars.depositExpiryLabel('2026-07-15T14:30:00Z', D)).toBe('15/7/2026, 15:30:00')
    expect(L.depositExpiryLabelLegacy('2026-07-15T14:30:00Z')).toBe('15/7/2026, 14:30:00')
  })
})

describe('Strava title — the session day', () => {
  it('Dublin, outside the window: byte-identical', () => {
    for (const t of OUTSIDE) expect(stravaTitleDate(iso(t), D)).toBe(L.stravaTitleDateLegacy(iso(t)))
  })
  it('00:30 IST on 2 Jul is 2/7/2026 (it was 1/7/2026)', () => {
    expect(stravaTitleDate(iso(MIDNIGHT_IST), D)).toBe('2/7/2026')
    expect(L.stravaTitleDateLegacy(iso(MIDNIGHT_IST))).toBe('1/7/2026')
  })
})

describe("streak-at-risk — the studio's yesterday", () => {
  const slotAt = (t) => ({ day: Z.dayStrIn(t, D), zone: D })
  it('the dedup key at the Dublin slot (11:00 UTC) is the date the cron always used, every day of 2026', () => {
    for (let t = ms('2026-01-01T11:00:00Z'); t < ms('2027-01-01T00:00:00Z'); t += DAY) {
      expect(streakCandidateWindow(slotAt(t)).dedupKey).toBe(L.streakWindowLegacy(iso(t).slice(0, 10)).dedupKey)
    }
  })
  it('winter: the window is unchanged; summer: it is the Dublin yesterday (an hour earlier)', () => {
    const jan = ms('2026-01-15T11:00:00Z')
    expect(streakCandidateWindow(slotAt(jan))).toEqual(L.streakWindowLegacy('2026-01-15'))
    const jul = ms('2026-07-02T11:00:00Z')
    const w = streakCandidateWindow(slotAt(jul))
    expect([iso(w.yestMs), iso(w.todayMs)]).toEqual(['2026-06-30T23:00:00.000Z', '2026-07-01T23:00:00.000Z'])
    // 00:30 IST on 1 Jul was missed as "yesterday" before; 00:30 IST on 2 Jul (today) was counted
    expect(MIDNIGHT_IST >= w.yestMs && MIDNIGHT_IST < w.todayMs).toBe(false)
    const legacy = L.streakWindowLegacy('2026-07-02')
    expect(MIDNIGHT_IST >= legacy.yestMs && MIDNIGHT_IST < legacy.todayMs).toBe(true)
  })
})

describe('TV gym board — the month', () => {
  it('Dublin: unchanged in GMT months; from 00:00 IST on the 1st in IST months', () => {
    expect(iso(Z.monthStartMsIn(ms('2026-01-15T12:00:00Z'), D))).toBe(L.tvGymMonthFromLegacy(ms('2026-01-15T12:00:00Z')))
    expect(iso(Z.monthStartMsIn(MIDNIGHT_IST, D))).toBe('2026-06-30T23:00:00.000Z')
    expect(L.tvGymMonthFromLegacy(MIDNIGHT_IST)).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('member home — the challenge countdown (phone OTA)', () => {
  it('Dublin, outside the window: the same count as before, for every end date within 10 days', () => {
    for (const t of OUTSIDE) {
      for (let k = -1; k <= 10; k++) {
        const endsOn = Z.addDaysISO(iso(t).slice(0, 10), k)
        expect(challengeDaysLeft(endsOn, t, D)).toBe(L.daysUntilLegacy(endsOn, t))
      }
    }
  })
  it('00:30 IST on 2 Jul: a challenge ending 2 Jul ends today (it said tomorrow)', () => {
    expect(challengeDaysLeft('2026-07-02', MIDNIGHT_IST, D)).toBe(0)
    expect(L.daysUntilLegacy('2026-07-02', MIDNIGHT_IST)).toBe(1)
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

describe('the frozen helpers really are the old behaviour (sanity)', () => {
  it('isoToday on the UTC host is the UTC date; the feed now uses the studio day', () => {
    expect(L.isoTodayLegacy(new Date(MIDNIGHT_IST))).toBe('2026-07-01')
    expect(Z.todayStrIn(D, MIDNIGHT_IST)).toBe('2026-07-02')
    for (const t of OUTSIDE) expect(Z.todayStrIn(D, t)).toBe(L.isoTodayLegacy(new Date(t)))
  })
  it('live-class target-hit month name: the banked month', () => {
    expect(L.liveClassMonthLabelLegacy(ms('2026-06-30T23:30:00Z'))).toBe('June')
    expect(Z.monthKeyIn(ms('2026-06-30T23:30:00Z'), D)).toBe('2026-07')
    for (const t of OUTSIDE.filter((_, i) => i % 5 === 0)) {
      const key = Z.monthKeyIn(t, D)
      expect(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(key.slice(5, 7)) - 1]).toBe(L.liveClassMonthLabelLegacy(t))
    }
  })
  it('PERIOD_EDGE is the same window', () => { expect(PERIOD_EDGE(MIDNIGHT_IST)).toBe(true) })
})
