// LEAD-RADAR.1 — non-member triage scoring.
//
// Pure functions: no DB, no I/O. The API route fetches the contact
// rows + the action log, calls these to score, then applies action
// filtering on top.
//
// Scope (shaped by the data — see SESSION_STATE.md): the contacts
// table carries ~7,100 non-member records — trial / lead /
// classpass_payg / cold / no_sale_* — alongside the ~1,074 paying
// members the Churn Radar scores. Only ~200 of those non-members
// have ANY class-activity footprint. The Lead Radar splits this base
// into three intents:
//
//   FUNNEL    — the live cohort worth chasing to convert: trials
//               attending but not yet converted, and freshly-joined
//               leads with no visit yet.
//   CLASSPASS — ClassPass drop-ins (classpass_payg). A flexible-
//               pricing cohort that rarely converts to a direct
//               membership, so LEAD-CLASSPASS.1 pulled them out of
//               the funnel: they get a read-only view, shown for
//               awareness only, never a conversion follow-up list.
//   CLEANUP   — the dormant remainder: lead/trial records that joined
//               months-to-years ago and never booked or attended.
//               Triaged once ("keep" / "archive candidate"), never a
//               daily list.
//
// joined_at is the age signal. contacts.created_at is NOT usable —
// it's the CRM-import timestamp (the base was bulk-imported), so
// every row looks 30 days old. joined_at is the Glofox-side signup
// date and spans 2021..now.

// Non-member statuses the radar covers. member / credit_member are
// the Churn Radar's population; anything else here is out of scope.
export const NON_MEMBER_STATUSES = Object.freeze([
  'trial', 'lead', 'classpass_payg', 'cold', 'tour',
  'no_sale_trial', 'no_sale_tour',
])

// Statuses that mean the prospect explicitly didn't buy — dead by
// definition, routed straight to Cleanup whatever their age.
const NO_SALE_STATUSES = Object.freeze(['no_sale_trial', 'no_sale_tour'])

// Activity inside this window = "attending" — a live opportunity.
const ATTENDING_DAYS = 90
// Joined inside this window with no activity = still "fresh" enough
// to chase. Past it (but under a year) the lead is "cooling".
const FRESH_DAYS = 120
const COOLING_DAYS = 365

const TIER_HIGH = 4
const TIER_MEDIUM = 2

// ── helpers ──────────────────────────────────────────────────────

function daysSince(value, nowMs) {
  if (!value) return null
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return null
  return (nowMs - t) / 86_400_000
}

// Most recent class-activity timestamp — attended or booked.
function lastActivity(contact) {
  const a = contact.last_attended_at ? new Date(contact.last_attended_at).getTime() : 0
  const b = contact.last_booked_at ? new Date(contact.last_booked_at).getTime() : 0
  const t = Math.max(a, b)
  return t > 0 ? new Date(t).toISOString() : null
}

/**
 * Classify a non-member contact relative to the Lead Radar:
 *   'out'       — a paying member or an unrecognised status; not in scope.
 *   'classpass' — a ClassPass drop-in (classpass_payg). Read-only
 *                 cohort; never funnel, never cleanup, whatever the age.
 *   'attending' — booked or attended a class within ATTENDING_DAYS.
 *   'fresh'     — joined within FRESH_DAYS, no activity yet.
 *   'cooling'   — joined FRESH_DAYS..COOLING_DAYS ago, no activity.
 *   'dormant'   — joined over COOLING_DAYS ago, no activity.
 *   'no_sale'   — explicitly marked no-sale; dead regardless of age.
 * Funnel = attending + fresh. Cleanup = cooling + dormant + no_sale.
 * ClassPass stands alone — see buildClassPass.
 */
export function classifyNonMember(contact, nowMs = Date.now()) {
  const status = contact?.glofox_membership_status
  if (!status || !NON_MEMBER_STATUSES.includes(status)) return 'out'
  if (NO_SALE_STATUSES.includes(status)) return 'no_sale'
  // LEAD-CLASSPASS.1 — ClassPass drop-ins are a flexible-pricing
  // cohort, unlikely to convert to a direct membership. They get
  // their own read-only view, so they never enter the funnel or the
  // cleanup list regardless of class activity or join age.
  if (status === 'classpass_payg') return 'classpass'

  const act = daysSince(lastActivity(contact), nowMs)
  if (act != null && act <= ATTENDING_DAYS) return 'attending'

  const joined = daysSince(contact.joined_at, nowMs)
  // No usable join date — don't auto-condemn to dormant, don't
  // promote to fresh; park it in cooling for a human to look at.
  if (joined == null) return 'cooling'
  if (joined <= FRESH_DAYS) return 'fresh'
  if (joined <= COOLING_DAYS) return 'cooling'
  return 'dormant'
}

// ── funnel scoring ───────────────────────────────────────────────

function tierFor(score) {
  if (score >= TIER_HIGH) return 'high'
  if (score >= TIER_MEDIUM) return 'medium'
  return 'low'
}

// The single funnel signal for a contact — what makes it worth a
// follow-up, and how hard. An attending trial is the hottest lead
// (a live trial has a closing window), it outranks a re-engaged
// lead, and any attender outranks a fresh no-activity signup.
// ClassPass drop-ins are no longer scored here — LEAD-CLASSPASS.1
// routes classpass_payg to its own read-only view, so a ClassPass
// contact never reaches funnelSignal.
function funnelSignal(contact, category) {
  const status = contact.glofox_membership_status
  if (category === 'attending') {
    if (status === 'trial') {
      return {
        key: 'trial_convert',
        label: 'Trial attending',
        detail: 'Attending on trial — not yet converted',
        weight: 4,
      }
    }
    return {
      key: 'reengaged',
      label: 'Re-engaged',
      detail: 'Recent class activity',
      weight: 2,
    }
  }
  // fresh
  return {
    key: 'fresh_signup',
    label: 'New signup',
    detail: 'Recently joined — no class visit yet',
    weight: 1,
  }
}

/**
 * Score one funnel contact (category 'attending' or 'fresh').
 * Returns null for any contact not in the funnel.
 */
export function scoreFunnelContact(contact, nowMs = Date.now()) {
  const category = classifyNonMember(contact, nowMs)
  if (category !== 'attending' && category !== 'fresh') return null
  const signal = funnelSignal(contact, category)
  const actAt = lastActivity(contact)
  return {
    contactId: contact.id,
    name: contact.name || 'Contact',
    category,
    status: contact.glofox_membership_status,
    score: signal.weight,
    tier: tierFor(signal.weight),
    signal,
    lastActivityAt: actAt,
    daysSinceActivity: (() => {
      const d = daysSince(actAt, nowMs)
      return d == null ? null : Math.floor(d)
    })(),
    joinedAt: contact.joined_at || null,
    daysSinceJoined: (() => {
      const d = daysSince(contact.joined_at, nowMs)
      return d == null ? null : Math.floor(d)
    })(),
  }
}

/**
 * Build the funnel list — non-members worth a follow-up, highest
 * score first. Within a tier: attenders before fresh signups, then
 * most-recent activity (attenders) / most-recent join (fresh).
 */
export function buildFunnel(contacts, nowMs = Date.now()) {
  const scored = []
  for (const c of contacts || []) {
    const r = scoreFunnelContact(c, nowMs)
    if (r) scored.push(r)
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aKey = a.category === 'attending'
      ? (a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0)
      : (a.joinedAt ? new Date(a.joinedAt).getTime() : 0)
    const bKey = b.category === 'attending'
      ? (b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0)
      : (b.joinedAt ? new Date(b.joinedAt).getTime() : 0)
    return bKey - aKey
  })
  return scored
}

// ── cleanup list ─────────────────────────────────────────────────

const CLEANUP_REASON = {
  no_sale: 'Marked no-sale — never converted',
  dormant: 'Joined over a year ago — no class activity',
  cooling: 'Joined months ago — no class activity',
}

/**
 * Build the cleanup list — dormant non-member records that are
 * archive candidates. Longest-dormant first (oldest joined_at), so
 * the most obviously stale records surface at the top.
 */
export function buildCleanup(contacts, nowMs = Date.now()) {
  const rows = []
  for (const c of contacts || []) {
    const cls = classifyNonMember(c, nowMs)
    if (cls !== 'cooling' && cls !== 'dormant' && cls !== 'no_sale') continue
    rows.push({
      contactId: c.id,
      name: c.name || 'Contact',
      status: c.glofox_membership_status,
      bucket: cls,
      reason: CLEANUP_REASON[cls],
      joinedAt: c.joined_at || null,
      lastActivityAt: lastActivity(c),
      daysSinceJoined: (() => {
        const d = daysSince(c.joined_at, nowMs)
        return d == null ? null : Math.floor(d)
      })(),
    })
  }
  rows.sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0))
  return rows
}

// ── classpass list ───────────────────────────────────────────────
// LEAD-CLASSPASS.1 — the read-only ClassPass view. ClassPass drop-ins
// rarely convert to a direct membership, so they sit outside the
// funnel and the cleanup list. This surface is awareness-only: no
// score, no triage actions. `attending` flags whoever has class
// activity inside ATTENDING_DAYS so the UI can split active from
// lapsed ClassPass users.

/**
 * Build the ClassPass list — every classpass_payg non-member, most
 * recently active first (never-active records sink to the bottom).
 */
export function buildClassPass(contacts, nowMs = Date.now()) {
  const rows = []
  for (const c of contacts || []) {
    if (classifyNonMember(c, nowMs) !== 'classpass') continue
    const actAt = lastActivity(c)
    const actDays = daysSince(actAt, nowMs)
    rows.push({
      contactId: c.id,
      name: c.name || 'Contact',
      status: c.glofox_membership_status,
      attending: actDays != null && actDays <= ATTENDING_DAYS,
      lastActivityAt: actAt,
      daysSinceActivity: actDays == null ? null : Math.floor(actDays),
      joinedAt: c.joined_at || null,
      daysSinceJoined: (() => {
        const d = daysSince(c.joined_at, nowMs)
        return d == null ? null : Math.floor(d)
      })(),
    })
  }
  rows.sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
  return rows
}

/**
 * Counts for a contact batch — the Lead Radar denominators. Funnel,
 * classpass and cleanup totals, each broken down by category, so the
 * page can show "203 attending / 260 fresh", "190 attending / 1,348
 * lapsed" and "600 cooling / 5,900 dormant".
 */
export function leadRadarSummary(contacts, nowMs = Date.now()) {
  const funnel = { attending: 0, fresh: 0 }
  const cleanup = { cooling: 0, dormant: 0, no_sale: 0 }
  const classpass = { attending: 0, lapsed: 0 }
  for (const c of contacts || []) {
    const cls = classifyNonMember(c, nowMs)
    if (cls === 'attending' || cls === 'fresh') funnel[cls]++
    else if (cls === 'cooling' || cls === 'dormant' || cls === 'no_sale') cleanup[cls]++
    else if (cls === 'classpass') {
      const d = daysSince(lastActivity(c), nowMs)
      if (d != null && d <= ATTENDING_DAYS) classpass.attending++
      else classpass.lapsed++
    }
  }
  return {
    funnelTotal: funnel.attending + funnel.fresh,
    funnel,
    cleanupTotal: cleanup.cooling + cleanup.dormant + cleanup.no_sale,
    cleanup,
    classpassTotal: classpass.attending + classpass.lapsed,
    classpass,
  }
}

// ── outcomes / conversion ────────────────────────────────────────
// LEAD-OUTCOMES.1 — close the loop. The funnel logs every time the
// operator contacts a lead, but nothing measured whether it worked.
// computeLeadConversionStats correlates those contacts against class
// activity: of the leads reached out to, how many booked or attended
// a class afterwards — the funnel's equivalent of "did the outreach
// land".

// Funnel actions that count as "the operator reached out to a lead".
const LEAD_INTERVENTION_ACTIONS = Object.freeze(['contacted', 'outreach_sent'])

// A contact newer than this is too recent to judge — left out of the
// rate rather than dragging it down before the lead has had a fair
// chance to come in.
const CONVERSION_GRACE_DAYS = 4

// Only contacts within this window count — matches the radar's
// 90-day action-log horizon.
const CONVERSION_WINDOW_DAYS = 90

/**
 * Conversion stats for a contact batch + the lead action log. A lead
 * counts as "contacted" once it has a 'contacted' action between
 * CONVERSION_GRACE_DAYS and CONVERSION_WINDOW_DAYS old; it counts as
 * "progressed" if it booked or attended a class AFTER that first
 * contact.
 *
 * @returns {{ contacted: number, progressed: number, progressionRate: number }}
 *   progressionRate is a 0-1 fraction (0 when nobody's been contacted).
 */
export function computeLeadConversionStats(contacts, actions, nowMs = Date.now()) {
  // Earliest in-window contact per lead.
  const firstContact = new Map()
  for (const a of actions || []) {
    if (!a || !LEAD_INTERVENTION_ACTIONS.includes(a.action)) continue
    const t = new Date(a.created_at).getTime()
    if (!Number.isFinite(t)) continue
    const ageDays = (nowMs - t) / 86_400_000
    if (ageDays < CONVERSION_GRACE_DAYS || ageDays > CONVERSION_WINDOW_DAYS) continue
    const cur = firstContact.get(a.contact_id)
    if (cur == null || t < cur) firstContact.set(a.contact_id, t)
  }
  let contacted = 0
  let progressed = 0
  for (const c of contacts || []) {
    if (!c) continue
    const contactAt = firstContact.get(c.id)
    if (contactAt == null) continue
    contacted++
    const act = lastActivity(c)
    const actMs = act ? new Date(act).getTime() : null
    if (actMs != null && Number.isFinite(actMs) && actMs > contactAt) progressed++
  }
  return {
    contacted,
    progressed,
    progressionRate: contacted > 0 ? progressed / contacted : 0,
  }
}

// ── trend ────────────────────────────────────────────────────────
// LEAD-TREND.1 — week-over-week movement. computeLeadTrend diffs the
// live summary against the most recent weekly snapshot so the summary
// cards can show "Funnel 463, up 12 since last week".

/**
 * Week-over-week deltas: the live Lead Radar summary minus the most
 * recent weekly snapshot. Each delta is (now − then). Returns null
 * when there is no snapshot to compare against yet.
 *
 * @param {object} summary        live leadRadarSummary output
 * @param {object|null} snapshot  a lead_radar_snapshots row, or null
 * @returns {{ since: string|null, deltas: object }|null}
 */
export function computeLeadTrend(summary, snapshot) {
  if (!summary || !snapshot) return null
  const live = {
    funnelTotal:  Number(summary.funnelTotal) || 0,
    attending:    Number(summary.funnel?.attending) || 0,
    fresh:        Number(summary.funnel?.fresh) || 0,
    cleanupTotal: Number(summary.cleanupTotal) || 0,
  }
  const then = {
    funnelTotal:  Number(snapshot.funnel_total) || 0,
    attending:    Number(snapshot.attending) || 0,
    fresh:        Number(snapshot.fresh) || 0,
    cleanupTotal: Number(snapshot.cleanup_total) || 0,
  }
  return {
    since: snapshot.captured_at || null,
    deltas: {
      funnelTotal:  live.funnelTotal - then.funnelTotal,
      attending:    live.attending - then.attending,
      fresh:        live.fresh - then.fresh,
      cleanupTotal: live.cleanupTotal - then.cleanupTotal,
    },
  }
}
