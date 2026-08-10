// GAPS-P7 — list growth and deliverability, month by month.
//
// WHY THIS EXISTS. Measured at Stillorgan 2026-08-09, the list took in 36
// opt-ins and lost 101 people over four months, and no surface in the product
// showed it. List health (GAPS-P5) answers "who can we email today"; it is a
// snapshot, and a snapshot cannot show a slope. Deliverability had the same
// hole: bounce rate has sat between 0.73% and 1.25% all year, under the 2%
// warning band, and there is one sending domain. Nobody would notice a slide
// until mail stopped arriving.
//
// NET LIST CHANGE COUNTS DEPARTURES, NOT consent_log ROWS. Measured live,
// 5,749 email_marketing opt_out rows exist since 2026-05-01 and 5,521 of them
// are one-off migrations, 5,519 landing on a single day. Summed blind they
// report May 2026 as a 5,536-person collapse. The categorisation lives in
// consent-sources.js and travels to the RPC as parameters; this module only
// consumes the counted / policy / bulk / unknown columns it returns. Anything
// outside voluntary + deliverability is displayed but never netted, and an
// unmapped source is surfaced by name rather than absorbed.
//
// Hard bounces and spam complaints DO count: they arrive as their own consent
// sources (postmark_hard_bounce, postmark_spam_complaint) and represent reach
// that is genuinely gone. The per-month bounce and complaint columns on the
// deliverability half are a different measurement — those count EVENTS on
// campaign_recipients, not consent transitions, and the two will not match.
//
// A RATE ON A TINY DENOMINATOR IS NOT A RESULT. July carried 137 sends across
// 3 campaigns and produced a 76.64% open rate. Placed next to June's 46.33% on
// 9,739 sends it reads as the best month of the year; it is 105 people, and
// twelve more or fewer would have moved it ten points. Rates below the minimum
// denominator are withheld and the counts are shown instead. This is the same
// posture as readOutcome in CampaignOutcomeReport, which refuses to call a
// 1.2x difference a result: the honest reading of a sample that cannot carry a
// conclusion is to say so, not to pick the flattering half.
//
// PURE. No I/O and no clock. The months come from list_health_monthly_stats
// (mig 517), which does the aggregation in Postgres because the 1,000-row
// select cap would silently under-report a 9,739-send month in the route.

/**
 * The floor for reporting ANY rate: 500 sends.
 *
 * Chosen so a single event cannot move the rate by a whole percentage point.
 * At 500 sends one bounce is 0.2%; at July's 137 it is 0.73%, so three bounces
 * in a month nobody would call a bad month would put it over the 2% warning
 * band. It is also comfortably below every real sending month here (2,998 /
 * 9,739 / 6,221), so the floor withholds exactly the month that deserves to be
 * withheld and none of the ones that do not.
 */
export const MIN_RATE_SENDS = 500

/**
 * The standard deliverability bands, and only those. Bounce over 2% is a
 * warning and over 5% is serious; complaints over 0.1% are a warning and over
 * 0.3% serious. There is deliberately NO gym-sector benchmark anywhere in this
 * module: no such measurement exists for this data, and inventing one would be
 * fabrication dressed as context.
 *
 * The open rate has no band at all. Provider-side prefetching (Apple Mail
 * Privacy Protection and similar) opens a share of mail nobody read, so an
 * open rate is a direction of travel, not a number to judge against a line.
 */
export const RATE_BANDS = Object.freeze({
  bounce: Object.freeze({ key: 'bounce', warn: 0.02, serious: 0.05, noun: 'Bounce rate' }),
  complaint: Object.freeze({ key: 'complaint', warn: 0.001, serious: 0.003, noun: 'Complaint rate' }),
})

/**
 * The denominator a band needs before it can be applied at all.
 *
 * Two conditions, whichever is larger. The floor above, AND enough sends that
 * ONE event lands at or under the warning band: below 1/warn, a single person
 * clicking "spam" breaches the complaint band on its own, which says something
 * about that person and nothing about the sending domain. For complaints that
 * is 1,000 sends; for bounces the 2% band is representable at 50, so the floor
 * binds instead.
 */
export function minSendsForBand(band) {
  return Math.max(MIN_RATE_SENDS, Math.ceil(1 / band.warn))
}

/** 0.02 -> '2%', 0.001 -> '0.1%'. Trailing zeros trimmed. */
function bandLabel(v) {
  return `${Number((v * 100).toFixed(2))}%`
}

/**
 * Where one month's rate sits, or why it is not being read.
 *
 * Levels: none (nothing sent), low_volume (sent, but the sample cannot carry a
 * rate), ok, warn, serious.
 *
 * @param {number|null} rate  fraction, 0..1
 * @param {number} sends      the denominator it was computed on
 * @param {object} band       one of RATE_BANDS
 */
export function readRate(rate, sends, band) {
  const n = Number(sends || 0)
  // The copy is deliberately period-agnostic: the same reading is rendered
  // for one month and for the pooled whole-period row.
  if (n === 0) return { level: 'none', text: 'Nothing sent.' }
  if (n < minSendsForBand(band) || rate == null) {
    return { level: 'low_volume', text: 'Too few sends to read a rate.' }
  }
  const r = Number(rate)
  if (r > band.serious) return { level: 'serious', text: `Over the ${bandLabel(band.serious)} serious level.` }
  if (r > band.warn) return { level: 'warn', text: `Over the ${bandLabel(band.warn)} warning level.` }
  return { level: 'ok', text: `Under the ${bandLabel(band.warn)} warning level.` }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * '2026-05-01' -> 'May 2026'.
 *
 * String math on the stored calendar month, never `new Date(...)`: the value
 * is already a Dublin month boundary from Postgres, and parsing it locally
 * then formatting in UTC is how a month silently becomes the previous one.
 */
export function monthLabel(month) {
  if (typeof month !== 'string' || month.length < 7) return month
  const name = MONTHS[Number(month.slice(5, 7)) - 1]
  if (!name) return month
  return `${name} ${month.slice(0, 4)}`
}

const num = (v) => Number(v || 0)
const rateOf = (hits, denom) => (denom > 0 ? hits / denom : null)
const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s !== '') : [])

/**
 * True when nothing at all happened in this month, on either side.
 *
 * The excluded categories count as "something happened": May 2026 has zero
 * counted departures worth trimming for but 5,519 bulk rows, and a month that
 * carried a data migration must not be silently dropped off the front of the
 * table just because none of it reached the headline.
 */
function isEmptyMonth(m) {
  return m.sends === 0 && m.campaigns === 0
    && m.opt_ins === 0 && m.unsubscribes === 0
    && m.unsub_policy === 0 && m.excluded_bulk === 0 && m.consent_unknown === 0
}

/**
 * Shape the RPC rows into the trend the page renders.
 *
 * Rates arrive from Postgres as `numeric`, which PostgREST serialises as a
 * STRING. Coercing here rather than at the call site is deliberate: a string
 * compared against a band threshold does not error, it just silently answers
 * the wrong question.
 *
 * @param {Array<object>|null} rows  list_health_monthly_stats rows, oldest first
 */
export function buildListHealthTrend(rows) {
  const all = (rows || []).map((r) => {
    const sends = num(r.sends)
    const bounces = num(r.bounces)
    const complaints = num(r.complaints)
    const opens = num(r.opens)
    // Trust the RPC's rate when it gave one, but fall back to the counts so a
    // null rate column never reads as "no bounces".
    const bounce_rate = r.bounce_rate == null ? rateOf(bounces, sends) : Number(r.bounce_rate)
    const complaint_rate = r.complaint_rate == null ? rateOf(complaints, sends) : Number(r.complaint_rate)
    const open_rate = r.open_rate == null ? rateOf(opens, sends) : Number(r.open_rate)
    // The COUNTED columns only. A bare `opt_ins` / `unsubscribes` column does
    // not exist on the RPC any more, precisely so a reader cannot pick up the
    // uncategorised total by habit.
    const opt_ins = num(r.opt_ins_counted)
    const unsubscribes = num(r.unsubscribes_counted)
    return {
      month: r.month,
      label: monthLabel(r.month),
      campaigns: num(r.campaigns),
      sends,
      bounces,
      hard_bounces: num(r.hard_bounces),
      complaints,
      opens,
      bounce_rate,
      complaint_rate,
      open_rate,
      opt_ins,
      unsubscribes,
      unsub_voluntary: num(r.unsub_voluntary),
      unsub_deliverability: num(r.unsub_deliverability),
      // Shown, never netted. See NET_LIST_CHANGE_CATEGORIES in
      // consent-sources.js for why policy is out of the headline.
      unsub_policy: num(r.unsub_policy),
      excluded_bulk: num(r.opt_ins_bulk) + num(r.unsub_bulk),
      consent_unknown: num(r.consent_unknown),
      unknown_sources: list(r.unknown_sources),
      // Recomputed rather than trusted, so the headline can never disagree
      // with the two numbers printed beside it.
      net_list_change: opt_ins - unsubscribes,
      ...readings(sends, { bounce_rate, complaint_rate, open_rate }),
    }
  })

  // Drop the leading run of months that never happened. A studio that started
  // sending in May should not open on three empty rows; a gap BETWEEN two
  // active months is real and stays, because a month with no sends is exactly
  // the kind of thing this view exists to make visible.
  let first = 0
  while (first < all.length - 1 && isEmptyMonth(all[first])) first += 1
  const months = all.slice(first)

  // Growth bars are scaled against the largest single movement in the window,
  // so opt-ins and unsubscribes share one scale and can be compared by eye.
  // Scaled against the largest COUNTED movement. Using the raw totals would
  // let May's 5,519 bulk rows set the scale and render every real month as a
  // flat line. Rounded to two places: the value goes straight into a style
  // attribute, and fifteen decimals of float noise is not a measurement.
  const peak = months.reduce((m, x) => Math.max(m, x.opt_ins, x.unsubscribes), 0)
  const bar = (v) => (peak > 0 ? Math.round((v / peak) * 10000) / 100 : 0)
  for (const m of months) {
    m.opt_in_bar = bar(m.opt_ins)
    m.unsubscribe_bar = bar(m.unsubscribes)
  }

  const sum = (key) => months.reduce((t, m) => t + m[key], 0)
  const totalSends = sum('sends')
  const totalOptIns = sum('opt_ins')
  const totalUnsubs = sum('unsubscribes')
  const net = totalOptIns - totalUnsubs

  const totals = {
    months: months.length,
    campaigns: sum('campaigns'),
    sends: totalSends,
    bounces: sum('bounces'),
    hard_bounces: sum('hard_bounces'),
    complaints: sum('complaints'),
    opens: sum('opens'),
    opt_ins: totalOptIns,
    unsubscribes: totalUnsubs,
    unsub_voluntary: sum('unsub_voluntary'),
    unsub_deliverability: sum('unsub_deliverability'),
    unsub_policy: sum('unsub_policy'),
    excluded_bulk: sum('excluded_bulk'),
    consent_unknown: sum('consent_unknown'),
    // Union across the window, so an unclassified source can be named once
    // rather than repeated per month.
    unknown_sources: [...new Set(months.flatMap((m) => m.unknown_sources))].sort(),
    net_list_change: net,
    direction: net > 0 ? 'growing' : net < 0 ? 'shrinking' : 'flat',
    bounce_rate: rateOf(sum('bounces'), totalSends),
    complaint_rate: rateOf(sum('complaints'), totalSends),
    open_rate: rateOf(sum('opens'), totalSends),
  }
  // The pooled denominator is the one figure that can usually carry a band
  // even when an individual month cannot.
  Object.assign(totals, readings(totalSends, totals))

  return { months, totals }
}

/**
 * The three readings for one denominator. `rates_readable` gates the whole
 * rate column: below the floor the page shows counts and says why, rather
 * than printing a percentage nobody should act on.
 */
function readings(sends, r) {
  const readable = sends >= MIN_RATE_SENDS
  return {
    rates_readable: readable,
    bounce_reading: readRate(r.bounce_rate, sends, RATE_BANDS.bounce),
    complaint_reading: readRate(r.complaint_rate, sends, RATE_BANDS.complaint),
    open_rate_label: readable && r.open_rate != null
      ? `${(r.open_rate * 100).toFixed(1)}%`
      : 'Not enough sends',
  }
}
