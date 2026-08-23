// Mobile navigation model (MOBILE-LAYOUT.1).
//
// One source of truth for the navigable surfaces the iOS app can place in
// the bottom bar vs. the "More" drawer, the role × employment-type default
// layouts, and the pure resolver that combines them with the user's enabled
// feature set + their admin/per-person override.
//
// This is UI arrangement only — RLS is the security boundary (see the
// MOBILE-AUDIT.5 note in mobile/lib/permissions.js). Layout never grants
// access; it only decides where an already-enabled feature appears.

// Each navigable feature.
//   key:            the layout/nav key (also the (tabs) route name for tabs)
//   label:          shown in the StaffForm planner
//   permKeys:       OR-list of permission keys that enable it (canMobile keys)
//   employmentType: if set, only enabled for that employment_type
//   barEligible:    can it occupy a bottom-bar slot in Phase 1?
//                   (true == it is already an expo-router (tabs) route)
export const MOBILE_NAV_FEATURES = Object.freeze([
  { key: 'schedule', label: 'Schedule',  permKeys: ['schedule'],                   barEligible: true },
  { key: 'whatsapp', label: 'WhatsApp',  permKeys: ['whatsapp'],                   barEligible: true },
  // INBOX-SPLIT.M1 — email is its OWN surface, not a channel inside Messages,
  // exactly as on web (the unified inbox is WhatsApp + Instagram; email is
  // worked at /communications/tickets). Its permKey is the top-level
  // `email_inbox` — the same key the /api/email/tickets* routes enforce — so
  // the gate that places the tab is the gate that lets its calls through.
  { key: 'email',    label: 'Email',     permKeys: ['email_inbox'],                barEligible: true },
  // SONOSMOB.2 — device_control added: a user holding only live music
  // control still needs the Studio hub to reach /sonos.
  { key: 'studio',   label: 'Studio',    permKeys: ['studio_management', 'class_timer', 'tv_displays', 'device_control'], barEligible: true },
  { key: 'pipeline', label: 'Pipeline',  permKeys: ['pipeline'],                   barEligible: true },
  { key: 'bookings', label: 'Bookings',  permKeys: ['bookings'],                   barEligible: true },
  { key: 'invoices', label: 'Invoices',  permKeys: ['invoices'], employmentType: 'contractor', barEligible: true },
  { key: 'expenses', label: 'Expenses',  permKeys: ['expenses'], employmentType: 'fte',        barEligible: true },
  // More-only in Phase 1 (pushed routes outside the (tabs) group).
  { key: 'tasks',     label: 'Tasks',            permKeys: ['tasks'],                       barEligible: false },
  { key: 'radar',     label: 'Radar',            permKeys: ['churn_radar', 'lead_radar'],   barEligible: false },
  { key: 'issues',    label: 'Report a problem', permKeys: ['issues'],                      barEligible: false },
  { key: 'contracts', label: 'Contracts',        permKeys: ['contracts'],                   barEligible: false },
  { key: 'policies',  label: 'Policies',         permKeys: ['policies'],                    barEligible: false },
])

// Canonical key order — used to give the "More" list a stable, sensible
// order (mirrors today's More sections: ops → finance → insights → report
// → documents).
export const MOBILE_NAV_ORDER = Object.freeze(MOBILE_NAV_FEATURES.map(f => f.key))

export const BAR_ELIGIBLE = Object.freeze(
  MOBILE_NAV_FEATURES.filter(f => f.barEligible).map(f => f.key)
)

// Default templates, role × employment-type. Built DRY from a per-role base
// plus the employment-appropriate finance surface in `allowed` (invoices for
// contractors, expenses for FTE) — so the resolved layout differs by
// employment type without per-type hand-maintenance. Owners are intentionally
// lean (Schedule + Studio); every other role reproduces today's bar.
const FINANCE_KEY = { fte: 'expenses', contractor: 'invoices' }
//
// `email` is allowed (bar-placeable) for the three roles that hold
// `email_inbox` by default — master, manager, owner. head_coach and staff do
// not hold the key, so listing it for them would only ever be dead weight; if
// an operator grants it, the resolver still surfaces it in More, which is
// where every other granted-but-not-templated feature lands.
const LAYOUT_BASE = {
  owner:      { bar: ['schedule', 'studio'],             allowed: ['schedule', 'studio', 'whatsapp', 'email', 'pipeline', 'bookings'] },
  manager:    { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'email', 'studio', 'pipeline', 'bookings'] },
  head_coach: { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'studio', 'bookings', 'pipeline'] },
  staff:      { bar: ['schedule'],                       allowed: ['schedule', 'bookings'] },
  master:     { bar: ['schedule', 'studio'],             allowed: ['schedule', 'studio', 'whatsapp', 'email', 'pipeline', 'bookings'] },
}
function withFinance(base, employmentType) {
  return { bar: [...base.bar], allowed: [...base.allowed, FINANCE_KEY[employmentType]] }
}
export const DEFAULT_MOBILE_LAYOUT = Object.freeze(
  Object.fromEntries(
    Object.entries(LAYOUT_BASE).map(([role, base]) => [role, Object.freeze({
      fte: Object.freeze(withFinance(base, 'fte')),
      contractor: Object.freeze(withFinance(base, 'contractor')),
    })])
  )
)

const BAR_ELIGIBLE_SET = new Set(BAR_ELIGIBLE)

/**
 * Resolve the effective mobile layout for a user at a location.
 * Pure — no IO. UI arrangement only.
 *
 * @param {object} args
 * @param {string} args.role            profile.role (active-location role)
 * @param {string|null} args.employmentType  'fte' | 'contractor' | null
 * @param {string[]} args.enabledKeys   nav keys the user passes Layer-1 for
 * @param {{bar?:string[], allowed?:string[]}|null} args.override  permissions.mobile.layout
 * @returns {{ bar: string[], more: string[], allowed: string[] }}
 */
export function resolveMobileLayout({ role, employmentType, enabledKeys, override, staffBar }) {
  const enabled = new Set(enabledKeys || [])
  const tmpl =
    (DEFAULT_MOBILE_LAYOUT[role] && (DEFAULT_MOBILE_LAYOUT[role][employmentType] || DEFAULT_MOBILE_LAYOUT[role].fte)) ||
    DEFAULT_MOBILE_LAYOUT.staff.fte

  const base = override && Array.isArray(override.bar) ? override : tmpl

  // `allowed` always comes from the ADMIN layer (override/template) — never from
  // the staff arrangement. Bar items are implicitly allowed.
  const allowed = [...new Set([...(base.allowed || []), ...(base.bar || [])])]
    .filter(k => enabled.has(k) && BAR_ELIGIBLE_SET.has(k))
  const allowedSet = new Set(allowed)

  // Bar SOURCE: the staff member's own arrangement when set, else the admin
  // default. Either way it's clamped to allowed ∩ enabled and capped at 3.
  const barSource = (Array.isArray(staffBar) && staffBar.length) ? staffBar : (base.bar || [])
  const bar = []
  for (const k of barSource) {
    if (allowedSet.has(k) && !bar.includes(k)) bar.push(k)
    if (bar.length === 3) break
  }
  const barSet = new Set(bar)

  const more = MOBILE_NAV_ORDER.filter(k => enabled.has(k) && !barSet.has(k))

  return { bar, more, allowed }
}
