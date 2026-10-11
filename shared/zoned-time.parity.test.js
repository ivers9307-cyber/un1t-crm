// TZ.1 — every zoned-time twin is byte-identical to its dublin-time original
// for Europe/Dublin, over every hour of 2025-2027 and every calendar day.
// This is the contract that makes every later sweep (TZ.4–TZ.17) safe: a
// caller moved from dublin*() to *In(…, 'Europe/Dublin') cannot change output.
process.env.TZ = 'America/Los_Angeles' // the host zone must not matter
import { describe, it, expect, vi } from 'vitest'
// ~27k instants × two twins: fast locally, but a loaded CI shard blew the 5 s default.
vi.setConfig({ testTimeout: 60_000 })
const Z = await import('./zoned-time.js')
const S = await import('./dublin-time.js')
const W = await import('../src/lib/dublin-time.js')
const D = 'Europe/Dublin'

const HOURS = []
for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += 3600_000) HOURS.push(t)
// plus every DST-edge minute in Dublin 2025-2027
for (const edge of ['2025-03-30T01:00:00Z', '2025-10-26T01:00:00Z', '2026-03-29T01:00:00Z',
  '2026-10-25T01:00:00Z', '2027-03-28T01:00:00Z', '2027-10-31T01:00:00Z']) {
  for (let m = -90; m <= 90; m++) HOURS.push(Date.parse(edge) + m * 60_000)
}
const DAYS = []
for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += 86_400_000) DAYS.push(new Date(t).toISOString().slice(0, 10))
const ODD_INPUTS = [null, 0, '2026-07-01T23:30:00+01:00', new Date('2026-10-25T00:30:00Z'), '2026-02-30', 'not a date']

// Same value, or the same error class. Counted rather than asserted per call
// (27k × several expect() calls is slow and a failure would drown the report):
// each `it` asserts its mismatch list is empty and prints the first few.
function sameAll(pairs) {
  const bad = []
  for (const [label, a, b] of pairs) {
    let ea, eb, ra, rb
    try { ra = a() } catch (e) { ea = e.constructor.name }
    try { rb = b() } catch (e) { eb = e.constructor.name }
    if (ea !== eb || JSON.stringify(ra) !== JSON.stringify(rb) || typeof ra !== typeof rb) {
      bad.push(`${label}: zoned=${ea ?? JSON.stringify(ra)} dublin=${eb ?? JSON.stringify(rb)}`)
    }
  }
  return bad
}
const fmtT = (t) => (typeof t === 'number' ? new Date(t).toISOString() : String(t))

describe('instant → key twins', () => {
  it('dayStrIn ≡ dublinDayStr', () => {
    const bad = sameAll([...HOURS, ...ODD_INPUTS].map((t) => [fmtT(t), () => Z.dayStrIn(t, D), () => W.dublinDayStr(t)]))
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('dateKeyIn ≡ dublinDateKey (both copies)', () => {
    const bad = sameAll([...HOURS, ...ODD_INPUTS].flatMap((t) => [
      [`shared ${fmtT(t)}`, () => Z.dateKeyIn(t, D), () => S.dublinDateKey(t)],
      [`web ${fmtT(t)}`, () => Z.dateKeyIn(t, D), () => W.dublinDateKey(t)],
    ]))
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('monthStrIn ≡ dublinMonthStr, monthKeyIn ≡ dublinMonthKey', () => {
    const bad = sameAll(HOURS.flatMap((t) => [
      [`monthStr ${fmtT(t)}`, () => Z.monthStrIn(t, D), () => W.dublinMonthStr(t)],
      [`monthKey ${fmtT(t)}`, () => Z.monthKeyIn(t, D), () => S.dublinMonthKey(t)],
    ]))
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('isoWeekKeyIn ≡ dublinIsoWeekKey', () => {
    const bad = sameAll(HOURS.map((t) => [fmtT(t), () => Z.isoWeekKeyIn(t, D), () => S.dublinIsoWeekKey(t)]))
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('weekStartMsIn ≡ dublinWeekStartMs, monthStartMsIn ≡ dublinMonthStartMs', () => {
    const bad = sameAll(HOURS.flatMap((t) => [
      [`weekStart ${fmtT(t)}`, () => Z.weekStartMsIn(t, D), () => S.dublinWeekStartMs(t)],
      [`monthStart ${fmtT(t)}`, () => Z.monthStartMsIn(t, D), () => S.dublinMonthStartMs(t)],
    ]))
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('timeLabelIn ≡ dublinTimeLabel', () => {
    const bad = sameAll([
      ...HOURS.map((t) => [fmtT(t), () => Z.timeLabelIn(new Date(t).toISOString(), D), () => W.dublinTimeLabel(new Date(t).toISOString())]),
      ...[null, '', 'garbage', undefined].map((v) => [String(v), () => Z.timeLabelIn(v, D), () => W.dublinTimeLabel(v)]),
    ])
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('nowMinutesIn ≡ dublinNowMinutes at every sampled instant', () => {
    vi.useFakeTimers()
    try {
      const bad = []
      for (const t of HOURS) {
        vi.setSystemTime(t)
        bad.push(...sameAll([[fmtT(t), () => Z.nowMinutesIn(D), () => W.dublinNowMinutes()]]))
        // the explicit-clock form agrees with the implicit one
        bad.push(...sameAll([[`nowMs ${fmtT(t)}`, () => Z.nowMinutesIn(D, t), () => W.dublinNowMinutes()]]))
      }
      expect(bad.slice(0, 5)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('todayStrIn ≡ dublinTodayStr at every sampled instant', () => {
    vi.useFakeTimers()
    try {
      const bad = []
      for (const t of HOURS) {
        vi.setSystemTime(t)
        bad.push(...sameAll([[fmtT(t), () => Z.todayStrIn(D), () => W.dublinTodayStr()]]))
        bad.push(...sameAll([[`nowMs ${fmtT(t)}`, () => Z.todayStrIn(D, t), () => W.dublinTodayStr()]]))
      }
      expect(bad.slice(0, 5)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('day → instant twins', () => {
  it('dayStartMsIn ≡ dublinDayStartMs (string and parts input, incl. rollover dates)', () => {
    const bad = sameAll([...DAYS, '2026-02-30', '2026-13-01'].flatMap((d) => [
      [`shared ${d}`, () => Z.dayStartMsIn(d, D), () => S.dublinDayStartMs(d)],
      [`web ${d}`, () => Z.dayStartMsIn(d, D), () => W.dublinDayStartMs(d)],
    ]))
    bad.push(...sameAll([['parts', () => Z.dayStartMsIn({ y: 2026, mo: 10, d: 25 }, D), () => S.dublinDayStartMs({ y: 2026, mo: 10, d: 25 })]]))
    expect(bad.slice(0, 5)).toEqual([])
  })
  it('dayRangeMsIn ≡ dublinDayRangeMs, addDaysIn ≡ dublinAddDays', () => {
    const pairs = []
    for (const d of DAYS) {
      pairs.push([`range ${d}`, () => Z.dayRangeMsIn(d, d, D), () => S.dublinDayRangeMs(d, d)])
      for (const n of [-400, -7, -1, 1, 7, 31]) pairs.push([`add ${d} ${n}`, () => Z.addDaysIn(d, n, D), () => S.dublinAddDays(d, n)])
    }
    expect(sameAll(pairs).slice(0, 5)).toEqual([])
  })
})

describe('zone-free re-exports', () => {
  it('addDaysISO ≡ dublin-time addDaysISO, DAY_MS ≡ DUBLIN_DAY_MS', () => {
    const pairs = []
    for (const d of DAYS) for (const n of [-400, -1, 0, 1, 31]) pairs.push([`${d} ${n}`, () => Z.addDaysISO(d, n), () => W.addDaysISO(d, n)])
    pairs.push(['bad date', () => Z.addDaysISO('garbage', 1), () => W.addDaysISO('garbage', 1)])
    expect(sameAll(pairs).slice(0, 5)).toEqual([])
    expect(Z.DAY_MS).toBe(S.DUBLIN_DAY_MS)
    expect(Z.DAY_MS).toBe(W.DUBLIN_DAY_MS)
  })
  it('the zone defaults to Europe/Dublin when omitted', () => {
    const t = Date.parse('2026-07-06T23:30:00Z')
    expect(Z.dayStrIn(t)).toBe(W.dublinDayStr(t))
    expect(Z.dateKeyIn(t)).toBe(S.dublinDateKey(t))
    expect(Z.dayStartMsIn('2026-07-07')).toBe(S.dublinDayStartMs('2026-07-07'))
    expect(Z.DEFAULT_TZ).toBe('Europe/Dublin')
    expect(Z.PLATFORM_TZ).toBe('Europe/Dublin')
  })
})

describe('the sample is the sample it claims to be', () => {
  it('covers every hour of 2025-2027 plus 6 DST edges, and every day', () => {
    expect(HOURS.length).toBe(26_280 + 6 * 181)
    expect(DAYS.length).toBe(1_095)
  })
})
