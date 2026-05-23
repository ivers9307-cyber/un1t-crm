// CHURN-RADAR.1 — at-risk member scoring.
//
// Pure functions: no DB, no I/O. The API route fetches the member
// rows and the action log, calls these to score, then applies snooze
// filtering on top.
//
// Scope (shaped by the data — see SESSION_STATE.md): glofox_membership
// _status (member / credit_member) is a STALE lifecycle label — it
// outlives the membership it names. Of ~1,074 contacts carrying it,
// hundreds are spent class packs, PAYG drop-ins or lapsed subs with
// no live membership at all. classifyContact() applies a live-
// membership gate (see hasLiveMembership) so the active base is only
// genuine members: live subscriptions + class packs with credits
// left. Members with a live membership but no attendance/booking
// footprint go to Quarantine for a one-off "are these real?" triage.
//
// Signals (each detector returns a weighted signal or null):
//   - Gone quiet    — attended before, but not in the last 14-45 days.
//   - Disengaging   — was a regular (4+/30d) but zero in the last 7d.
//   - No-show       — booking classes then not turning up.
//   - Renewal cliff — a membership renewing soon with low attendance.
//   - Pack low      — a class-pack member down to their last 1-2
//                     classes; a rebuy nudge before the pack empties.
// A member can trip several; weights sum into a risk score + tier.
//
// Billing health is handled separately — members whose payment has
// failed land in the Overdue tab (see classifyContact), not here.

// Membership tiers that count as paying members — the radar's
// population. Drop-in (classpass_payg), trials and leads are out.
export const MEMBER_STATUSES = Object.freeze(['member', 'credit_member'])

// Membership lifecycle states (contacts.glofox_membership_state —
// from member.membership.status in Glofox) that mean the membership
// has ENDED. For a subscription these take the contact off the active
// base entirely — an ended membership is not a member. 'paused' and
// 'locked' are deliberately NOT here: a paused membership is a live
// planned freeze, and a locked one is a live membership in arrears.
const MEMBERSHIP_ENDED_STATES = Object.freeze([
  'cancelled', 'expired', 'frozen', 'suspended',
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

// Pack running-low — a class-pack member down to their last classes.
// A pack that empties without a rebuy is silent churn, so the 1-2
// credits window is flagged as a renewal nudge. ≤1 is critical: the
// next class empties the pack.
const PACK_LOW_CREDITS = 2
const PACK_CRITICAL_CREDITS = 1

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
 * Does this contact hold a membership that is actually live right now?
 *
 * glofox_membership_status (member / credit_member) is a stale
 * lifecycle LABEL — it sticks around long after the membership it
 * names has been used up or lapsed. The authoritative signal is the
 * membership TYPE plus its state / remaining credits:
 *
 *   num_classes (class pack)      — live only while credits remain.
 *   payg (drop-in)                — never a membership; pay-per-class.
 *   time (subscription) / unknown — live unless the state says the
 *                                   membership has ended. active /
 *                                   paused / locked all count as live.
 */
export function hasLiveMembership(contact) {
  if (!contact) return false
  const type = typeof contact.glofox_membership_type === 'string'
    ? contact.glofox_membership_type.toLowerCase()
    : null
  if (type === 'num_classes') {
    return Number(contact.trial_credits_remaining) > 0
  }
  if (type === 'payg') return false
  const state = typeof contact.glofox_membership_state === 'string'
    ? contact.glofox_membership_state.toLowerCase()
    : null
  return !(state && MEMBERSHIP_ENDED_STATES.includes(state))
}

/**
 * Classify a contact relative to the radar:
 *   'out'        — not a paying member, or no live membership at all
 *                  (spent class pack, PAYG drop-in, lapsed sub). Not
 *                  in scope.
 *   'overdue'    — live subscription whose payment has failed (state =
 *                  locked). They still hold a membership — they owe
 *                  money on it. Own tab, own chase-list.
 *   'paused'     — live membership on a planned freeze (state =
 *                  paused). Counts as a member, off the at-risk radar.
 *   'active'     — live membership + an activity footprint; scored.
 *   'quarantine' — live membership with zero attendance AND zero
 *                  booking history; routed to triage, not the radar.
 *
 * 'overdue', 'paused', 'active' and 'quarantine' are all live members —
 * together they make up the active base.
 */
export function classifyContact(contact) {
  if (!contact || !MEMBER_STATUSES.includes(contact.glofox_membership_status)) {
    return 'out'
  }
  if (!hasLiveMembership(contact)) return 'out'
  const state = typeof contact.glofox_membership_state === 'string'
    ? contact.glofox_membership_state.toLowerCase()
    : null
  if (state === 'locked') return 'overdue'
  if (state === 'paused') return 'paused'
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

// RADAR-LOW.1 — class-pack member down to their last 1-2 classes. A
// pack emptying without a rebuy is silent churn, and unlike the
// attendance signals it fires precisely BECAUSE they've been training
// (that's how the pack ran down) — the exact moment to sell a top-up.
function detectPackRunningLow(contact) {
  if (contact.glofox_membership_type !== 'num_classes') return null
  const credits = Number(contact.trial_credits_remaining)
  if (!Number.isFinite(credits) || credits <= 0) return null
  if (credits > PACK_LOW_CREDITS) return null
  const critical = credits <= PACK_CRITICAL_CREDITS
  return {
    key: 'pack_low',
    label: 'Pack running low',
    detail: `${credits} class${credits === 1 ? '' : 'es'} left — nudge a rebuy`,
    weight: critical ? 3 : 2,
    severity: critical ? 'critical' : 'warning',
  }
}

const DETECTORS = [
  detectGoneQuiet, detectDisengaging, detectNoShow, detectRenewalCliff,
  detectPackRunningLow,
]

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
    segment: contact.glofox_membership_type === 'num_classes' ? 'credit' : 'member',
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
 * Counts for a contact batch. The active base is every contact with a
 * LIVE membership — active, paused, overdue (in arrears) and
 * quarantine alike — because each of those holds a real membership.
 * On top of that: how many are at risk (and high-tier), the
 * quarantine backlog, the paused count, and the overdue chase-list
 * (count + monthly value owed).
 *
 * Broken down by segment off the membership TYPE — subscription
 * ('time' / unknown) vs class-pack ('num_classes') — because a
 * churning monthly subscriber and a pack holder running low are
 * different problems.
 */
export function radarSummary(contacts, nowMs = Date.now()) {
  const blank = () => ({ activeBase: 0, atRisk: 0, highRisk: 0 })
  const bySegment = { member: blank(), credit: blank() }
  let quarantine = 0
  let paused = 0
  let overdue = 0
  let revenueAtRiskCents = 0
  let overdueValueCents = 0
  for (const c of contacts || []) {
    const cls = classifyContact(c)
    if (cls === 'out') continue
    // Every live member — active, paused, overdue or quarantine —
    // counts toward the active base.
    const seg = c.glofox_membership_type === 'num_classes' ? 'credit' : 'member'
    bySegment[seg].activeBase++
    if (cls === 'quarantine') { quarantine++; continue }
    if (cls === 'paused') { paused++; continue }
    if (cls === 'overdue') {
      overdue++
      overdueValueCents += monthlyValueCents(c)
      continue
    }
    // cls === 'active' — scored on the at-risk radar.
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
    overdue,
    revenueAtRiskCents,
    overdueValueCents,
    bySegment,
  }
}

// ── overdue ──────────────────────────────────────────────────────
// OVERDUE.1 — live members in payment arrears (membership state =
// locked). They still hold a membership; the billing has failed. The
// operator wants a plain chase-list: who owes, how much per month is
// at stake, how long they've been unpaid, and whether they're still
// turning up (an easy save) or already gone.

/**
 * Build the overdue chase-list — live members whose payment has
 * failed. Highest monthly value first, then longest unpaid.
 */
export function buildOverdue(contacts, nowMs = Date.now()) {
  const rows = []
  for (const c of contacts || []) {
    if (classifyContact(c) !== 'overdue') continue
    const dPay = daysSince(c.last_payment_at, nowMs)
    const dAtt = daysSince(c.last_attended_at, nowMs)
    rows.push({
      contactId: c.id,
      name: c.name || 'Member',
      membershipStatus: c.glofox_membership_status,
      membershipPlan: c.glofox_membership_plan || null,
      segment: c.glofox_membership_type === 'num_classes' ? 'credit' : 'member',
      monthlyValueCents: monthlyValueCents(c),
      lastPaymentAt: c.last_payment_at || null,
      daysSincePayment: dPay == null ? null : Math.floor(dPay),
      lastAttendedAt: c.last_attended_at || null,
      daysSinceAttended: dAtt == null ? null : Math.floor(dAtt),
    })
  }
  rows.sort((a, b) => {
    if (b.monthlyValueCents !== a.monthlyValueCents) return b.monthlyValueCents - a.monthlyValueCents
    return (b.daysSincePayment ?? -1) - (a.daysSincePayment ?? -1)
  })
  return rows
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

// ── recovery / outcomes ──────────────────────────────────────────
// RADAR-OUTCOMES.1 — close the loop. The radar logs every time the
// operator reaches out (contacted / task / win-back), but nothing
// measured whether it worked. computeRecoveryStats correlates those
// interventions against last_attended_at: of the members reached out
// to, how many came back to training afterwards. It turns the radar
// from a to-do list into something that proves its own worth.

// Actions that count as "the operator reached out to this member".
const INTERVENTION_ACTIONS = Object.freeze(['contacted', 'task_assigned', 'winback_sent', 'outreach_sent'])

// An intervention newer than this is too recent to judge — the member
// hasn't had a fair chance to come back yet, so it's left out of the
// rate rather than dragging it down.
const RECOVERY_GRACE_DAYS = 4

// Only interventions within this window count — matches the radar's
// 90-day action-log horizon.
const RECOVERY_WINDOW_DAYS = 90

/**
 * Recovery stats for a contact batch + action log. A member counts as
 * "contacted" once they have an intervention action between
 * RECOVERY_GRACE_DAYS and RECOVERY_WINDOW_DAYS old; they count as
 * "recovered" if they attended a class AFTER that first intervention.
 *
 * @returns {{ contacted: number, recovered: number, recoveryRate: number }}
 *          recoveryRate is a 0-1 fraction (0 when nobody's been contacted).
 */
export function computeRecoveryStats(contacts, actions, nowMs = Date.now()) {
  // Earliest in-window intervention timestamp per contact.
  const firstIntervention = new Map()
  for (const a of actions || []) {
    if (!a || !INTERVENTION_ACTIONS.includes(a.action)) continue
    const t = new Date(a.created_at).getTime()
    if (!Number.isFinite(t)) continue
    const ageDays = (nowMs - t) / 86_400_000
    if (ageDays < RECOVERY_GRACE_DAYS || ageDays > RECOVERY_WINDOW_DAYS) continue
    const cur = firstIntervention.get(a.contact_id)
    if (cur == null || t < cur) firstIntervention.set(a.contact_id, t)
  }
  let contacted = 0
  let recovered = 0
  for (const c of contacts || []) {
    if (!c) continue
    const interventionAt = firstIntervention.get(c.id)
    if (interventionAt == null) continue
    contacted++
    const att = c.last_attended_at ? new Date(c.last_attended_at).getTime() : null
    if (att != null && Number.isFinite(att) && att > interventionAt) recovered++
  }
  return {
    contacted,
    recovered,
    recoveryRate: contacted > 0 ? recovered / contacted : 0,
  }
}

// ── trend ────────────────────────────────────────────────────────
// RADAR-TREND.1 — week-over-week movement. computeTrend diffs the
// live summary against the most recent weekly snapshot so the summary
// cards can show "Active base 268, down 4 since last week" instead of
// a bare count with no context.

// Summary metric (camelCase) → churn_radar_snapshots column it
// compares against (snake_case — the snapshot comes straight off DB).
const TREND_METRICS = Object.freeze({
  activeBase:         'active_base',
  atRisk:             'at_risk',
  highRisk:           'high_risk',
  overdue:            'overdue',
  paused:             'paused',
  quarantine:         'quarantine',
  revenueAtRiskCents: 'revenue_at_risk_cents',
  overdueValueCents:  'overdue_value_cents',
})

/**
 * Week-over-week deltas: the live summary minus the most recent
 * weekly snapshot. Each delta is (now − then) — positive means the
 * metric grew. Returns null when there is no snapshot to compare
 * against yet (the first week, before the cron has run).
 *
 * @param {object} summary        live radarSummary output (camelCase)
 * @param {object|null} snapshot  a churn_radar_snapshots row, or null
 * @returns {{ since: string|null, deltas: object }|null}
 */
export function computeTrend(summary, snapshot) {
  if (!summary || !snapshot) return null
  const deltas = {}
  for (const [metric, col] of Object.entries(TREND_METRICS)) {
    deltas[metric] = (Number(summary[metric]) || 0) - (Number(snapshot[col]) || 0)
  }
  return { since: snapshot.captured_at || null, deltas }
}
