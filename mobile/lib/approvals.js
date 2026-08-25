// Pure helpers for the mobile Approvals inbox. No React/Supabase — operates on
// the /api/approvals/pending `providers` array. Lives in mobile/lib so the root
// vitest picks it up (config includes mobile/lib/**).
//
// APPROVALS-STUDIO.1 — the inbox is TWO tabs:
//   Customers        agent_requests (Mia bookings, funnel reviews, pauses,
//                    cancellations, memberships, events) — a real person is
//                    waiting, so it's the default tab and urgency-sorted.
//   Everything else  the internal categories. The four actionable ones render
//                    decide cards; the rest render as nav tiles into their
//                    dedicated screens.

// Internal categories actioned inline on this screen, in display order.
// host_events (HOST-APPROVALS.1): approve/reject a host-submitted event —
// executes via POST /api/events/[id]/review, reject requires a reason.
export const MOBILE_APPROVAL_KEYS = ['host_events', 'time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices']

// Internal categories with a dedicated mobile surface — the inbox links out
// instead of re-implementing their review flows.
export const TEAM_NAV_ROUTES = Object.freeze({
  invoices_queue: '/invoices/inbox',
  issues: '/issues',
  hyrox_sessions: '/hyrox',
  rosters: '/schedule',
})

function byKey(providers) {
  const map = {}
  for (const p of Array.isArray(providers) ? providers : []) {
    if (p && p.key) map[p.key] = p
  }
  return map
}

// ── Customers tab ───────────────────────────────────────────────────

// Millis until the item's deadline, if its details carry one (ISO starts_at —
// written by the /start funnel's routeToReview and MIA-BOOK follow-ups).
// Label-only class_time strings are NOT parsed (locale/TZ roulette); those
// items sort by age instead.
export function itemDeadline(item, now = Date.now()) {
  const iso = item?.details?.starts_at
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t - now : null
}

// Chip for a customer card: countdown to the class when known, otherwise the
// waiting-age escalation. tone: 'danger' | 'warn' | 'muted'.
export function urgencyChip(item, now = Date.now()) {
  const delta = itemDeadline(item, now)
  if (delta != null) {
    if (delta <= 0) return { label: 'class passed', tone: 'danger' }
    const mins = Math.round(delta / 60000)
    if (mins < 120) return { label: `class in ${mins} min`, tone: 'danger' }
    const hours = Math.round(mins / 60)
    if (hours < 48) return { label: `class in ${hours}h`, tone: hours <= 12 ? 'warn' : 'muted' }
    return { label: `class in ${Math.round(hours / 24)}d`, tone: 'muted' }
  }
  const submitted = item?.submittedAt ? new Date(item.submittedAt).getTime() : NaN
  if (!Number.isFinite(submitted)) return { label: null, tone: 'muted' }
  const waitedH = Math.floor((now - submitted) / 3600000)
  if (waitedH >= 24) return { label: `waiting ${waitedH}h`, tone: 'warn' }
  if (waitedH >= 1) return { label: `${waitedH}h ago`, tone: 'muted' }
  const waitedM = Math.max(1, Math.floor((now - submitted) / 60000))
  return { label: `${waitedM}m ago`, tone: 'muted' }
}

// Deadline items first (soonest class up top), then the rest oldest-waiting
// first — position IS priority, nothing sinks quietly.
function sortByUrgency(items, now) {
  return items.sort((a, b) => {
    const da = itemDeadline(a, now)
    const db = itemDeadline(b, now)
    if (da != null && db != null) return da - db
    if (da != null) return -1
    if (db != null) return 1
    const ta = a.submittedAt ? new Date(a.submittedAt).getTime() : now
    const tb = b.submittedAt ? new Date(b.submittedAt).getTime() : now
    return ta - tb
  })
}

// Customers queue: the pending agent requests.
export function customerQueue(providers, now = Date.now()) {
  const agent = byKey(providers).agent_requests
  const items = agent && Array.isArray(agent.items) ? [...agent.items] : []
  return sortByUrgency(items, now)
}

// AGENT-RETRY.2 — failed executions the server still offers for retry
// (class in the future / recent failure — the gate lives server-side in the
// provider, mobile renders what it is sent). Same urgency sort: a failed
// booking for a class starting soon is the most on-fire thing in the hub.
export function failedQueue(providers, now = Date.now()) {
  const agent = byKey(providers).agent_requests
  const items = agent && Array.isArray(agent.failedItems) ? [...agent.failedItems] : []
  return sortByUrgency(items, now)
}

// ── Everything-else tab ─────────────────────────────────────────────

// The non-empty inline-actionable provider sections, in MOBILE_APPROVAL_KEYS
// order. Each is the provider object ({ key, label, count, items }).
export function mobileApprovalSections(providers) {
  const map = byKey(providers)
  return MOBILE_APPROVAL_KEYS
    .map((k) => map[k])
    .filter((p) => p && Array.isArray(p.items) && p.items.length > 0)
}

// Nav tiles for the categories with their own mobile screens, non-empty only.
export function teamNavTiles(providers) {
  const map = byKey(providers)
  return Object.keys(TEAM_NAV_ROUTES)
    .map((k) => map[k])
    .filter((p) => p && (p.count || 0) > 0)
    .map((p) => ({ key: p.key, label: p.label, count: p.count, route: TEAM_NAV_ROUTES[p.key] }))
}

// ── Badges ──────────────────────────────────────────────────────────

export function customerBadgeCount(providers) {
  return byKey(providers).agent_requests?.count || 0
}

export function teamBadgeCount(providers) {
  const map = byKey(providers)
  const inline = MOBILE_APPROVAL_KEYS.reduce((sum, k) => sum + (map[k]?.count || 0), 0)
  const nav = Object.keys(TEAM_NAV_ROUTES).reduce((sum, k) => sum + (map[k]?.count || 0), 0)
  return inline + nav
}

// Tile badge = everything a decision-maker can see, both tabs.
export function approvalsBadgeCount(providers) {
  return customerBadgeCount(providers) + teamBadgeCount(providers)
}
