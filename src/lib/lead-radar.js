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
// into two intents:
//
//   FUNNEL  — the live cohort worth a follow-up: ClassPass drop-ins
//             to convert, trials attending but not yet converted,
//             freshly-joined leads with no visit yet.
//   CLEANUP — the dormant remainder: lead/trial records that joined
//             months-to-years ago and never booked or attended.
//             Triaged once ("keep" / "archive candidate"), never a
//             daily list.
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
 *   'attending' — booked or attended a class within ATTENDING_DAYS.
 *   'fresh'     — joined within FRESH_DAYS, no activity yet.
 *   'cooling'   — joined FRESH_DAYS..COOLING_DAYS ago, no activity.
 *   'dormant'   — joined over COOLING_DAYS ago, no activity.
 *   'no_sale'   — explicitly marked no-sale; dead regardless of age.
 * Funnel = attending + fresh. Cleanup = cooling + dormant + no_sale.
 */
export function classifyNonMember(contact, nowMs = Date.now()) {
  const status = contact?.glofox_membership_status
  if (!status || !NON_MEMBER_STATUSES.includes(status)) return 'out'
  if (NO_SALE_STATUSES.includes(status)) return 'no_sale'

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
// follow-up, and how hard. ClassPass drop-ins outrank trials
// (membership conversion = recurring revenue), trials outrank
// re-engaged leads (a live trial has a closing window), and any
// attender outranks a fresh no-activity signup.
function funnelSignal(contact, category) {
  const status = contact.glofox_membership_status
  if (category === 'attending') {
    if (status === 'classpass_payg') {
      return {
        key: 'classpass_convert',
        label: 'Active ClassPass',
        detail: 'Attending on ClassPass — convert to membership',
        weight: 4,
      }
    }
    if (status === 'trial') {
      return {
        key: 'trial_convert',
        label: 'Trial attending',
        detail: 'Attending on trial — not yet converted',
        weight: 3,
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

/**
 * Counts for a contact batch — the Lead Radar denominators. Funnel
 * and cleanup totals, each broken down by category, so the page can
 * show "203 attending / 260 fresh" and "600 cooling / 5,900 dormant".
 */
export function leadRadarSummary(contacts, nowMs = Date.now()) {
  const funnel = { attending: 0, fresh: 0 }
  const cleanup = { cooling: 0, dormant: 0, no_sale: 0 }
  for (const c of contacts || []) {
    const cls = classifyNonMember(c, nowMs)
    if (cls === 'attending' || cls === 'fresh') funnel[cls]++
    else if (cls === 'cooling' || cls === 'dormant' || cls === 'no_sale') cleanup[cls]++
  }
  return {
    funnelTotal: funnel.attending + funnel.fresh,
    funnel,
    cleanupTotal: cleanup.cooling + cleanup.dormant + cleanup.no_sale,
    cleanup,
  }
}
