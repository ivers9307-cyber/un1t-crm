// member-zone.tz.test.js — TZ.13: the member seam (streaks, challenges, goals,
// weekly digests, month wrapped, member push keys) takes a zone. D7: a
// member's zone is their home studio's (contacts.location_id); a challenge's
// window is its own studio's (challenges.location_id).
//
// Europe/Dublin was proven byte-identical to frozen pre-change copies of these
// modules over every day of 2026 in TZ.13; that sweep was retired in TZ.18b.
// Dublin is now pinned by fixed values around both 2026 EU DST changes, and
// zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js.
// America/New_York follows New York's clock across both 2026 US DST changes.
// Relative imports only, so this file is byte-identical in champ-app's shared/.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect } from 'vitest'

const CH = await import('../../challenges.js')
const CW = await import('../../challenge-wrapped.js')
const CK = await import('../../coach-kudos.js')
const CN = await import('../../customer-notifications.js')
const FMT = await import('../../format.js')
const GO = await import('../../goals.js')
const HA = await import('../../hr-analytics.js')
const HSR = await import('../../hr-session-report.js')
const MW = await import('../../month-wrapped.js')
const PA = await import('../../progress-analytics.js')
const SH = await import('../../session-history.js')
const SC = await import('../../share-card.js')
const TW = await import('../../tier-window.js')
const WD = await import('../../week-digest.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const HOUR = 3_600_000
const DAY = 86_400_000
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
// 00:30 GMT on the spring-forward Sunday; 00:30 IST on the Monday after it;
// 00:30 IST on 2 Jul (summer); 01:30 IST on the fall-back Sunday; 23:30 GMT
// that same Sunday; an ordinary winter noon.
const PINS = [
  '2026-03-29T00:30:00Z', '2026-03-29T23:30:00Z', '2026-07-01T23:30:00Z',
  '2026-10-25T00:30:00Z', '2026-10-25T23:30:00Z', '2026-01-15T12:00:00Z',
].map(Date.parse)
const iso = (ms) => new Date(ms).toISOString()
// A member history that straddles midnight: sessions 0.5h, 23.5h, 24.5h, 47h,
// 49h, 71h and 8 days before `now`, with points and an end time.
const historyAt = (now) => [0.5, 23.5, 24.5, 47, 49, 71, 192].map((h, i) => ({
  id: `s${i}`,
  started_at: iso(now - h * HOUR),
  ended_at: iso(now - h * HOUR + 45 * 60_000),
  effort_points: 100 + i * 7,
  peak_hr_bpm: 170 + i,
  zones_seconds: { 4: 600, 5: 200 + i },
  class_name: 'HIIT',
}))

describe('TZ.13 Europe/Dublin pinned values (explicit zone AND omitted zone)', () => {
  it('hr-analytics: currentStreak / weeklyStreak / pickHighlight count Dublin days', () => {
    expect(PINS.map((now) => HA.currentStreak(historyAt(now), now, DUB).current)).toEqual([4, 4, 4, 4, 3, 4])
    expect(PINS.map((now) => HA.currentStreak(historyAt(now), now).current)).toEqual([4, 4, 4, 4, 3, 4])
    // 00:30 IST Mon 30 Mar is already a new Dublin week.
    expect(PINS.map((now) => HA.weeklyStreak(historyAt(now), { nowMs: now }, DUB).thisWeekCount)).toEqual([6, 1, 6, 6, 6, 6])
    const now = PINS[2]
    const args = { thisSession: historyAt(now)[0], history: historyAt(now), eventTypeName: 'HIIT', nowMs: now, shortName: 'X' }
    expect(HA.pickHighlight(args, DUB)).toStrictEqual({ id: 'streak', message: '4-day streak — keep it rolling.' })
    expect(HA.buildSessionAnalytics(args, DUB).highlight).toStrictEqual(HA.pickHighlight(args, DUB))
  })

  it('customer-notifications: periodKey + streakAtRisk', () => {
    expect(PINS.map((now) => CN.periodKey('month', now, DUB))).toEqual(['2026-03', '2026-03', '2026-07', '2026-10', '2026-10', '2026-01'])
    expect(PINS.map((now) => CN.periodKey('week', now, DUB))).toEqual(['2026-W13', '2026-W14', '2026-W27', '2026-W43', '2026-W43', '2026-W03'])
    expect(PINS.map((now) => CN.periodKey('week', now))).toEqual(['2026-W13', '2026-W14', '2026-W27', '2026-W43', '2026-W43', '2026-W03'])
    expect(CN.periodKey('month', Date.parse('2026-03-31T23:00:00Z'), DUB)).toBe('2026-04') // 00:00 IST 1 Apr
    // The history minus today's session: a run ending yesterday (none at 23:30 GMT on 25 Oct,
    // where two more sessions already fell on the Dublin today).
    expect(PINS.map((now) => CN.streakAtRisk(historyAt(now).slice(1), now, 2, DUB))).toEqual([3, 3, 3, 3, 0, 3])
  })

  it('goals: startOfIsoWeek / startOfMonth / periodEnd / computeProgress', () => {
    const at = (i) => new Date(PINS[i])
    expect(PINS.map((now) => GO.startOfIsoWeek(new Date(now), DUB).toISOString())).toEqual([
      '2026-03-23T00:00:00.000Z', '2026-03-29T23:00:00.000Z', '2026-06-28T23:00:00.000Z',
      '2026-10-18T23:00:00.000Z', '2026-10-18T23:00:00.000Z', '2026-01-12T00:00:00.000Z',
    ])
    expect(GO.startOfMonth(at(2), DUB).toISOString()).toBe('2026-06-30T23:00:00.000Z')
    expect(GO.startOfMonth(at(3), DUB).toISOString()).toBe('2026-09-30T23:00:00.000Z')
    expect(GO.startOfMonth(at(5), DUB).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    // The spring-forward week is 167 hours; the fall-back month ends at 00:00 GMT.
    expect(GO.periodEnd('week', new Date('2026-03-23T00:00:00Z'), DUB).toISOString()).toBe('2026-03-29T23:00:00.000Z')
    expect(GO.periodEnd('week', new Date('2026-10-18T23:00:00Z'), DUB).toISOString()).toBe('2026-10-24T23:00:00.000Z')
    expect(GO.periodEnd('month', new Date('2026-09-30T23:00:00Z'), DUB).toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(GO.periodEnd('month', new Date('2026-03-01T00:00:00Z'), DUB).toISOString()).toBe('2026-03-31T23:00:00.000Z')
    expect(GO.computeProgress({ id: 'g', kind: 'weekly_points', target_value: 300 }, historyAt(PINS[1]), at(1), DUB))
      .toMatchObject({ current: 100, periodStart: new Date('2026-03-29T23:00:00.000Z') })
    expect(GO.computeProgress({ id: 'm', kind: 'monthly_classes', target_value: 4 }, historyAt(PINS[2]), at(2)))
      .toMatchObject({ current: 3, pct: 0.75, periodStart: new Date('2026-06-30T23:00:00.000Z') })
  })

  it('challenges: windowIso / challengePhase / the flagship wrap', () => {
    const w = (ends_on, ...zone) => CH.windowIso({ starts_on: '2026-01-05', ends_on }, ...zone)
    expect(w('2026-03-28', DUB)).toStrictEqual({ fromIso: '2026-01-05T00:00:00.000Z', toIso: '2026-03-29T00:00:00.000Z' })
    expect(w('2026-03-29', DUB).toIso).toBe('2026-03-29T23:00:00.000Z') // the 23-hour Sunday
    expect(w('2026-07-01').toIso).toBe('2026-07-01T23:00:00.000Z')
    expect(w('2026-12-31').toIso).toBe('2027-01-01T00:00:00.000Z')
    const ch = { starts_on: '2026-03-23', ends_on: '2026-03-29' }
    expect(CH.challengePhase(ch, Date.parse('2026-03-22T23:59:59Z'), DUB)).toBe('upcoming')
    expect(CH.challengePhase(ch, Date.parse('2026-03-29T22:59:59Z'), DUB)).toBe('active')
    expect(CH.challengePhase(ch, Date.parse('2026-03-29T23:00:00Z'), DUB)).toBe('ended')
    const fl = { ...ch, is_flagship: true }
    const end = Date.parse('2026-03-29T23:00:00Z')
    expect([end - 1, end, end + 14 * DAY - 1, end + 14 * DAY].map((now) => CW.endedRecentlyFlagship(fl, now, 14, DUB))).toEqual([false, true, true, false])
    expect(CW.ownWindowStats(historyAt(end - DAY), fl, end, DUB)).toStrictEqual({ classes: 6, points: 705, metricTotal: 6 })
    expect(CW.challengeWrappedModel({ challenge: fl, sessions: historyAt(end - DAY), nowMs: end }, DUB)).toMatchObject({ classes: 6, points: 705, finisher: true })
  })

  it('challenges: a challenge ending on the clocks-back Sunday keeps its last day', () => {
    const ch = { starts_on: '2026-10-19', ends_on: '2026-10-25' }
    // The pre-TZ.13 code ended it at 00:00 IST on the 25th (2026-10-24T23:00Z),
    // dropping the 25th. Now: 00:00 GMT on the 26th — the whole 25-hour Sunday is in.
    expect(CH.windowIso(ch, DUB)).toStrictEqual({ fromIso: '2026-10-18T23:00:00.000Z', toIso: '2026-10-26T00:00:00.000Z' })
    expect(CH.challengePhase(ch, Date.parse('2026-10-25T12:00:00Z'), DUB)).toBe('active')
  })

  it('month-wrapped and tier-window: the Dublin month', () => {
    const t = (s) => Date.parse(s)
    expect(MW.monthWrappedKey(t('2026-03-31T22:59:00Z'), DUB)).toBe('2026-02') // 23:59 IST 31 Mar
    expect(MW.monthWrappedKey(t('2026-03-31T23:00:00Z'), DUB)).toBe('2026-03') // 00:00 IST 1 Apr
    expect(MW.monthWrappedKey(t('2026-10-31T23:30:00Z'))).toBe('2026-09') // 23:30 GMT 31 Oct
    expect(MW.monthWrappedKey(t('2026-01-01T00:30:00Z'))).toBe('2025-12')
    const now = t('2026-11-01T00:30:00Z')
    const model = MW.monthWrappedModel(PA.monthlyRecap(historyAt(now - 20 * DAY), now, 6), PA.personalRecords(historyAt(now - 20 * DAY), DUB), now, DUB)
    expect(model).toMatchObject({ monthKey: '2026-10', label: 'October 2026', sessions: 7, points: 847 })
    expect([...TW.windowMonthKeys(3, t('2026-03-31T22:59:00Z'), DUB)]).toEqual(['2026-03', '2026-02', '2026-01'])
    expect([...TW.windowMonthKeys(3, t('2026-03-31T23:00:00Z'), DUB)]).toEqual(['2026-04', '2026-03', '2026-02'])
    expect([...TW.windowMonthKeys(3, t('2026-10-31T23:30:00Z'))]).toEqual(['2026-10', '2026-09', '2026-08'])
    expect(TW.monthsHitInWindow(['2026-01', '2026-03', '2026-10', '2026-11'], 2, t('2026-11-01T00:00:00Z'), DUB)).toBe(2)
    const a = { hitMonthKeys: ['2026-03', '2026-04'], cumulativeMonths: 5, windowMonths: 2 }
    expect(TW.resolveTierMonths({ ...a, nowMs: t('2026-03-31T22:59:00Z') }, DUB)).toBe(1)
    expect(TW.resolveTierMonths({ ...a, nowMs: t('2026-03-31T23:00:00Z') }, DUB)).toBe(2)
  })

  it('progress-analytics: activityCalendar / personalRecords', () => {
    const cal = (now) => PA.activityCalendar(historyAt(now), now, 4, DUB).days.map((d) => [d.dateKey, d.count, iso(d.dayMs)])
    expect(cal(PINS[1])).toEqual([
      ['2026-03-27', 2, '2026-03-27T00:00:00.000Z'], ['2026-03-28', 2, '2026-03-28T00:00:00.000Z'],
      ['2026-03-29', 1, '2026-03-29T00:00:00.000Z'], ['2026-03-30', 1, '2026-03-29T23:00:00.000Z'],
    ])
    expect(cal(PINS[4])).toEqual([
      ['2026-10-22', 0, '2026-10-21T23:00:00.000Z'], ['2026-10-23', 2, '2026-10-22T23:00:00.000Z'],
      ['2026-10-24', 1, '2026-10-23T23:00:00.000Z'], ['2026-10-25', 3, '2026-10-24T23:00:00.000Z'],
    ])
    expect(cal(PINS[5]).map(([k, n]) => [k, n])).toEqual([['2026-01-12', 1], ['2026-01-13', 2], ['2026-01-14', 2], ['2026-01-15', 1]])
    // The best week is keyed by a date anchor (rendered in UTC) for the Dublin Monday.
    const pr = PA.personalRecords(historyAt(Date.parse('2026-11-01T00:30:00Z')), DUB)
    expect(pr.bestWeekPoints).toStrictEqual({ value: 705, weekStartMs: Date.parse('2026-10-26T00:00:00Z') })
    expect(pr.bestStreak).toBe(4)
  })

  it('session-history: groupSessionsByMonth / lifetimeMilestones', () => {
    const now = PINS[2] // 00:30 IST 2 Jul: the latest sessions are July, the rest June
    const items = historyAt(now).map((s, i) => ({ kind: 'session', key: `k${i}`, sortMs: Date.parse(s.started_at), session: s }))
    expect(SH.groupSessionsByMonth(items, DUB).map((g) => g.monthKey)).toEqual(['2026-07', '2026-06'])
    expect(SH.groupSessionsByMonth(items).map((g) => g.monthKey)).toEqual(['2026-07', '2026-06'])
    expect(SH.lifetimeMilestones(historyAt(now), now, { brand: 'B', shortName: 'S' }, DUB)).toMatchObject({ totalSessions: 7, longestStreak: 4 })
  })

  it('week-digest: weekDigestModel covers the last completed Dublin week', () => {
    const wd = (s, ...zone) => { const now = Date.parse(s); return WD.weekDigestModel(historyAt(now).concat(historyAt(now - 5 * DAY)), now, {}, ...zone) }
    expect(wd('2026-03-29T23:30:00Z', DUB)).toMatchObject({ weekKey: '2026-W13', classes: 9, points: 1047 })
    expect(wd('2026-10-26T12:00:00Z', DUB)).toMatchObject({ weekKey: '2026-W43', weekLabel: '19 Oct–25 Oct' })
    expect(wd('2026-07-06T12:00:00Z')).toMatchObject({ weekKey: '2026-W27', weekLabel: '29 Jun–5 Jul', classes: 10 })
    expect(wd('2026-01-12T12:00:00Z', DUB)).toMatchObject({ weekKey: '2026-W02', weekLabel: '5 Jan–11 Jan', classes: 10 })
    expect(WD.weekDigestModel([], Date.parse('2026-01-12T12:00:00Z'), { leagueFinish: { rank: 2, of: 5 } }, DUB).leagueFinish).toStrictEqual({ rank: 2, of: 5 })
  })

  it('format.sessionDate / share-card.cardModel / coach-kudos.kudosRelativeTime', () => {
    const days = ['Sun, 29 Mar', 'Mon, 30 Mar', 'Thu, 2 Jul', 'Sun, 25 Oct', 'Sun, 25 Oct', 'Thu, 15 Jan']
    expect(PINS.map((now) => FMT.sessionDate(iso(now), DUB))).toEqual(days)
    expect(PINS.map((now) => FMT.sessionDate(iso(now)))).toEqual(days)
    expect(PINS.map((now) => SC.cardModel({ summary: {}, session: { started_at: iso(now) } }, { name: 'A B' }, DUB).dateLabel))
      .toEqual(['29 Mar', '30 Mar', '2 Jul', '25 Oct', '25 Oct', '15 Jan'])
    expect(SC.cardModel({ summary: {}, session: { started_at: iso(PINS[2]) } }, { name: 'A B' }, DUB).name).toBe('A B.')
    expect(PINS.map((now) => CK.kudosRelativeTime(now - 60 * DAY, now, DUB))).toEqual(['28 Jan', '28 Jan', '3 May', '26 Aug', '27 Aug', '16 Nov'])
    expect(CK.kudosRelativeTime(PINS[0] - 2 * DAY, PINS[0], DUB)).toBe('2d ago')
    expect(CK.kudosRelativeTime(PINS[0] - 3 * HOUR, PINS[0], DUB)).toBe('3h ago')
    expect(FMT.sessionDate('', DUB)).toBe('')
    expect(FMT.sessionDate('not a date', DUB)).toBe('')
  })

  it('hr-session-report: buildSessionReport', () => {
    const now = PINS[2]
    const h = historyAt(now)
    const ctx = { session: { ...h[0], source: 'ble_bridge' }, thisSession: h[0], history: h, eventTypeName: 'HIIT', shortName: 'S' }
    const r = HSR.buildSessionReport(ctx, { nowMs: now }, DUB)
    expect(r.highlight).toStrictEqual({ id: 'streak', message: '4-day streak — keep it rolling.' })
    expect(r.session).toMatchObject({ started_at: '2026-07-01T23:00:00.000Z', duration_seconds: 2700 })
    expect(r.achievements).toEqual([])
  })
})

describe('TZ.13 America/New_York follows New York across DST', () => {
  it("a NY member's streak counts a 23:30 EDT session on the NY day", () => {
    const sessions = [
      { started_at: '2026-07-10T03:30:00Z' }, // 23:30 EDT Thu 9 Jul (04:30 IST Fri 10 Jul)
      { started_at: '2026-07-08T16:00:00Z' }, // 12:00 EDT Wed 8 Jul
    ]
    const now = Date.parse('2026-07-10T12:00:00Z') // 08:00 EDT Fri 10 Jul
    expect(HA.currentStreak(sessions, now, NY)).toMatchObject({ current: 2, best: 2 })
    expect(HA.currentStreak(sessions, now, DUB)).toMatchObject({ current: 1, best: 1 })
    // ...and streakAtRisk sees a 2-day run ending NY-yesterday.
    expect(CN.streakAtRisk(sessions, now, 2, NY)).toBe(2)
    expect(CN.streakAtRisk(sessions, now, 2, DUB)).toBe(0)
  })

  it('a 7-day challenge in a NY studio ending 2026-11-01 spans 7 days + 1 hour', () => {
    const ch = { starts_on: '2026-10-26', ends_on: '2026-11-01' }
    const { fromIso, toIso } = CH.windowIso(ch, NY)
    expect(fromIso).toBe('2026-10-26T04:00:00.000Z') // 00:00 EDT
    expect(toIso).toBe('2026-11-02T05:00:00.000Z') // 00:00 EST
    expect(Date.parse(toIso) - Date.parse(fromIso)).toBe(7 * DAY + HOUR)
    expect(CH.challengePhase(ch, Date.parse('2026-11-02T04:59:59Z'), NY)).toBe('active')
    expect(CH.challengePhase(ch, Date.parse('2026-11-02T05:00:00Z'), NY)).toBe('ended')
    expect(CH.challengePhase(ch, Date.parse('2026-10-26T03:59:59Z'), NY)).toBe('upcoming')
  })

  it('across spring-forward a NY challenge window is 23 hours short', () => {
    const { fromIso, toIso } = CH.windowIso({ starts_on: '2026-03-02', ends_on: '2026-03-08' }, NY)
    expect(fromIso).toBe('2026-03-02T05:00:00.000Z')
    expect(toIso).toBe('2026-03-09T04:00:00.000Z')
  })

  it('challenges_read pairing: the finisher is offered for 14 NY days after the NY close', () => {
    const ch = { is_flagship: true, starts_on: '2026-10-26', ends_on: '2026-11-01' }
    const close = Date.parse('2026-11-02T05:00:00Z')
    expect(CW.endedRecentlyFlagship(ch, close - 1, 14, NY)).toBe(false)
    expect(CW.endedRecentlyFlagship(ch, close, 14, NY)).toBe(true)
    expect(CW.endedRecentlyFlagship(ch, close + 14 * DAY - 1, 14, NY)).toBe(true)
    expect(CW.endedRecentlyFlagship(ch, close + 14 * DAY, 14, NY)).toBe(false)
    expect(CW.challengeWindowMs(ch, NY)).toStrictEqual({ fromMs: Date.parse('2026-10-26T04:00:00Z'), toMs: close })
  })

  it('member push keys roll at NY midnight, not Dublin midnight', () => {
    // 23:30 EDT Sun 31 May = 04:30 IST Mon 1 Jun.
    const t = Date.parse('2026-06-01T03:30:00Z')
    expect(CN.periodKey('month', t, NY)).toBe('2026-05')
    expect(CN.periodKey('month', t, DUB)).toBe('2026-06')
    expect(CN.periodKey('week', t, NY)).toBe('2026-W22')
    expect(CN.periodKey('week', t, DUB)).toBe('2026-W23')
  })

  it('goal weeks start Monday 00:00 New York, in EST and in EDT', () => {
    expect(GO.startOfIsoWeek(new Date('2026-03-09T12:00:00Z'), NY).toISOString()).toBe('2026-03-09T04:00:00.000Z') // EDT
    expect(GO.startOfIsoWeek(new Date('2026-03-08T12:00:00Z'), NY).toISOString()).toBe('2026-03-02T05:00:00.000Z') // EST
    expect(GO.startOfMonth(new Date('2026-11-01T03:30:00Z'), NY).toISOString()).toBe('2026-10-01T04:00:00.000Z')
    expect(GO.periodEnd('month', new Date('2026-10-01T04:00:00Z'), NY).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(GO.periodEnd('week', new Date('2026-03-02T05:00:00Z'), NY).toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('the weekly digest covers the last completed NY week', () => {
    const now = Date.parse('2026-03-09T04:30:00Z') // 00:30 EDT Mon 9 Mar
    const sessions = [
      { started_at: '2026-03-09T03:30:00Z', ended_at: '2026-03-09T04:00:00Z', effort_points: 10 }, // 23:30 EDT Sun 8 Mar → in
      { started_at: '2026-03-02T04:30:00Z', ended_at: '2026-03-02T05:00:00Z', effort_points: 20 }, // 23:30 EST Sun 1 Mar → out
    ]
    const m = WD.weekDigestModel(sessions, now, {}, NY)
    expect(m.weekKey).toBe('2026-W10')
    expect(m.classes).toBe(1)
    expect(m.points).toBe(10)
  })

  it('month wrapped and the tier window use the NY month', () => {
    const t = Date.parse('2026-11-01T03:30:00Z') // 23:30 EDT Sat 31 Oct
    expect(MW.monthWrappedKey(t, NY)).toBe('2026-09')
    expect(MW.monthWrappedKey(t, DUB)).toBe('2026-10')
    expect([...TW.windowMonthKeys(2, t, NY)]).toEqual(['2026-10', '2026-09'])
    expect([...TW.windowMonthKeys(2, t, DUB)]).toEqual(['2026-11', '2026-10'])
  })

  it('heatmap, history months and labels render the NY day', () => {
    const now = Date.parse('2026-11-01T06:00:00Z') // 01:00 EST Sun 1 Nov (after fall-back)
    const s = { started_at: '2026-11-01T03:30:00Z', ended_at: '2026-11-01T04:00:00Z', effort_points: 5 } // 23:30 EDT Sat 31 Oct
    const cal = PA.activityCalendar([s], now, 2, NY)
    expect(cal.days.map((d) => [d.dateKey, d.count])).toEqual([['2026-10-31', 1], ['2026-11-01', 0]])
    expect(cal.days[1].dayMs).toBe(Date.parse('2026-11-01T04:00:00Z')) // 00:00 EDT
    const items = [{ kind: 'session', key: 'a', sortMs: Date.parse(s.started_at), session: s }]
    expect(SH.groupSessionsByMonth(items, NY)[0].monthKey).toBe('2026-10')
    expect(SH.groupSessionsByMonth(items, DUB)[0].monthKey).toBe('2026-11')
    expect(FMT.sessionDate(s.started_at, NY)).toBe('Sat, 31 Oct')
    expect(SC.cardModel({ summary: {}, session: { started_at: s.started_at } }, {}, NY).dateLabel).toBe('31 Oct')
    expect(CK.kudosRelativeTime('2026-08-01T03:30:00Z', now, NY)).toBe('31 Jul')
  })
})
