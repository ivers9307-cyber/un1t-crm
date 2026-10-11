// member-zone.tz.test.js — TZ.13: the member seam (streaks, challenges, goals,
// weekly digests, month wrapped, member push keys) takes a zone. D7: a
// member's zone is their home studio's (contacts.location_id); a challenge's
// window is its own studio's (challenges.location_id).
//
// Two halves, as every sweep: (1) Europe/Dublin is byte-identical to the
// frozen pre-change modules (./*.legacy-dublin.test-helpers.js) over the
// DST-edge samples and every day of 2026; (2) America/New_York follows New
// York's clock across both 2026 US DST changes. Relative imports only, so this
// file is byte-identical in champ-app's shared/.
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

const L = {
  CH: await import('./challenges.legacy-dublin.test-helpers.js'),
  CW: await import('./challenge-wrapped.legacy-dublin.test-helpers.js'),
  CK: await import('./coach-kudos.legacy-dublin.test-helpers.js'),
  CN: await import('./customer-notifications.legacy-dublin.test-helpers.js'),
  FMT: await import('./format.legacy-dublin.test-helpers.js'),
  GO: await import('./goals.legacy-dublin.test-helpers.js'),
  HA: await import('./hr-analytics.legacy-dublin.test-helpers.js'),
  HSR: await import('./hr-session-report.legacy-dublin.test-helpers.js'),
  MW: await import('./month-wrapped.legacy-dublin.test-helpers.js'),
  PA: await import('./progress-analytics.legacy-dublin.test-helpers.js'),
  SH: await import('./session-history.legacy-dublin.test-helpers.js'),
  SC: await import('./share-card.legacy-dublin.test-helpers.js'),
  TW: await import('./tier-window.legacy-dublin.test-helpers.js'),
  WD: await import('./week-digest.legacy-dublin.test-helpers.js'),
}

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const HOUR = 3_600_000
const DAY = 86_400_000
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', // NY around spring-forward
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', // Dublin around spring-forward
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', // Dublin around fall-back
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', // NY around fall-back
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z', // month/year edges
].map(Date.parse)
const DAYS_2026 = (() => {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += DAY) out.push(new Date(t).toISOString().slice(0, 10))
  return out
})()
// Two instants per day of 2026 straddling Dublin midnight in summer AND winter
// (23:30Z is 00:30 IST the next day; 00:30Z is 00:30 GMT / 01:30 IST), plus the samples.
const NOWS = [
  ...SAMPLES,
  ...DAYS_2026.flatMap((d) => [Date.parse(`${d}T00:30:00Z`), Date.parse(`${d}T23:30:00Z`)]),
]
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

describe('TZ.13 Europe/Dublin is byte-identical (explicit zone AND omitted zone)', () => {
  it('hr-analytics: currentStreak / weeklyStreak / buildSessionAnalytics', () => {
    for (const now of NOWS) {
      const h = historyAt(now)
      const want = L.HA.currentStreak(h, now)
      expect(HA.currentStreak(h, now, DUB)).toStrictEqual(want)
      expect(HA.currentStreak(h, now)).toStrictEqual(want)
      const wk = L.HA.weeklyStreak(h, { nowMs: now })
      expect(HA.weeklyStreak(h, { nowMs: now }, DUB)).toStrictEqual(wk)
      expect(HA.weeklyStreak(h, { nowMs: now, minPerWeek: 2 }, DUB)).toStrictEqual(L.HA.weeklyStreak(h, { nowMs: now, minPerWeek: 2 }))
      const args = { thisSession: h[0], history: h, eventTypeName: 'HIIT', nowMs: now, shortName: 'X' }
      expect(HA.buildSessionAnalytics(args, DUB)).toStrictEqual(L.HA.buildSessionAnalytics(args))
      expect(HA.pickHighlight(args, DUB)).toStrictEqual(L.HA.pickHighlight(args))
    }
  })

  it('customer-notifications: periodKey + streakAtRisk', () => {
    for (const now of NOWS) {
      expect(CN.periodKey('month', now, DUB)).toBe(L.CN.periodKey('month', now))
      expect(CN.periodKey('week', now, DUB)).toBe(L.CN.periodKey('week', now))
      expect(CN.periodKey('week', now)).toBe(L.CN.periodKey('week', now))
      // The history minus today's session: a run ending yesterday.
      const h = historyAt(now).slice(1)
      expect(CN.streakAtRisk(h, now, 2, DUB)).toBe(L.CN.streakAtRisk(h, now, 2))
      expect(CN.streakAtRisk(h, now, 1)).toBe(L.CN.streakAtRisk(h, now, 1))
    }
  })

  it('goals: startOfIsoWeek / startOfMonth / computeProgress / periodEnd', () => {
    const goal = { id: 'g', kind: 'weekly_points', target_value: 300 }
    const mgoal = { id: 'm', kind: 'monthly_classes', target_value: 4 }
    for (const now of NOWS) {
      const d = new Date(now)
      expect(GO.startOfIsoWeek(d, DUB)).toStrictEqual(L.GO.startOfIsoWeek(d))
      expect(GO.startOfMonth(d, DUB)).toStrictEqual(L.GO.startOfMonth(d))
      expect(GO.computeProgress(goal, historyAt(now), d, DUB)).toStrictEqual(L.GO.computeProgress(goal, historyAt(now), d))
      expect(GO.computeProgress(mgoal, historyAt(now), d)).toStrictEqual(L.GO.computeProgress(mgoal, historyAt(now), d))
      expect(GO.periodEnd('week', L.GO.startOfIsoWeek(d), DUB)).toStrictEqual(L.GO.periodEnd('week', L.GO.startOfIsoWeek(d)))
      expect(GO.periodEnd('month', L.GO.startOfMonth(d), DUB)).toStrictEqual(L.GO.periodEnd('month', L.GO.startOfMonth(d)))
    }
  })

  // The ONE deliberate Dublin difference: a challenge ending on the clocks-back
  // Sunday. The old end (midnight + 24h) landed at 23:00 that SAME day, so the
  // challenge's last day was cut (DUBLINDAY.1's shape). 0 live challenges end
  // on such a day (checked 11 Oct 2026: one challenge, 20 Jun → 4 Jul 2026).
  const CLOCKS_BACK = new Set(['2026-10-25'])
  it('challenges: challengePhase / windowIso for every 2026 end date (clocks-back Sunday aside)', () => {
    for (const ends_on of DAYS_2026) {
      if (CLOCKS_BACK.has(ends_on)) continue
      const ch = { starts_on: '2026-01-05', ends_on }
      expect(CH.windowIso(ch, DUB)).toStrictEqual(L.CH.windowIso(ch))
      expect(CH.windowIso(ch)).toStrictEqual(L.CH.windowIso(ch))
      for (const now of SAMPLES) expect(CH.challengePhase(ch, now, DUB)).toBe(L.CH.challengePhase(ch, now))
      const end = Date.parse(L.CH.windowIso(ch).toIso)
      for (const now of [end - 1, end, end + 14 * DAY - 1, end + 14 * DAY]) {
        expect(CH.challengePhase(ch, now, DUB)).toBe(L.CH.challengePhase(ch, now))
        const fl = { ...ch, is_flagship: true }
        expect(CW.endedRecentlyFlagship(fl, now, 14, DUB)).toBe(L.CW.endedRecentlyFlagship(fl, now, 14))
        expect(CW.ownWindowStats(historyAt(end - DAY), fl, now, DUB)).toStrictEqual(L.CW.ownWindowStats(historyAt(end - DAY), fl, now))
        expect(CW.challengeWrappedModel({ challenge: fl, sessions: historyAt(end - DAY), nowMs: now }, DUB))
          .toStrictEqual(L.CW.challengeWrappedModel({ challenge: fl, sessions: historyAt(end - DAY), nowMs: now }))
      }
    }
  })

  it('challenges: a challenge ending on the clocks-back Sunday now keeps its last day', () => {
    const ch = { starts_on: '2026-10-19', ends_on: '2026-10-25' }
    // Old: ended at 00:00 IST on the 25th (2026-10-24T23:00Z), dropping the 25th.
    expect(L.CH.windowIso(ch).toIso).toBe('2026-10-24T23:00:00.000Z')
    // New: 00:00 GMT on the 26th — the whole 25-hour Sunday is in.
    expect(CH.windowIso(ch, DUB)).toStrictEqual({ fromIso: '2026-10-18T23:00:00.000Z', toIso: '2026-10-26T00:00:00.000Z' })
    expect(CH.challengePhase(ch, Date.parse('2026-10-25T12:00:00Z'), DUB)).toBe('active')
  })

  it('month-wrapped: monthWrappedKey / monthWrappedModel', () => {
    for (const now of NOWS) {
      expect(MW.monthWrappedKey(now, DUB)).toBe(L.MW.monthWrappedKey(now))
      expect(MW.monthWrappedKey(now)).toBe(L.MW.monthWrappedKey(now))
      const recap = PA.monthlyRecap(historyAt(now - 20 * DAY), now, 6)
      const records = PA.personalRecords(historyAt(now - 20 * DAY), DUB)
      expect(MW.monthWrappedModel(recap, records, now, DUB)).toStrictEqual(L.MW.monthWrappedModel(recap, records, now))
    }
  })

  it('progress-analytics: activityCalendar / personalRecords', () => {
    for (const now of NOWS) {
      const h = historyAt(now)
      expect(PA.activityCalendar(h, now, 14, DUB)).toStrictEqual(L.PA.activityCalendar(h, now, 14))
      // TZ.17 ⚠️ moved the best-week bucket onto the Dublin week: it differs
      // from the frozen UTC week only when a session falls 00:00-01:00 IST
      // (pinned in src/lib/tz-17.dublin.test.js).
      const midnightHour = h.some((x) => new Date(x.started_at).getUTCHours() === 23 && x.started_at.slice(0, 10) !== new Intl.DateTimeFormat('en-CA', { timeZone: DUB }).format(new Date(x.started_at)))
      const { bestWeekPoints, ...rest } = PA.personalRecords(h, DUB)
      const { bestWeekPoints: legacyBestWeek, ...legacyRest } = L.PA.personalRecords(h)
      expect(rest).toStrictEqual(legacyRest)
      if (!midnightHour) expect(bestWeekPoints).toStrictEqual(legacyBestWeek)
    }
    const now = Date.parse('2026-12-31T23:30:00Z')
    expect(PA.activityCalendar(historyAt(now), now, 364)).toStrictEqual(L.PA.activityCalendar(historyAt(now), now, 364))
  })

  it('session-history: groupSessionsByMonth / lifetimeMilestones', () => {
    for (const now of NOWS) {
      const items = historyAt(now).map((s, i) => ({ kind: 'session', key: `k${i}`, sortMs: Date.parse(s.started_at), session: s }))
      expect(SH.groupSessionsByMonth(items, DUB)).toStrictEqual(L.SH.groupSessionsByMonth(items))
      const h = historyAt(now)
      expect(SH.lifetimeMilestones(h, now, { brand: 'B', shortName: 'S' }, DUB)).toStrictEqual(L.SH.lifetimeMilestones(h, now, { brand: 'B', shortName: 'S' }))
    }
  })

  it('tier-window: windowMonthKeys / monthsHitInWindow / resolveTierMonths', () => {
    for (const now of NOWS) {
      expect(TW.windowMonthKeys(3, now, DUB)).toStrictEqual(L.TW.windowMonthKeys(3, now))
      expect(TW.monthsHitInWindow(['2026-01', '2026-03', '2026-10', '2026-11'], 2, now, DUB))
        .toBe(L.TW.monthsHitInWindow(['2026-01', '2026-03', '2026-10', '2026-11'], 2, now))
      const a = { hitMonthKeys: ['2026-06', '2026-07'], cumulativeMonths: 5, windowMonths: 2, nowMs: now }
      expect(TW.resolveTierMonths(a, DUB)).toBe(L.TW.resolveTierMonths(a))
    }
  })

  it('week-digest: weekDigestModel', () => {
    for (const now of NOWS) {
      const h = historyAt(now).concat(historyAt(now - 5 * DAY))
      expect(WD.weekDigestModel(h, now, { leagueFinish: { rank: 2, of: 5 } }, DUB))
        .toStrictEqual(L.WD.weekDigestModel(h, now, { leagueFinish: { rank: 2, of: 5 } }))
      expect(WD.weekDigestModel(h, now)).toStrictEqual(L.WD.weekDigestModel(h, now))
    }
  })

  it('format.sessionDate / share-card.cardModel / coach-kudos.kudosRelativeTime', () => {
    for (const now of NOWS) {
      expect(FMT.sessionDate(iso(now), DUB)).toBe(L.FMT.sessionDate(iso(now)))
      expect(FMT.sessionDate(iso(now))).toBe(L.FMT.sessionDate(iso(now)))
      const report = { summary: {}, session: { started_at: iso(now) } }
      expect(SC.cardModel(report, { name: 'A B' }, DUB)).toStrictEqual(L.SC.cardModel(report, { name: 'A B' }))
      expect(CK.kudosRelativeTime(now - 60 * DAY, now, DUB)).toBe(L.CK.kudosRelativeTime(now - 60 * DAY, now))
      expect(CK.kudosRelativeTime(now - 3 * HOUR, now, DUB)).toBe(L.CK.kudosRelativeTime(now - 3 * HOUR, now))
    }
    expect(FMT.sessionDate('', DUB)).toBe('')
    expect(FMT.sessionDate('not a date', DUB)).toBe(L.FMT.sessionDate('not a date'))
  })

  it('hr-session-report: buildSessionReport', () => {
    for (const now of SAMPLES) {
      const h = historyAt(now)
      const ctx = { session: { ...h[0], source: 'ble_bridge' }, thisSession: h[0], history: h, eventTypeName: 'HIIT', shortName: 'S' }
      expect(HSR.buildSessionReport(ctx, { nowMs: now }, DUB)).toStrictEqual(L.HSR.buildSessionReport(ctx, { nowMs: now }))
    }
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
