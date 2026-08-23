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

// CHURN-CLEAN.1 — plan names that are NOT a real paying membership:
// Glofox trials, free intro/open weeks, taster sessions, single-class
// one-offs, and body scans. The churn radar is for genuine paying
// customers (recurring subscriptions + regular class-pack buyers who've
// dropped off) — a lead, a trial, or a one-off class pack must never
// appear. Grounded in the live Stillorgan catalogue: "The UN1T Trial",
// "Black Friday Open Week", "1 Class Pack", "1 Scan". A "1 Class"/"1
// Class Pack" is anchored at the start so "10 Class Pack" / "1 Year
// Membership" are NOT matched.
const NON_MEMBER_PLAN_RE = /(\btrial\b|open\s*week|\btaster|\bintro|\bscan\b|^\s*1\s+class\b)/i

/**
 * Is this membership plan a real paying membership (vs a trial / open
 * week / taster / one-off class / scan)? A missing plan name is treated
 * as real — the type/state gate still applies — so we never exclude a
 * genuine member purely because Glofox didn't return a plan label.
 */
export function isRealMembershipPlan(plan) {
  if (!plan) return true
  return !NON_MEMBER_PLAN_RE.test(String(plan))
}

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

// Payment-slipping (Churn Radar Phase 2 — RADAR-PAY.1). A recurring
// member whose last payment is past due by more than the grace window,
// measured against their own billing cycle. 30.44 ≈ mean days/month so
// a 3-month plan isn't read as overdue at day 31. Grace covers normal
// card-retry lag; past the critical mark a lock is imminent.
const DAYS_PER_MONTH = 30.44
const SLIP_GRACE_DAYS = 3
const SLIP_CRITICAL_DAYS = 7

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
  // CHURN-CLEAN.1 — a trial / open-week / one-off / scan plan is never a
  // real paying membership, whatever Glofox's status or type says.
  if (!isRealMembershipPlan(contact.glofox_membership_plan)) return false
  const type = typeof contact.glofox_membership_type === 'string'
    ? contact.glofox_membership_type.toLowerCase()
    : null
  if (type === 'num_classes') {
    // CHURN-CLEAN.1 — a class pack only counts when Glofox's reliable
    // credit-member detection tagged it (status='credit_member', via the
    // /credits + /memberships endpoints — GLOFOX2.1.11 Plan A). A
    // 'member' + num_classes row is the STALE trial-pack reference on
    // member.membership (typically the initial trial pack), NOT the
    // member's current product — so it is not a live membership.
    if (contact.glofox_membership_status !== 'credit_member') return false
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
 *   'overdue'    — has an OPEN PAST_DUE invoice (genuinely owes money).
 *                  Own tab, own chase-list.
 *   'paused'     — live membership on a planned freeze (state =
 *                  paused). Counts as a member, off the at-risk radar.
 *   'active'     — live membership + an activity footprint; scored.
 *   'quarantine' — live membership with zero attendance AND zero
 *                  booking history; routed to triage, not the radar.
 *
 * 'overdue', 'paused', 'active' and 'quarantine' are all live members —
 * together they make up the active base.
 *
 * RADAR-OVERDUE.1 — overdue is driven by the AUTHORITATIVE arrears
 * signal, an open PAST_DUE invoice (`glofox_invoices`), NOT the stale
 * `member.membership.status='locked'` field. Glofox's singular
 * membership reference is unreliable (GLOFOX2.1.9 / the audit in
 * docs/CHURN_OVERDUE_AUDIT_2026-06.md): it flagged class-pack holders
 * who'd paid in full and missed the real debtors. `ctx.pastDueIds` is
 * the Set of contact ids with an open past-due invoice at this location,
 * supplied by the data layer; the pure scorer stays I/O-free. A class
 * pack (paid upfront) simply never carries a recurring past-due invoice.
 */
export function classifyContact(contact, ctx = {}) {
  if (!contact || !MEMBER_STATUSES.includes(contact.glofox_membership_status)) {
    return 'out'
  }
  // Genuinely owes money — checked before the live-membership gate so a
  // member in arrears on a now-ended membership still surfaces as a debt.
  if (ctx.pastDueIds && ctx.pastDueIds.has(contact.id)) return 'overdue'
  if (!hasLiveMembership(contact)) return 'out'
  const state = typeof contact.glofox_membership_state === 'string'
    ? contact.glofox_membership_state.toLowerCase()
    : null
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

// RADAR-PAY.1 (Churn Radar Phase 2) — a subscription member whose
// recurring payment is past due but whom Glofox HASN'T locked yet. By
// the time state flips to 'locked' the member is already on the Overdue
// chase-list (classifyContact → 'overdue', off the at-risk radar); this
// fires in the gap before that — a missed/failed charge that Glofox is
// still retrying — when a one-tap payment reminder still recovers them
// quietly. Class packs (paid upfront) and PAYG (pay-per-visit) have no
// recurring cycle to slip, so it only applies to interval-billed subs.
// scoreMember only runs on 'active' members, so locked members never
// reach here regardless of how late Glofox's lock lands.
function detectPaymentSlipping(contact, nowMs) {
  const type = typeof contact.glofox_membership_type === 'string'
    ? contact.glofox_membership_type.toLowerCase()
    : null
  if (type === 'num_classes' || type === 'payg') return null
  const cycleMonths = intervalMonths(contact.glofox_billing_interval)
  if (!cycleMonths) return null
  const sincePay = daysSince(contact.last_payment_at, nowMs)
  if (sincePay == null) return null
  const overdue = sincePay - cycleMonths * DAYS_PER_MONTH
  if (overdue <= SLIP_GRACE_DAYS) return null
  const days = Math.floor(overdue)
  const critical = overdue >= SLIP_CRITICAL_DAYS
  return {
    key: 'payment_slipping',
    label: 'Payment slipping',
    detail: `Payment ${days} day${days === 1 ? '' : 's'} overdue — chase before lock`,
    weight: 3,
    severity: critical ? 'critical' : 'warning',
  }
}

const DETECTORS = [
  detectGoneQuiet, detectDisengaging, detectNoShow, detectRenewalCliff,
  detectPackRunningLow, detectPaymentSlipping,
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
export function scoreMember(contact, nowMs = Date.now(), ctx = {}) {
  if (classifyContact(contact, ctx) !== 'active') return null
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
 * Is this contact in payment trouble right now, and of which kind?
 *   'overdue'  — Glofox has locked the membership (state = locked);
 *                they're on the Overdue chase-list.
 *   'slipping' — still active, but the recurring payment is past due
 *                (detectPaymentSlipping fires) — the early-warning gap
 *                before Glofox locks them.
 *   null       — not behind on payment.
 *
 * The server-side guard for the one-click dunning action (RADAR-PAY.1):
 * a "Send payment reminder" must only ever enrol a member who is
 * genuinely behind, never a paying one.
 */
export function paymentTroubleKind(contact, nowMs = Date.now(), ctx = {}) {
  const cls = classifyContact(contact, ctx)
  if (cls === 'overdue') return 'overdue'
  if (cls === 'active' && detectPaymentSlipping(contact, nowMs)) return 'slipping'
  return null
}

/**
 * RADAR-PAY.2 — the post-refresh radar verdict for one member, for the
 * refresh-member route. Pure wrapper around classifyContact +
 * paymentTroubleKind that supplies the two things the route can't: the
 * past-due context (both functions gate their 'overdue' branch on
 * ctx.pastDueIds — see classifyContact) and the contact `id` (the route's
 * STATE_COLUMNS re-read omits it, so ctx.pastDueIds.has(contact.id) would
 * check `undefined` and never match). Without this a member who genuinely
 * owes could never read 'overdue', and — when their subscription wasn't
 * separately "slipping" — wrongly reported still_flagged=false.
 *
 * @param {object|null} fresh - the re-read contact state row (no id)
 * @param {string} contactId - the contact's id (carries the open invoices)
 * @param {number} pastDueCount - surviving (netted) open PAST_DUE rows for this contact
 * @returns {{ classification: string, trouble: 'overdue'|'slipping'|null, stillFlagged: boolean }}
 */
export function classifyRefreshedMember(fresh, contactId, pastDueCount = 0, nowMs = Date.now()) {
  const contact = { ...(fresh || {}), id: contactId }
  const ctx = pastDueCount > 0 ? { pastDueIds: new Set([contactId]) } : {}
  const classification = classifyContact(contact, ctx)
  const trouble = paymentTroubleKind(contact, nowMs, ctx)
  return {
    classification,
    trouble,
    stillFlagged: classification === 'overdue' || trouble !== null,
  }
}

/**
 * Score a batch of contacts. Returns the at-risk list (members
 * tripping ≥1 signal), highest score first, then longest-quiet
 * first. Members with no signals — the healthy active base — are
 * omitted.
 */
export function buildRadar(contacts, nowMs = Date.now(), ctx = {}) {
  const scored = []
  for (const c of contacts || []) {
    const r = scoreMember(c, nowMs, ctx)
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
export function radarSummary(contacts, nowMs = Date.now(), ctx = {}) {
  const blank = () => ({ activeBase: 0, atRisk: 0, highRisk: 0 })
  const bySegment = { member: blank(), credit: blank() }
  let quarantine = 0
  let paused = 0
  let overdue = 0
  let revenueAtRiskCents = 0
  let overdueValueCents = 0
  for (const c of contacts || []) {
    const cls = classifyContact(c, ctx)
    if (cls === 'out') continue
    // Every live member — active, paused, overdue or quarantine —
    // counts toward the active base.
    const seg = c.glofox_membership_type === 'num_classes' ? 'credit' : 'member'
    bySegment[seg].activeBase++
    if (cls === 'quarantine') { quarantine++; continue }
    if (cls === 'paused') { paused++; continue }
    if (cls === 'overdue') {
      overdue++
      // The real amount owed (sum of open PAST_DUE invoices) when the data
      // layer supplied it; falls back to the monthly value as an estimate.
      const pd = ctx.pastDueById && ctx.pastDueById.get(c.id)
      overdueValueCents += pd ? pd.amountCents : monthlyValueCents(c)
      continue
    }
    // cls === 'active' — scored on the at-risk radar.
    const r = scoreMember(c, nowMs, ctx)
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
// RADAR-OVERDUE.1 — contacts with an OPEN PAST_DUE invoice. The
// operator wants a plain chase-list: who owes, the real amount owed
// (sum of their open past-due invoices), how long the oldest has been
// unpaid, and whether they're still turning up (an easy save) or gone.
// Driven by `glofox_invoices` (status='PAST_DUE'), supplied via
// ctx.pastDueById — see classifyContact + docs/CHURN_OVERDUE_AUDIT_2026-06.md.

// ARREARS-TYPE.1 — the tabs route by CHARGE TYPE (Richard's rule, 2026-08-23),
// not by the old €50 amount line (RADAR-OVERDUE.1). The amount was only ever a
// proxy for "is this a failed renewal or a small fee?", and it misrouted both
// ways: a €380 failed class pack landed on the chase-list, a €25 failed renewal
// would have been filed as a small charge. The split itself happens in
// fetchPastDue (churn-radar-data.js, via isMembershipInvoice); this maps its
// per-contact aggregates onto the tabs and drops empty ones.

/**
 * Bucket per-contact arrears into the three radar tabs:
 *   overdueById      — PAST_DUE membership payments (a failed subscription
 *                      renewal or first payment): the chase-list. Any amount.
 *   unpaidById       — every other PAST_DUE charge (late-cancel / no-show fees,
 *                      custom charges, class bookings, class packs, products).
 *                      Any amount.
 *   awaitingAuthById — PENDING ("awaiting authorization" in Glofox): a payment
 *                      in progress, not a confirmed debt. Never in the other two.
 * A contact can appear in more than one tab — a failed renewal in Overdue AND a
 * failed fee in Unpaid charges, each with its own amount.
 *
 * @param {{ membershipById?: Map, chargesById?: Map, pendingById?: Map }} arrears
 *   per-contact `{ amountCents, count, oldestDueAt }` aggregates from fetchPastDue
 * @returns {{ overdueById: Map, unpaidById: Map, awaitingAuthById: Map }}
 */
export function bucketArrears(arrears) {
  const nonEmpty = (m) => {
    const out = new Map()
    if (!(m instanceof Map)) return out
    for (const [id, agg] of m) {
      if ((agg?.amountCents || 0) > 0) out.set(id, agg)
    }
    return out
  }
  return {
    overdueById: nonEmpty(arrears?.membershipById),
    unpaidById: nonEmpty(arrears?.chargesById),
    awaitingAuthById: nonEmpty(arrears?.pendingById),
  }
}

/**
 * Build the overdue chase-list from the past-due invoice aggregate in
 * `ctx.pastDueById` (Map<contactId, { amountCents, count, oldestDueAt }>).
 * Includes any supplied contact carrying an open past-due invoice —
 * membership type/state is irrelevant to a debt. Highest amount owed
 * first, then longest overdue. Returns [] when no aggregate is supplied.
 */
export function buildOverdue(contacts, nowMs = Date.now(), ctx = {}) {
  const byId = ctx.pastDueById
  if (!byId) return []
  const rows = []
  for (const c of contacts || []) {
    const pd = byId.get(c.id)
    if (!pd) continue
    const dDue = daysSince(pd.oldestDueAt, nowMs)
    const dAtt = daysSince(c.last_attended_at, nowMs)
    rows.push({
      contactId: c.id,
      name: c.name || 'Member',
      membershipStatus: c.glofox_membership_status,
      membershipPlan: c.glofox_membership_plan || null,
      segment: c.glofox_membership_type === 'num_classes' ? 'credit' : 'member',
      // The real amount owed — sum of the contact's open PAST_DUE invoices.
      amountOwedCents: pd.amountCents || 0,
      invoiceCount: pd.count || 0,
      oldestDueAt: pd.oldestDueAt || null,
      // Days since the OLDEST unpaid invoice fell due (the real arrears
      // clock) — not "days since last payment".
      daysOverdue: dDue == null ? null : Math.floor(dDue),
      lastAttendedAt: c.last_attended_at || null,
      daysSinceAttended: dAtt == null ? null : Math.floor(dAtt),
    })
  }
  rows.sort((a, b) => {
    if (b.amountOwedCents !== a.amountOwedCents) return b.amountOwedCents - a.amountOwedCents
    return (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1)
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
  // CHURN-CLEAN.1 — a trial / one-off plan, or the stale member+num_classes
  // trial-pack reference, was never a real member, so there's nothing to
  // win back. (ex_member + real subscriptions / packs still qualify.)
  if (!isRealMembershipPlan(contact.glofox_membership_plan)) return null
  if (status === 'member'
    && String(contact.glofox_membership_type || '').toLowerCase() === 'num_classes') return null
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
