// CHURN-RADAR.1 — at-risk member scoring.
//
// Pure functions: no DB, no I/O. The API route fetches the member
// rows and the action log, calls these to score, then applies snooze
// filtering on top.
//
// Scope (shaped by the data — see SESSION_STATE.md): of ~1,074
// members tagged member/credit_member in Glofox, only ~226 have any
// class activity. The radar scores ONLY that active base. The rest —
// members with no attendance and no booking footprint — are routed
// to Quarantine for a one-off "are these real?" triage, never the
// daily radar (an 800-row list is noise, not a radar).
//
// Three data-backed signals:
//   - Gone quiet   — attended before, but not in the last 14-45 days.
//   - Disengaging  — was a regular (4+/30d) but zero in the last 7d.
//   - No-show      — booking classes then not turning up.
// A member can trip several; weights sum into a risk score + tier.
//
// A fourth signal (Payment trouble) is deliberately absent — Glofox
// sync carries lifecycle status, not billing health. It lands in
// Phase 2 once a billing-status field is synced.

// Membership tiers that count as paying members — the radar's
// population. Drop-in (classpass_payg), trials and leads are out.
export const MEMBER_STATUSES = Object.freeze(['member', 'credit_member'])

// Membership lifecycle states (contacts.glofox_membership_state —
// from member.membership.status in Glofox) that take a member off the
// radar. A paused membership is a planned freeze; a cancelled/expired
// one has already lapsed. Neither is "at churn risk". Anything else —
// active, or an unrecognised/missing value — is scored normally.
const OFF_RADAR_MEMBERSHIP_STATES = Object.freeze([
  'paused', 'cancelled', 'expired', 'frozen', 'suspended',
])

// Gone-quiet window. Below MIN they're still attending normally;
// past MAX they've effectively churned (a re-win, not an at-risk
// nudge) so they drop off the radar rather than dominating it.
const QUIET_MIN_DAYS = 14
const QUIET_MAX_DAYS = 45
const QUIET_ESCALATE_DAYS = 28

// "Was a regular" threshold for the Disengaging signal.
const REGULAR_30D_MIN = 4

const TIER_HIGH = 5
const TIER_MEDIUM = 3

// Renewal-cliff window — a membership renewing within this many days
// whose owner isn't actively attending probably won't renew.
const RENEWAL_CLIFF_DAYS = 30
const RENEWAL_CLIFF_CRITICAL_DAYS = 14

// ── helpers ──────────────────────────────────────────────────────

function daysSince(value, nowMs) {
  if (!value) return null
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return null
  return (nowMs - t) / 86_400_000
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Parse a Glofox billing interval ("6 months", "1 month", "1 year")
// into a month count, for normalising price to a monthly figure.
function intervalMonths(interval) {
  if (typeof interval !== 'string') return null
  const m = /(\d+)\s*(day|week|month|year)/i.exec(interval)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2].toLowerCase()
  const factor = unit === 'year' ? 12 : unit === 'week' ? 12 / 52 : unit === 'day' ? 1 / 30 : 1
  return n * factor
}

/**
 * Monthly-normalised membership value in cents, so a 6-month and a
 * monthly member compare fairly. One-off / unknown-interval prices
 * (class packs) fall back to the raw figure. 0 when no price.
 */
export function monthlyValueCents(contact) {
  const price = Number(contact?.glofox_membership_price_cents)
  if (!Number.isFinite(price) || price <= 0) return 0
  const months = intervalMonths(contact?.glofox_billing_interval)
  return months ? Math.round(price / months) : Math.round(price)
}

/**
 * Classify a contact relative to the radar:
 *   'out'        — not a paying member; not in scope at all.
 *   'paused'     — paying member whose membership is paused / cancelled
 *                  / expired — a planned freeze or already lapsed, so
 *                  excluded from the radar (not at churn risk).
 *   'active'     — paying member with a live membership + an activity
 *                  footprint; scored.
 *   'quarantine' — paying member with zero attendance AND zero
 *                  booking history; routed to triage, not the radar.
 */
export function classifyContact(contact) {
  if (!contact || !MEMBER_STATUSES.includes(contact.glofox_membership_status)) {
    return 'out'
  }
  const state = typeof contact.glofox_membership_state === 'string'
    ? contact.glofox_membership_state.toLowerCase()
    : null
  if (state && OFF_RADAR_MEMBERSHIP_STATES.includes(state)) return 'paused'
  const hasFootprint = Boolean(contact.last_attended_at) || Boolean(contact.last_booked_at)
  return hasFootprint ? 'active' : 'quarantine'
}

// ── signal detectors ─────────────────────────────────────────────
// Each returns a signal object or null.

function detectGoneQuiet(contact, nowMs) {
  const d = daysSince(contact.last_attended_at, nowMs)
  if (d == null || d < QUIET_MIN_DAYS || d > QUIET_MAX_DAYS) return null
  const days = Math.floor(d)
  const escalated = d >= QUIET_ESCALATE_DAYS
  return {
    key: 'gone_quiet',
    label: 'Gone quiet',
    detail: `No class in ${days} days`,
    weight: escalated ? 3 : 2,
    severity: escalated ? 'critical' : 'warning',
  }
}

function detectDisengaging(contact, nowMs) {
  const att30 = num(contact.total_attended_30d)
  const att7 = num(contact.total_attended_7d)
  if (att30 < REGULAR_30D_MIN || att7 > 0) return null
  // A regular whose last week is empty — the trend just broke. This
  // catches the 7-14 day gap that Gone quiet (14d+) misses.
  const d = daysSince(contact.last_attended_at, nowMs)
  const detail = d != null
    ? `Regular (${att30}/30d) — nothing for ${Math.floor(d)} days`
    : `Regular (${att30}/30d) — nothing this week`
  return {
    key: 'disengaging',
    label: 'Disengaging',
    detail,
    weight: 3,
    severity: 'warning',
  }
}

function detectNoShow(contact) {
  const noshow = num(contact.total_noshow_30d)
  if (noshow < 2) return null
  const attended = num(contact.total_attended_30d)
  // More no-shows than turn-ups in the month is a strong signal.
  const heavy = noshow > attended
  return {
    key: 'no_show',
    label: 'No-show pattern',
    detail: `${noshow} no-show${noshow === 1 ? '' : 's'} in 30 days`,
    weight: heavy ? 3 : 2,
    severity: heavy ? 'critical' : 'warning',
  }
}

function detectRenewalCliff(contact, nowMs) {
  if (!contact.glofox_membership_expiry) return null
  const d = daysSince(contact.glofox_membership_expiry, nowMs)
  if (d == null) return null
  const daysToRenewal = -d  // positive = days until the membership renews
  if (daysToRenewal < 0 || daysToRenewal > RENEWAL_CLIFF_DAYS) return null
  // A regular attender will most likely renew — only flag an
  // approaching renewal for someone who isn't getting value from it.
  if (num(contact.total_attended_30d) >= REGULAR_30D_MIN) return null
  const days = Math.ceil(daysToRenewal)
  const critical = daysToRenewal <= RENEWAL_CLIFF_CRITICAL_DAYS
  return {
    key: 'renewal_cliff',
    label: 'Renewal cliff',
    detail: `Renews in ${days} day${days === 1 ? '' : 's'} — low recent attendance`,
    weight: critical ? 3 : 2,
    severity: critical ? 'critical' : 'warning',
  }
}

const DETECTORS = [detectGoneQuiet, detectDisengaging, detectNoShow, detectRenewalCliff]

// ── scoring ──────────────────────────────────────────────────────

function tierFor(score) {
  if (score >= TIER_HIGH) return 'high'
  if (score >= TIER_MEDIUM) return 'medium'
  return 'low'
}

/**
 * Score one active-base member. Returns null if the contact isn't in
 * the active base or trips no signals. Otherwise returns the scored
 * record the radar renders.
 */
export function scoreMember(contact, nowMs = Date.now()) {
  if (classifyContact(contact) !== 'active') return null
  const signals = []
  for (const detect of DETECTORS) {
    const s = detect(contact, nowMs)
    if (s) signals.push(s)
  }
  if (signals.length === 0) return null
  const score = signals.reduce((sum, s) => sum + s.weight, 0)
  return {
    contactId: contact.id,
    name: contact.name || 'Member',
    score,
    tier: tierFor(score),
    signals,
    daysSinceAttended: (() => {
      const d = daysSince(contact.last_attended_at, nowMs)
      return d == null ? null : Math.floor(d)
    })(),
    membershipStatus: contact.glofox_membership_status,
    membershipPlan: contact.glofox_membership_plan || null,
    segment: contact.glofox_membership_status === 'credit_member' ? 'credit' : 'member',
    monthlyValueCents: monthlyValueCents(contact),
    daysToRenewal: (() => {
      const d = daysSince(contact.glofox_membership_expiry, nowMs)
      return d == null ? null : Math.max(0, Math.ceil(-d))
    })(),
  }
}

/**
 * Score a batch of contacts. Returns the at-risk list (members
 * tripping ≥1 signal), highest score first, then longest-quiet
 * first. Members with no signals — the healthy active base — are
 * omitted.
 */
export function buildRadar(contacts, nowMs = Date.now()) {
  const scored = []
  for (const c of contacts || []) {
    const r = scoreMember(c, nowMs)
    if (r) scored.push(r)
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Within a tier, highest monthly revenue at risk rises to the top.
    if (b.monthlyValueCents !== a.monthlyValueCents) return b.monthlyValueCents - a.monthlyValueCents
    return (b.daysSinceAttended ?? 0) - (a.daysSinceAttended ?? 0)
  })
  return scored
}

/**
 * Counts for a contact batch — the radar denominator, how many are at
 * risk (and high-tier), the quarantine backlog and the paused count —
 * broken down by segment: monthly members vs credit-pack holders.
 * A churning monthly subscriber and a credit-pack holder running low
 * are different problems, so the summary keeps them distinct.
 */
export function radarSummary(contacts, nowMs = Date.now()) {
  const blank = () => ({ activeBase: 0, atRisk: 0, highRisk: 0 })
  const bySegment = { member: blank(), credit: blank() }
  let quarantine = 0
  let paused = 0
  let revenueAtRiskCents = 0
  for (const c of contacts || []) {
    const cls = classifyContact(c)
    if (cls === 'quarantine') { quarantine++; continue }
    if (cls === 'paused') { paused++; continue }
    if (cls !== 'active') continue
    const seg = c.glofox_membership_status === 'credit_member' ? 'credit' : 'member'
    bySegment[seg].activeBase++
    const r = scoreMember(c, nowMs)
    if (r) {
      bySegment[seg].atRisk++
      if (r.tier === 'high') bySegment[seg].highRisk++
      revenueAtRiskCents += monthlyValueCents(c)
    }
  }
  return {
    activeBase: bySegment.member.activeBase + bySegment.credit.activeBase,
    atRisk: bySegment.member.atRisk + bySegment.credit.atRisk,
    highRisk: bySegment.member.highRisk + bySegment.credit.highRisk,
    quarantine,
    paused,
    revenueAtRiskCents,
    bySegment,
  }
}

// ── win-back ─────────────────────────────────────────────────────
// WINBACK.1 — former members worth re-winning. Distinct from the
// at-risk radar: a member who's been quiet past QUIET_MAX_DAYS has
// effectively churned, so they drop OFF the at-risk list — but if
// they were a genuine member (a real attendance footprint) and
// haven't been gone too long, they're a re-win opportunity, not a
// lost cause. This is the bridge between "at risk" and "gone".

// Win-back window — last trained between these bounds. The floor is
// QUIET_MAX_DAYS so the handoff from the at-risk list is seamless;
// past the ceiling they've been gone too long to be realistic.
const WINBACK_MIN_DAYS = QUIET_MAX_DAYS
const WINBACK_MAX_DAYS = 365

// Statuses that can be a former member. ex_member is included even
// though it's outside MEMBER_STATUSES — a lapsed member whose Glofox
// status has flipped to ex_member is the clearest win-back case.
const WINBACK_STATUSES = Object.freeze(['member', 'credit_member', 'ex_member'])

// Membership states that mean a planned freeze — they intend to
// return, so they're not a win-back (nor a churn) case.
const WINBACK_EXCLUDE_STATES = Object.freeze(['paused', 'frozen', 'suspended'])

function winbackTier(days) {
  if (days <= 90) return 'high'    // just lapsed — warmest, best odds
  if (days <= 180) return 'medium'
  return 'low'
}

/**
 * Score one win-back candidate — a former member who actually
 * trained (real last_attended_at) and last did so WINBACK_MIN..MAX
 * days ago. Returns null for anyone who isn't a win-back case.
 */
export function scoreWinbackContact(contact, nowMs = Date.now()) {
  const status = contact?.glofox_membership_status
  if (!status || !WINBACK_STATUSES.includes(status)) return null
  const state = typeof contact?.glofox_membership_state === 'string'
    ? contact.glofox_membership_state.toLowerCase()
    : null
  // A planned freeze isn't a win-back — they're coming back already.
  if (state && WINBACK_EXCLUDE_STATES.includes(state)) return null
  // Must have a real attendance footprint — a member who genuinely
  // trained, not a never-started ghost record (those go to Quarantine).
  const d = daysSince(contact.last_attended_at, nowMs)
  if (d == null || d <= WINBACK_MIN_DAYS || d > WINBACK_MAX_DAYS) return null
  const days = Math.floor(d)
  return {
    contactId: contact.id,
    name: contact.name || 'Member',
    status,
    tier: winbackTier(days),
    daysSinceAttended: days,
    membershipPlan: contact.glofox_membership_plan || null,
    monthlyValueCents: monthlyValueCents(contact),
    lifetimeValueCents: Number.isFinite(contact.lifetime_value_cents)
      ? contact.lifetime_value_cents : 0,
  }
}

/**
 * Build the win-back list — former members worth re-winning, warmest
 * (most recently lapsed) and highest-value first.
 */
export function buildWinback(contacts, nowMs = Date.now()) {
  const TIER_RANK = { high: 3, medium: 2, low: 1 }
  const rows = []
  for (const c of contacts || []) {
    const r = scoreWinbackContact(c, nowMs)
    if (r) rows.push(r)
  }
  rows.sort((a, b) => {
    if (TIER_RANK[b.tier] !== TIER_RANK[a.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier]
    if (b.monthlyValueCents !== a.monthlyValueCents) return b.monthlyValueCents - a.monthlyValueCents
    return a.daysSinceAttended - b.daysSinceAttended  // most recently lapsed first
  })
  return rows
}
