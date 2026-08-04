// shared/studio-kpi-math.js
//
// STUDIO-KPI.1 — pure shaping for the Studio scorecard (revenue-focused
// KPIs by location). No DB, no platform imports; IO lives in
// shared/studio-kpis.js. Definitions follow membership-snapshot.js:
// paying base = glofox_membership_status IN (member, credit_member),
// recurring = that base with glofox_membership_type 'time'.

// Tenure boundary between "early churn" (onboarding failure) and
// "tenured churn" (product failure) — days since joined_at.
export const EARLY_TENURE_DAYS = 90

// New-joiner activation window + the visit count that counts as
// "activated" within it (the intervention threshold).
export const ACTIVATION_WINDOW_DAYS = 14
export const ACTIVATION_VISITS = 3

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Months in a Glofox billing interval string ("1 month", "3 months",
 * "1 year", "2 weeks"). Unit-aware — mirrors the private
 * intervalMonths in src/lib/churn-radar.js (which this seam cannot
 * import) so the scorecard and the churn radar price the same member
 * identically the day a non-month cadence plan appears. Unknown/empty
 * intervals count as monthly — the conservative fallback for the rare
 * NULL row (1 live).
 */
export function intervalMonths(interval) {
  const m = String(typeof interval === 'string' ? interval : '').match(/(\d+)\s*(day|week|month|year)/i)
  if (!m) return 1
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return 1
  const unit = m[2].toLowerCase()
  const factor = unit === 'year' ? 12 : unit === 'week' ? 12 / 52 : unit === 'day' ? 1 / 30 : 1
  return n * factor
}

/**
 * MRR from recurring-member rows [{ price_cents, interval }] —
 * each price normalised to a monthly figure by its billing interval.
 * Returns { mrrCents, recurringMembers, yieldCents } where yield is
 * average monthly revenue per recurring member.
 */
export function computeMrr(rows = []) {
  let mrrCents = 0
  let members = 0
  for (const r of rows) {
    members++
    const price = Number(r.price_cents) || 0
    if (price <= 0) continue
    mrrCents += price / intervalMonths(r.interval)
  }
  mrrCents = Math.round(mrrCents)
  return {
    mrrCents,
    recurringMembers: members,
    yieldCents: members > 0 ? Math.round(mrrCents / members) : null,
  }
}

/**
 * Split cancel transitions into early (< EARLY_TENURE_DAYS since
 * joined_at at cancel time) vs tenured, and price them. Rows:
 * [{ occurred_at, joined_at, price_cents, interval }]. Rows with no
 * stamped price (pre-mig-480 history) are priced at estYieldCents and
 * flagged via `estimatedCount` so the UI can label the figure.
 */
export function summariseCancels(rows = [], estYieldCents = 0) {
  const out = {
    total: 0,
    early: 0,
    tenured: 0,
    unknownTenure: 0,
    churnCents: 0,
    estimatedCount: 0,
  }
  for (const r of rows) {
    out.total++
    const occurred = Date.parse(r.occurred_at)
    const joined = r.joined_at ? Date.parse(r.joined_at) : NaN
    if (Number.isFinite(occurred) && Number.isFinite(joined)) {
      const tenureDays = (occurred - joined) / MS_PER_DAY
      if (tenureDays < EARLY_TENURE_DAYS) out.early++
      else out.tenured++
    } else {
      out.unknownTenure++
    }
    // NULL price = unstamped pre-mig-480 row → estimate at avg yield.
    // A stamped 0 (comp/free membership) is a real price — contributes
    // nothing and is NOT flagged estimated.
    if (r.price_cents == null) {
      out.churnCents += estYieldCents
      out.estimatedCount++
    } else {
      const price = Number(r.price_cents) || 0
      if (price > 0) out.churnCents += price / intervalMonths(r.interval)
    }
  }
  out.churnCents = Math.round(out.churnCents)
  return out
}

/**
 * Engagement rates from paying-member aggregate rows
 * [{ total_attended_30d }] (maintained nightly by
 * glofox-attendance-refresh for the whole paying base).
 * activeRatePct = share of members with ≥1 attended class in 30d;
 * visitsPerMemberWeek = mean weekly attended classes per member.
 * Denominator is the WHOLE paying base (paused/locked included) by
 * design — a paused member is still a retention risk, and excluding
 * them would flatter the rate exactly when it should be alarming.
 */
export function computeEngagement(rows = []) {
  const members = rows.length
  if (members === 0) return { members: 0, activeRatePct: null, visitsPerMemberWeek: null }
  let active = 0
  let visits30 = 0
  for (const r of rows) {
    const v = Number(r.total_attended_30d) || 0
    if (v >= 1) active++
    visits30 += v
  }
  return {
    members,
    activeRatePct: Math.round((active / members) * 100),
    visitsPerMemberWeek: Math.round((visits30 / members / (30 / 7)) * 10) / 10,
  }
}

/**
 * Floor metrics from PAST class occurrences + their bookings.
 * occurrences: [{ glofox_event_id, name, instructor, capacity, starts_at,
 *   booked }] where `booked` is Glofox's own frozen booked count
 * (raw.booked — survives roster-assembly gaps); bookings:
 * [{ glofox_event_id, status, attended }] for the same window.
 *
 * Fill rate = Σbooked / Σcapacity over occurrences with a capacity.
 * No-show rate = past BOOKED rows with attended=false ÷ past BOOKED
 * rows (the computeBookingAggregates rule).
 *
 * The breakdown table groups by instructor when Glofox sends any
 * (groupedBy 'coach'), else by class name (groupedBy 'class') — live
 * Stillorgan data 2026-08-04 has instructor NULL on every occurrence
 * (raw.trainers carries only unmapped ids), so per-class is the
 * shippable split until trainer names are mapped.
 */
export function computeFloor(occurrences = [], bookings = [], { sevenDayCutIso } = {}) {
  const byEvent = new Map()
  for (const o of occurrences) {
    byEvent.set(o.glofox_event_id, o)
  }

  const groupedBy = occurrences.some(o => o.instructor) ? 'coach' : 'class'
  const keyOf = (o) => (groupedBy === 'coach' ? (o.instructor || 'Unassigned') : (o.name || 'Unnamed class'))

  const fill = { booked: 0, capacity: 0 }
  const fill7 = { booked: 0, capacity: 0 }
  const groups = new Map()

  for (const o of occurrences) {
    const cap = Number(o.capacity) || 0
    const booked = Number(o.booked) || 0
    if (cap > 0) {
      fill.booked += booked
      fill.capacity += cap
      if (sevenDayCutIso && o.starts_at >= sevenDayCutIso) {
        fill7.booked += booked
        fill7.capacity += cap
      }
    }
    const key = keyOf(o)
    if (!groups.has(key)) {
      groups.set(key, { label: key, classes: 0, booked: 0, capacity: 0, pastBooked: 0, noShows: 0 })
    }
    const g = groups.get(key)
    g.classes++
    if (cap > 0) { g.booked += booked; g.capacity += cap }
  }

  let pastBooked = 0
  let noShows = 0
  for (const b of bookings) {
    if (b.status !== 'BOOKED') continue
    // Only bookings whose class survived (non-cancelled occurrence in
    // the window) count — class_bookings is upsert-only, so a cancelled
    // class leaves phantom BOOKED/attended=false rows that would
    // otherwise inflate the headline no-show rate while the per-group
    // table (keyed off surviving occurrences) excluded them.
    const occ = byEvent.get(b.glofox_event_id)
    if (!occ) continue
    pastBooked++
    const isNoShow = !b.attended
    if (isNoShow) noShows++
    const g = groups.get(keyOf(occ))
    if (g) {
      g.pastBooked++
      if (isNoShow) g.noShows++
    }
  }

  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null)
  const groupTable = [...groups.values()]
    .map(g => ({
      label: g.label,
      classes: g.classes,
      fillPct: pct(g.booked, g.capacity),
      noShowPct: pct(g.noShows, g.pastBooked),
    }))
    .sort((a, b) => (b.fillPct ?? -1) - (a.fillPct ?? -1))

  return {
    classes: occurrences.length,
    fillPct: pct(fill.booked, fill.capacity),
    fillPct7d: pct(fill7.booked, fill7.capacity),
    noShowPct: pct(noShows, pastBooked),
    attendedVisits: pastBooked - noShows,
    groupedBy,
    groupTable,
  }
}

/**
 * New-joiner activation: share of the cohort (joined ≥
 * ACTIVATION_WINDOW_DAYS ago, so their window is complete) who attended
 * ≥ ACTIVATION_VISITS classes within ACTIVATION_WINDOW_DAYS of joining.
 * joiners: [{ id, joined_at }]; bookings: [{ contact_id, starts_at,
 * status, attended }] covering the cohort window.
 */
export function computeActivation(joiners = [], bookings = [], nowMs = Date.now()) {
  const windowMs = ACTIVATION_WINDOW_DAYS * MS_PER_DAY
  const attendedByContact = new Map()
  for (const b of bookings) {
    if (b.status !== 'BOOKED' || !b.attended || !b.contact_id) continue
    if (!attendedByContact.has(b.contact_id)) attendedByContact.set(b.contact_id, [])
    attendedByContact.get(b.contact_id).push(Date.parse(b.starts_at))
  }

  let complete = 0
  let activated = 0
  let pending = 0
  for (const j of joiners) {
    const joined = Date.parse(j.joined_at)
    if (!Number.isFinite(joined)) continue
    if (nowMs - joined < windowMs) { pending++; continue }
    complete++
    const visits = (attendedByContact.get(j.id) || [])
      .filter(t => Number.isFinite(t) && t >= joined && t <= joined + windowMs)
      .length
    if (visits >= ACTIVATION_VISITS) activated++
  }

  return {
    cohort: complete,
    pending,
    activatedPct: complete > 0 ? Math.round((activated / complete) * 100) : null,
  }
}
