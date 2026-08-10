// GAPS-P7 — list growth + deliverability trend. These tests pin the two things
// that make the surface honest rather than decorative:
//
//   1. NET LIST CHANGE COUNTS DEPARTURES, NOT ROWS. `consent_log` holds 5,749
//      email_marketing opt_out rows since 2026-05-01 and 5,521 of them are
//      one-off migrations, 5,519 landing on 2026-05-13 alone. The first cut of
//      this feature summed the column blind and reported May as a 5,536-person
//      collapse. The categorisation lives in consent-sources.js; this module
//      must consume the COUNTED columns and never the raw totals.
//
//   2. A RATE ON A TINY DENOMINATOR IS NOT A RESULT. Measured at Stillorgan
//      2026-08-09, July carried 137 sends across 3 campaigns and produced a
//      76.64% open rate. Reported next to June's 46.33% on 9,739 sends it
//      reads as the best month of the year; it is 105 people. Same shape as
//      readOutcome in CampaignOutcomeReport: refuse to call it when the sample
//      cannot carry it.
import { describe, it, expect } from 'vitest'
import {
  MIN_RATE_SENDS,
  RATE_BANDS,
  minSendsForBand,
  readRate,
  monthLabel,
  buildListHealthTrend,
} from './list-health-trend.js'

// The four live months as the RPC returns them (mig 517), with the consent
// side already categorised. Send-side figures and the one-click unsubscribe /
// hard bounce / complaint splits are the measured ones; the remaining
// voluntary rows (event_form 38, booking_form 2, admin_panel 4) and the
// auto_classpass policy rows (82) are distributed here for the test only —
// their per-month split was not measured. Column totals are exact.
const LIVE = [
  {
    month: '2026-05-01', campaigns: 1, sends: 2998, bounces: 31, hard_bounces: 0, complaints: 0, opens: 777,
    bounce_rate: 0.010340, open_rate: 0.259172, complaint_rate: 0,
    opt_ins_counted: 2, opt_ins_bulk: 0,
    unsubscribes_counted: 28, unsub_voluntary: 28, unsub_deliverability: 0,
    unsub_policy: 12, unsub_bulk: 5519, consent_unknown: 0, unknown_sources: [],
  },
  {
    month: '2026-06-01', campaigns: 6, sends: 9739, bounces: 122, hard_bounces: 16, complaints: 0, opens: 4512,
    bounce_rate: 0.012527, open_rate: 0.463293, complaint_rate: 0,
    opt_ins_counted: 8, opt_ins_bulk: 0,
    unsubscribes_counted: 60, unsub_voluntary: 44, unsub_deliverability: 16,
    unsub_policy: 30, unsub_bulk: 0, consent_unknown: 0, unknown_sources: [],
  },
  {
    month: '2026-07-01', campaigns: 3, sends: 137, bounces: 1, hard_bounces: 0, complaints: 0, opens: 105,
    bounce_rate: 0.007299, open_rate: 0.766423, complaint_rate: 0,
    opt_ins_counted: 20, opt_ins_bulk: 0,
    unsubscribes_counted: 12, unsub_voluntary: 12, unsub_deliverability: 0,
    unsub_policy: 25, unsub_bulk: 0, consent_unknown: 0, unknown_sources: [],
  },
  {
    month: '2026-08-01', campaigns: 4, sends: 6221, bounces: 74, hard_bounces: 2, complaints: 1, opens: 2104,
    bounce_rate: 0.011895, open_rate: 0.338209, complaint_rate: 0.000161,
    opt_ins_counted: 6, opt_ins_bulk: 0,
    unsubscribes_counted: 46, unsub_voluntary: 43, unsub_deliverability: 3,
    unsub_policy: 15, unsub_bulk: 2, consent_unknown: 0, unknown_sources: [],
  },
]

const empty = (month) => ({
  month, campaigns: 0, sends: 0, bounces: 0, hard_bounces: 0, complaints: 0, opens: 0,
  bounce_rate: null, open_rate: null, complaint_rate: null,
  opt_ins_counted: 0, opt_ins_bulk: 0, unsubscribes_counted: 0,
  unsub_voluntary: 0, unsub_deliverability: 0, unsub_policy: 0, unsub_bulk: 0,
  consent_unknown: 0, unknown_sources: [],
})

describe('the minimum denominator', () => {
  it('is 500 sends, so one event cannot move a rate by a whole point', () => {
    expect(MIN_RATE_SENDS).toBe(500)
  })

  it('needs enough sends that a single event does not by itself breach a band', () => {
    // One complaint in 137 sends is 0.73%, seven times the 0.1% warning band,
    // off one person clicking "spam". The band cannot be applied until a
    // single event lands at or under it.
    expect(minSendsForBand(RATE_BANDS.complaint)).toBe(1000)
    // Bounce's 2% band is representable long before 500 sends, so the floor
    // is what binds there.
    expect(minSendsForBand(RATE_BANDS.bounce)).toBe(MIN_RATE_SENDS)
  })

  it('uses the standard deliverability bands and invents no others', () => {
    expect(RATE_BANDS.bounce.warn).toBe(0.02)
    expect(RATE_BANDS.bounce.serious).toBe(0.05)
    expect(RATE_BANDS.complaint.warn).toBe(0.001)
    expect(RATE_BANDS.complaint.serious).toBe(0.003)
  })
})

describe('readRate', () => {
  it('says nothing at all when nothing was sent', () => {
    expect(readRate(null, 0, RATE_BANDS.bounce)).toMatchObject({ level: 'none' })
  })

  it('refuses to read a rate under the minimum denominator', () => {
    // July: 1 bounce in 137 sends. 0.73% looks excellent. Two more bounces
    // would have made it 2.19% and "over the warning level". Same month.
    const r = readRate(0.007299, 137, RATE_BANDS.bounce)
    expect(r.level).toBe('low_volume')
    expect(r.text).toMatch(/too few sends/i)
  })

  it('refuses the complaint band between the floor and 1,000 sends', () => {
    // 600 sends clears MIN_RATE_SENDS but one complaint would still read
    // 0.17%, over the 0.1% band, on a single person.
    expect(readRate(0.001667, 600, RATE_BANDS.complaint).level).toBe('low_volume')
    expect(readRate(0.001667, 600, RATE_BANDS.bounce).level).toBe('ok')
  })

  it('reads the live months against the bounce band', () => {
    expect(readRate(0.010340, 2998, RATE_BANDS.bounce).level).toBe('ok')
    expect(readRate(0.012527, 9739, RATE_BANDS.bounce).level).toBe('ok')
    expect(readRate(0.011895, 6221, RATE_BANDS.bounce).level).toBe('ok')
  })

  it('warns over the band and escalates over the serious level', () => {
    expect(readRate(0.024, 5000, RATE_BANDS.bounce).level).toBe('warn')
    expect(readRate(0.061, 5000, RATE_BANDS.bounce).level).toBe('serious')
    expect(readRate(0.0012, 5000, RATE_BANDS.complaint).level).toBe('warn')
    expect(readRate(0.004, 5000, RATE_BANDS.complaint).level).toBe('serious')
  })

  it('states the band it judged against, in the operator copy', () => {
    expect(readRate(0.024, 5000, RATE_BANDS.bounce).text).toContain('2%')
    expect(readRate(0.004, 5000, RATE_BANDS.complaint).text).toContain('0.3%')
  })

  it('reads the same for one month and for the pooled period', () => {
    // The copy is period-agnostic because the whole-period row renders it too.
    expect(readRate(0.007, 137, RATE_BANDS.bounce).text).not.toMatch(/month/i)
    expect(readRate(null, 0, RATE_BANDS.bounce).text).not.toMatch(/month/i)
  })

  it('carries no em-dash and no emoji in any reading', () => {
    const texts = [
      readRate(null, 0, RATE_BANDS.bounce),
      readRate(0.007, 137, RATE_BANDS.bounce),
      readRate(0.010, 2998, RATE_BANDS.bounce),
      readRate(0.024, 5000, RATE_BANDS.bounce),
      readRate(0.061, 5000, RATE_BANDS.bounce),
      readRate(0.004, 5000, RATE_BANDS.complaint),
    ].map((r) => r.text)
    for (const t of texts) {
      expect(t).not.toMatch(/[—–]/)
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})

describe('monthLabel', () => {
  it('formats the Dublin month with string math, never Date parsing', () => {
    expect(monthLabel('2026-05-01')).toBe('May 2026')
    expect(monthLabel('2026-12-01')).toBe('Dec 2026')
  })

  it('hands back anything it does not recognise rather than inventing a month', () => {
    expect(monthLabel(null)).toBe(null)
    expect(monthLabel('nonsense')).toBe('nonsense')
  })
})

describe('buildListHealthTrend', () => {
  it('survives a null or empty result without throwing', () => {
    expect(buildListHealthTrend(null).months).toEqual([])
    expect(buildListHealthTrend(null).totals.net_list_change).toBe(0)
  })

  it('leads with net list change across the window, and it is negative', () => {
    const { totals } = buildListHealthTrend(LIVE)
    expect(totals.opt_ins).toBe(36)
    expect(totals.unsubscribes).toBe(146)
    expect(totals.net_list_change).toBe(-110)
    expect(totals.direction).toBe('shrinking')
  })

  it('never lets a bulk migration reach the headline', () => {
    // 5,519 rows on 2026-05-13 plus 2 corrections in August. Summed blind they
    // would report May as -5,534 and the window as -5,631.
    const { months, totals } = buildListHealthTrend(LIVE)
    const may = months.find((m) => m.month === '2026-05-01')
    expect(may.excluded_bulk).toBe(5519)
    expect(may.net_list_change).toBe(-26)
    expect(totals.excluded_bulk).toBe(5521)
    expect(totals.net_list_change).toBe(-110)
  })

  it('keeps the ClassPass standing rule out of the net but on the record', () => {
    const { totals } = buildListHealthTrend(LIVE)
    expect(totals.unsub_policy).toBe(82)
    expect(totals.net_list_change).toBe(totals.opt_ins - totals.unsubscribes)
    expect(totals.net_list_change).not.toBe(totals.opt_ins - totals.unsubscribes - totals.unsub_policy)
  })

  it('counts hard bounces and complaints as departures, through their consent rows', () => {
    const { totals } = buildListHealthTrend(LIVE)
    expect(totals.unsub_deliverability).toBe(19)
    expect(totals.unsub_voluntary).toBe(127)
    expect(totals.unsubscribes).toBe(totals.unsub_voluntary + totals.unsub_deliverability)
  })

  it('reads only the counted columns, never a raw opt_ins/unsubscribes total', () => {
    // A row carrying the OLD column names must not be picked up by habit: the
    // counted columns are absent, so everything reads as zero rather than
    // silently reinstating the defect.
    const legacyShape = [{ ...empty('2026-05-01'), opt_ins: 2, unsubscribes: 5536 }]
    const { totals } = buildListHealthTrend(legacyShape)
    expect(totals.unsubscribes).toBe(0)
    expect(totals.net_list_change).toBe(0)
  })

  it('surfaces an unmapped source by name instead of absorbing it', () => {
    const rows = [{ ...empty('2026-08-01'), consent_unknown: 3, unknown_sources: ['glofox_sync_2027'] }]
    const { months, totals } = buildListHealthTrend(rows)
    expect(months[0].consent_unknown).toBe(3)
    expect(totals.unknown_sources).toEqual(['glofox_sync_2027'])
    // Unclassified rows move nothing.
    expect(totals.net_list_change).toBe(0)
  })

  it('unions unknown source names across months and drops junk entries', () => {
    const rows = [
      { ...empty('2026-07-01'), consent_unknown: 1, unknown_sources: ['b_source', ''] },
      { ...empty('2026-08-01'), consent_unknown: 2, unknown_sources: ['a_source', 'b_source'] },
    ]
    expect(buildListHealthTrend(rows).totals.unknown_sources).toEqual(['a_source', 'b_source'])
    expect(buildListHealthTrend([{ ...empty('2026-08-01'), unknown_sources: null }]).totals.unknown_sources).toEqual([])
  })

  it('calls a positive window growing and a zero window flat', () => {
    expect(buildListHealthTrend([{ ...empty('2026-07-01'), opt_ins_counted: 20 }]).totals.direction).toBe('growing')
    expect(buildListHealthTrend([empty('2026-07-01')]).totals.direction).toBe('flat')
  })

  it('suppresses July rates and keeps the counts', () => {
    const { months } = buildListHealthTrend(LIVE)
    const july = months.find((m) => m.month === '2026-07-01')
    expect(july.rates_readable).toBe(false)
    expect(july.open_rate_label).toBe('Not enough sends')
    expect(july.sends).toBe(137)
    expect(july.opens).toBe(105)
    expect(july.bounce_reading.level).toBe('low_volume')
  })

  it('shows August rates, which have the denominator to carry them', () => {
    const { months } = buildListHealthTrend(LIVE)
    const august = months.find((m) => m.month === '2026-08-01')
    expect(august.rates_readable).toBe(true)
    expect(august.open_rate_label).toBe('33.8%')
    expect(august.bounce_reading.level).toBe('ok')
    expect(august.complaint_reading.level).toBe('ok')
  })

  it('reads the whole-window rates off the pooled denominator', () => {
    // 19,095 sends pooled is a denominator every band can be applied to, even
    // though one of the four months is not.
    const { totals } = buildListHealthTrend(LIVE)
    expect(totals.sends).toBe(19095)
    expect(totals.rates_readable).toBe(true)
    expect(totals.bounce_reading.level).toBe('ok')
    expect(totals.complaint_reading.level).toBe('ok')
  })

  it('coerces the numeric strings PostgREST returns for a numeric column', () => {
    const [m] = buildListHealthTrend([{ ...empty('2026-08-01'), sends: '6221', bounces: '74', bounce_rate: '0.011895' }]).months
    expect(m.sends).toBe(6221)
    expect(m.bounce_rate).toBeCloseTo(0.011895, 6)
    expect(m.bounce_reading.level).toBe('ok')
  })

  it('drops leading months that never happened, and keeps the current one empty', () => {
    const rows = [empty('2026-02-01'), empty('2026-03-01'), ...LIVE, empty('2026-09-01')]
    const { months } = buildListHealthTrend(rows)
    expect(months[0].month).toBe('2026-05-01')
    expect(months[months.length - 1].month).toBe('2026-09-01')
  })

  it('does not trim a month whose only activity was excluded from the net', () => {
    // A month carrying nothing but a data migration is still a month something
    // happened in, and dropping it would hide the migration entirely.
    const rows = [{ ...empty('2026-04-01'), unsub_bulk: 900 }, ...LIVE]
    expect(buildListHealthTrend(rows).months[0].month).toBe('2026-04-01')
  })

  it('keeps an empty month that sits between two active ones', () => {
    const rows = [LIVE[0], empty('2026-06-01'), LIVE[2]]
    expect(buildListHealthTrend(rows).months.map((m) => m.month))
      .toEqual(['2026-05-01', '2026-06-01', '2026-07-01'])
  })

  it('scales the growth bars against the largest counted movement', () => {
    const { months } = buildListHealthTrend(LIVE)
    const june = months.find((m) => m.month === '2026-06-01')
    const july = months.find((m) => m.month === '2026-07-01')
    // 60 counted departures in June is the largest movement, so it is the full
    // bar. The 5,519 bulk rows must not set the scale, or every real month
    // would render as a flat line.
    expect(june.unsubscribe_bar).toBe(100)
    expect(june.opt_in_bar).toBe(13.33)
    expect(july.unsubscribe_bar).toBe(20)
    expect(july.opt_in_bar).toBe(33.33)
  })

  it('rounds the bar width, since it goes straight into a style attribute', () => {
    const { months } = buildListHealthTrend(LIVE)
    for (const m of months) {
      expect(String(m.opt_in_bar).replace(/^\d+\.?/, '').length).toBeLessThanOrEqual(2)
      expect(String(m.unsubscribe_bar).replace(/^\d+\.?/, '').length).toBeLessThanOrEqual(2)
    }
  })

  it('never divides by zero when no month moved at all', () => {
    const { months } = buildListHealthTrend([empty('2026-07-01')])
    expect(months[0].opt_in_bar).toBe(0)
    expect(months[0].unsubscribe_bar).toBe(0)
  })
})
