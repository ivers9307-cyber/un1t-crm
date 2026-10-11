// tz-17.tz-us.test.js — TZ.17. The corrected dates follow the studio's (or the
// member's) own zone: America/New_York across both 2026 US DST changes. The
// host clock is neither zone under test, so nothing here can pass by reading it.
//
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }))
vi.mock('@/components/ui', () => ({ Button: () => null, Field: () => null }))
vi.mock('lucide-react', () => ({ AlertCircle: () => null }))

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
const Z = await import('@/lib/location-time')
const { allowanceYearIn } = await import('./allowance-year.js')

const NY = 'America/New_York'
const D = 'Europe/Dublin'
const ms = (iso) => Date.parse(iso)
const iso = (t) => new Date(t).toISOString()

describe('the 23:30 local instant is the local day, in New York too', () => {
  it('23:30 EDT on 31 Oct (03:30Z on 1 Nov): consultation, prompt, title, countdown', () => {
    const t = ms('2026-11-01T03:30:00Z')
    expect(toDateInput(iso(t), NY)).toBe('2026-10-31')
    expect(zonedDateString(t, NY)).toBe('Sat Oct 31 2026')
    expect(stravaTitleDate(iso(t), NY)).toBe('31/10/2026')
    expect(challengeDaysLeft('2026-11-01', t, NY)).toBe(1)
    // the same instant in Dublin is already 1 Nov
    expect(toDateInput(iso(t), D)).toBe('2026-11-01')
    expect(challengeDaysLeft('2026-11-01', t, D)).toBe(0)
  })
  it('23:30 EST on 7 Mar (04:30Z on 8 Mar), the night before spring forward', () => {
    const t = ms('2026-03-08T04:30:00Z')
    expect(zonedDateString(t, NY)).toBe('Sat Mar 07 2026')
    expect(toDateInput(iso(t), NY)).toBe('2026-03-07')
  })
})

describe('event_reminder — a 09:00 New York booking is 14:00Z in winter and 13:00Z in summer', () => {
  it('the window matches the real start on both sides of 8 Mar', () => {
    for (const [date, utc] of [['2026-03-06', '2026-03-06T14:00:00Z'], ['2026-03-09', '2026-03-09T13:00:00Z']]) {
      const start = Z.zonedWallClockToInstant(date, '09:00:00', NY)
      expect(iso(start)).toBe(new Date(utc).toISOString())
      const w = eventReminderWindow(start - 24 * 3600_000, 24, NY)
      expect(start >= w.loMs && start <= w.hiMs).toBe(true)
      expect(w.loDay <= date && w.hiDay >= date).toBe(true)
    }
  })
})

describe('goals — the New York member week and month', () => {
  it('Monday 9 Mar starts at 00:00 EDT (04:00Z); 1 Nov at 00:00 EDT, 1 Dec at 00:00 EST', () => {
    expect(goals.startOfIsoWeek(new Date('2026-03-09T12:00:00Z'), NY).toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(goals.startOfMonth(new Date('2026-11-15T12:00:00Z'), NY).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(goals.startOfMonth(new Date('2026-12-15T12:00:00Z'), NY).toISOString()).toBe('2026-12-01T05:00:00.000Z')
  })
  it('a session at 23:30 EST on Sun 1 Nov is last week, not this week', () => {
    const s = [{ started_at: '2026-11-02T04:30:00Z', effort_points: 20 }]
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 50 }, s, new Date('2026-11-02T15:00:00Z'), NY).current).toBe(0)
    expect(goals.computeProgress({ kind: 'weekly_points', target_value: 50 }, s, new Date('2026-11-02T15:00:00Z'), D).current).toBe(20)
  })
})

describe('progress analytics — New York weeks and months', () => {
  it('a 23:30 EST Sunday session is in the week of 26 Oct; the week of 2 Nov holds the 00:30 EST Monday one', () => {
    const s = [
      { started_at: '2026-11-02T04:30:00Z', ended_at: '2026-11-02T05:15:00Z', effort_points: 10 }, // Sun 1 Nov 23:30 EST
      { started_at: '2026-11-02T05:30:00Z', ended_at: '2026-11-02T06:15:00Z', effort_points: 20 }, // Mon 2 Nov 00:30 EST
    ]
    const w = PA.weeklyBuckets(s, ms('2026-11-04T12:00:00Z'), 2, NY)
    expect(w.map((b) => [b.label, b.count, b.points])).toEqual([['26 Oct', 1, 10], ['2 Nov', 1, 20]])
    expect(w.map((b) => iso(b.weekStartMs))).toEqual(['2026-10-26T00:00:00.000Z', '2026-11-02T00:00:00.000Z']) // date anchors
    expect(PA.personalRecords(s, NY).bestWeekPoints).toEqual({ value: 20, weekStartMs: ms('2026-11-02T00:00:00Z') })
  })
  it('a 23:30 EDT 31 Oct session is an October session', () => {
    const s = [{ started_at: '2026-11-01T03:30:00Z', ended_at: '2026-11-01T04:00:00Z', effort_points: 5 }]
    expect(PA.monthlyRecap(s, ms('2026-11-15T12:00:00Z'), 2, NY).months.map((m) => [m.label, m.count])).toEqual([['Oct 2026', 1], ['Nov 2026', 0]])
  })
  it('a 12-week grid across the US clock change keeps whole weeks', () => {
    const w = PA.weeklyBuckets([], ms('2026-11-20T12:00:00Z'), 12, NY)
    for (let i = 1; i < w.length; i++) expect(w[i].weekStartMs - w[i - 1].weekStartMs).toBe(7 * 24 * 3600_000)
  })
})

describe('manual timetable — the New York spring-forward night', () => {
  it('a 23:15 slot on Sun 8 Mar is 03:15Z on 9 Mar (EDT), not a day late', () => {
    const out = manualClassOccurrences({ slots: [{ dow: 7, time: '23:15', name: 'Late' }], now: ms('2026-03-08T12:00:00Z'), minNoticeHours: 0, days: 1, zone: NY })
    expect(out.map((c) => [c.day, c.starts_at])).toEqual([['2026-03-08', '2026-03-09T03:15:00.000Z']])
  })
})

describe('ads — a New York dashboard day', () => {
  it('8 Mar (23 h) runs 05:00Z → 04:00Z; 1 Nov (25 h) runs 04:00Z → 05:00Z', () => {
    expect(createdAtWindow('2026-03-08', '2026-03-08', NY)).toEqual({ startIso: '2026-03-08T05:00:00.000Z', endIso: '2026-03-09T04:00:00.000Z' })
    expect(createdAtWindow('2026-11-01', '2026-11-01', NY)).toEqual({ startIso: '2026-11-01T04:00:00.000Z', endIso: '2026-11-02T05:00:00.000Z' })
  })
})

describe('{{current_year}} — the sending studio year', () => {
  it('at 03:00Z on 1 Jan 2027 a New York studio is still in 2026; Dublin is in 2027', () => {
    vi.useFakeTimers(); vi.setSystemTime(ms('2027-01-01T03:00:00Z'))
    try {
      expect(applyMergeTags('© {{current_year}}', {}, { zone: NY })).toBe('© 2026')
      expect(applyMergeTags('© {{current_year}}', {}, { zone: D })).toBe('© 2027')
    } finally { vi.useRealTimers() }
  })
})

describe('cars — a New York studio calendar', () => {
  it('a car completed 23:30 EDT on 31 Oct is an October car; buckets follow New York midnights', () => {
    const car = { status: 'completed', completed_at: '2026-11-01T03:30:00Z', created_at: '2026-10-01T15:00:00Z' }
    const m = cars.computeReportMetrics([car], { now: new Date('2026-11-15T12:00:00Z'), zone: NY })
    const byKey = Object.fromEntries(m.monthlyPerformance.map((b) => [b.key, b.completedCount]))
    expect([byKey['2026-10'], byKey['2026-11']]).toEqual([1, 0])
    expect(m.ytd.completedCount).toBe(1)
    expect(cars.carsYearStartIso(ms('2027-01-01T03:00:00Z'), NY)).toBe('2026-01-01T05:00:00.000Z')
    expect(cars.depositExpiryLabel('2026-07-15T14:30:00Z', NY)).toBe('15/7/2026, 10:30:00')
  })
})

describe("streak-at-risk — a New York studio's yesterday", () => {
  it('at the 11:00 EST slot on 2 Nov, yesterday is the 25-hour 1 Nov', () => {
    const w = streakCandidateWindow({ day: '2026-11-02', zone: NY })
    expect([iso(w.yestMs), iso(w.todayMs), w.dedupKey]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', '2026-11-02'])
  })
})

describe('time-off allowance year — the studio year, not the viewer browser', () => {
  it('at 03:00Z on 1 Jan 2027 a New York studio is still in 2026 (a Dublin browser said 2027)', () => {
    expect(allowanceYearIn(NY, ms('2027-01-01T03:00:00Z'))).toBe(2026)
    expect(allowanceYearIn(D, ms('2027-01-01T03:00:00Z'))).toBe(2027)
  })
})
