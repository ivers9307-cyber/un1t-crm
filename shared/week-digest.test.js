import { describe, it, expect } from 'vitest'
import { weekDigestModel } from './week-digest.js'
import { weekStartMsIn } from './zoned-time.js'

// Reference "now": Wed 2026-07-08 12:00 IST (2026-07-08T11:00:00Z). This week's
// Dublin Monday = 2026-07-06 00:00 IST = 2026-07-05T23:00:00Z. The LAST completed
// week is therefore Mon 2026-06-29 00:00 IST → Mon 2026-07-06 00:00 IST, i.e.
//   [2026-06-28T23:00:00Z, 2026-07-05T23:00:00Z)  (IST, UTC+1)
const NOW = Date.parse('2026-07-08T11:00:00Z')

// zones_seconds that clears the Burn threshold (>=720s in Z4+Z5) and one that
// doesn't. isBurn keys on Z4+Z5 combined.
const BURN_ZONES = { 4: 500, 5: 400 } // 900s ≥ 720 → Burn
const NO_BURN_ZONES = { 4: 100, 5: 100 } // 200s < 720 → no Burn

// A completed session row inside/around last week.
const sess = (started_at, effort_points, zones_seconds = NO_BURN_ZONES) => ({
  started_at, ended_at: started_at, effort_points, zones_seconds,
})

describe('weekDigestModel — last completed Dublin week', () => {
  it('sums classes / points / burns for last week and reports the range label + ISO key', () => {
    const m = weekDigestModel([
      sess('2026-06-29T09:00:00.000Z', 40, BURN_ZONES),   // Mon last week — Burn
      sess('2026-07-01T18:00:00.000Z', 55, NO_BURN_ZONES),// Wed last week
      sess('2026-07-04T10:00:00.000Z', 30, BURN_ZONES),   // Sat last week — Burn
    ], NOW)

    expect(m.hasContent).toBe(true)
    expect(m.classes).toBe(3)
    expect(m.points).toBe(125)
    expect(m.burnCount).toBe(2)
    expect(m.earnedBurn).toBe(true)
    expect(m.bestSessionPoints).toBe(55)
    expect(m.weekKey).toBe('2026-W27') // ISO week of Mon 2026-06-29
    expect(m.weekLabel).toBe('29 Jun–5 Jul')
    expect(m.leagueFinish).toBeNull() // none passed
  })

  it('DUBLIN BOUNDARY: a Sun 23:55 session lands in last week; a Mon 00:05 session is THIS week (excluded)', () => {
    const m = weekDigestModel([
      // Sun 2026-07-05 23:55 IST = 2026-07-05T22:55:00Z — the minute before the
      // this-week Monday boundary → belongs to LAST week. Counted.
      sess('2026-07-05T22:55:00.000Z', 77, NO_BURN_ZONES),
      // Mon 2026-07-06 00:05 IST = 2026-07-05T23:05:00Z — just after the boundary
      // → THIS (current) week, not the completed one. Excluded.
      sess('2026-07-05T23:05:00.000Z', 999, NO_BURN_ZONES),
    ], NOW)

    expect(m.classes).toBe(1)
    expect(m.points).toBe(77)
  })

  it('DUBLIN BOUNDARY (start edge): Sun-before at 23:55 is the PRIOR week (excluded); Mon 00:05 of last week is included', () => {
    const m = weekDigestModel([
      // Sun 2026-06-28 23:55 IST = 2026-06-28T22:55:00Z — minute before last
      // week's Monday start → the week before last. Excluded.
      sess('2026-06-28T22:55:00.000Z', 500, NO_BURN_ZONES),
      // Mon 2026-06-29 00:05 IST = 2026-06-28T23:05:00Z — just inside last week.
      sess('2026-06-28T23:05:00.000Z', 12, NO_BURN_ZONES),
    ], NOW)

    expect(m.classes).toBe(1)
    expect(m.points).toBe(12)
  })

  it('one session — hasContent true, bestSessionPoints == that session', () => {
    const m = weekDigestModel([sess('2026-07-02T12:00:00.000Z', 42, NO_BURN_ZONES)], NOW)
    expect(m.hasContent).toBe(true)
    expect(m.classes).toBe(1)
    expect(m.points).toBe(42)
    expect(m.bestSessionPoints).toBe(42)
    expect(m.earnedBurn).toBe(false)
    expect(m.burnCount).toBe(0)
  })

  it('empty week — hasContent false, all counters zero (never show an empty recap)', () => {
    // Sessions exist but all in THIS week / long ago, none in last week.
    const m = weekDigestModel([
      sess('2026-07-07T09:00:00.000Z', 60),          // this week
      sess('2026-05-01T09:00:00.000Z', 60),          // ancient
    ], NOW)
    expect(m.hasContent).toBe(false)
    expect(m.classes).toBe(0)
    expect(m.points).toBe(0)
    expect(m.bestSessionPoints).toBe(0)
    expect(m.earnedBurn).toBe(false)
  })

  it('no sessions array at all — safe, empty model', () => {
    const m = weekDigestModel(undefined, NOW)
    expect(m.hasContent).toBe(false)
    expect(m.classes).toBe(0)
    expect(typeof m.weekKey).toBe('string')
    expect(typeof m.weekLabel).toBe('string')
  })

  it('ignores un-ended (in-progress) sessions even inside the window', () => {
    const m = weekDigestModel([
      { started_at: '2026-07-01T18:00:00.000Z', ended_at: null, effort_points: 50, zones_seconds: NO_BURN_ZONES },
      sess('2026-07-02T18:00:00.000Z', 20, NO_BURN_ZONES),
    ], NOW)
    expect(m.classes).toBe(1)
    expect(m.points).toBe(20)
  })

  it('threads a valid league finish through; drops a malformed one', () => {
    const rows = [sess('2026-07-01T18:00:00.000Z', 30)]
    expect(weekDigestModel(rows, NOW, { leagueFinish: { rank: 2, of: 5 } }).leagueFinish).toEqual({ rank: 2, of: 5 })
    // rank > of is nonsense → dropped.
    expect(weekDigestModel(rows, NOW, { leagueFinish: { rank: 6, of: 5 } }).leagueFinish).toBeNull()
    // non-numeric → dropped.
    expect(weekDigestModel(rows, NOW, { leagueFinish: { rank: 'x', of: 5 } }).leagueFinish).toBeNull()
    // absent → null.
    expect(weekDigestModel(rows, NOW).leagueFinish).toBeNull()
  })

  it('DST week: last-completed week Monday boundary is exact across spring-forward', () => {
    // Dublin springs forward Sun 2026-03-29 01:00→02:00. "now" = Tue 2026-03-31.
    // This week's Monday = 2026-03-30 00:00 IST = 2026-03-29T23:00:00Z. LAST week =
    // Mon 2026-03-23 00:00 GMT (00:00 UTC) → Mon 2026-03-30 00:00 IST (23:00Z).
    const dstNow = Date.parse('2026-03-31T10:00:00Z')
    const m = weekDigestModel([
      // Sun 2026-03-29 23:55 IST = 2026-03-29T22:55:00Z — minute before this-week
      // Monday boundary → LAST week. Counted.
      sess('2026-03-29T22:55:00.000Z', 33, NO_BURN_ZONES),
      // Mon 2026-03-30 00:05 IST = 2026-03-29T23:05:00Z — THIS week. Excluded.
      sess('2026-03-29T23:05:00.000Z', 888, NO_BURN_ZONES),
    ], dstNow)
    expect(m.classes).toBe(1)
    expect(m.points).toBe(33)
  })
})

// TZ follow-up (approved 11 Oct): the label's last day used to be the exclusive
// upper bound minus 24h. A spring-forward week is only 167h long, so that landed
// on SATURDAY 23:00 local and the card read "23 Mar–28 Mar". The last day is now
// counted on the calendar (Monday's date key + 6 days), so it is always Sunday.
describe('weekDigestModel — weekLabel spans Monday to Sunday on the calendar', () => {
  const DUB = 'Europe/Dublin'
  const NY = 'America/New_York'
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  // 'YYYY-MM-DD' → 'D Mon', computed with UTC calendar arithmetic only.
  const dayLabel = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d))
    return `${t.getUTCDate()} ${MON[t.getUTCMonth()]}`
  }
  // Every Monday of 2026 (5 Jan … 28 Dec) with the label a calendar gives it.
  const MONDAYS_2026 = []
  for (let d = 5; d <= 362; d += 7) {
    MONDAYS_2026.push({ y: 2026, m: 1, d, label: `${dayLabel(2026, 1, d)}–${dayLabel(2026, 1, d + 6)}` })
  }
  // An instant mid-week AFTER the recapped week: that Monday + 9 days, 12:00Z.
  const nowAfter = ({ y, m, d }) => Date.UTC(y, m - 1, d + 9, 12)

  it('Europe/Dublin spring-forward week (clocks change Sun 29 Mar 2026) reads 23 Mar–29 Mar', () => {
    const m = weekDigestModel([], Date.parse('2026-04-01T12:00:00Z'), {}, DUB)
    expect(m.weekKey).toBe('2026-W13')
    expect(m.weekLabel).toBe('23 Mar–29 Mar') // was '23 Mar–28 Mar'
    // zone omitted = the platform default, same answer
    expect(weekDigestModel([], Date.parse('2026-04-01T12:00:00Z')).weekLabel).toBe('23 Mar–29 Mar')
  })

  it('America/New_York spring-forward week (clocks change Sun 8 Mar 2026) reads 2 Mar–8 Mar', () => {
    const m = weekDigestModel([], Date.parse('2026-03-11T16:00:00Z'), {}, NY)
    expect(m.weekKey).toBe('2026-W10')
    expect(m.weekLabel).toBe('2 Mar–8 Mar') // was '2 Mar–7 Mar'
  })

  it('fall-back weeks were already right and stay right', () => {
    expect(weekDigestModel([], Date.parse('2026-10-28T12:00:00Z'), {}, DUB).weekLabel).toBe('19 Oct–25 Oct')
    expect(weekDigestModel([], Date.parse('2026-11-04T12:00:00Z'), {}, NY).weekLabel).toBe('26 Oct–1 Nov')
  })

  for (const zone of [DUB, NY]) {
    it(`${zone}: every week of 2026 is labelled Monday to Sunday`, () => {
      expect(MONDAYS_2026).toHaveLength(52)
      for (const w of MONDAYS_2026) {
        expect(weekDigestModel([], nowAfter(w), {}, zone).weekLabel, w.label).toBe(w.label)
      }
    })
  }

  it('the spring week is the ONLY 2026 label that changed (old rule recomputed here)', () => {
    // The pre-fix rule: last day = the local day of (this Monday 00:00 local - 24h).
    const fmt = (ms, zone) => {
      const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(ms).split('-').map(Number)
      return dayLabel(y, m, d)
    }
    const changed = (zone) => MONDAYS_2026.filter((w) => {
      const now = nowAfter(w)
      const oldLast = fmt(weekStartMsIn(now, zone) - 24 * 3600 * 1000, zone)
      return !weekDigestModel([], now, {}, zone).weekLabel.endsWith(`–${oldLast}`)
    }).map((w) => w.label)
    expect(changed(DUB)).toEqual(['23 Mar–29 Mar'])
    expect(changed(NY)).toEqual(['2 Mar–8 Mar'])
  })
})
