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

const DETECTORS = [detectGoneQuiet, detectDisengaging, detectNoShow]

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
    }
  }
  return {
    activeBase: bySegment.member.activeBase + bySegment.credit.activeBase,
    atRisk: bySegment.member.atRisk + bySegment.credit.atRisk,
    highRisk: bySegment.member.highRisk + bySegment.credit.highRisk,
    quarantine,
    paused,
    bySegment,
  }
}
