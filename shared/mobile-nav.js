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
  { key: 'studio',   label: 'Studio',    permKeys: ['studio_management'],          barEligible: true },
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
const LAYOUT_BASE = {
  owner:      { bar: ['schedule', 'studio'],             allowed: ['schedule', 'studio', 'whatsapp', 'pipeline', 'bookings'] },
  manager:    { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings'] },
  head_coach: { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'studio', 'bookings', 'pipeline'] },
  staff:      { bar: ['schedule'],                       allowed: ['schedule', 'bookings'] },
  master:     { bar: ['schedule', 'studio'],             allowed: ['schedule', 'studio', 'whatsapp', 'pipeline', 'bookings'] },
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
export function resolveMobileLayout({ role, employmentType, enabledKeys, override }) {
  const enabled = new Set(enabledKeys || [])
  const tmpl =
    (DEFAULT_MOBILE_LAYOUT[role] && (DEFAULT_MOBILE_LAYOUT[role][employmentType] || DEFAULT_MOBILE_LAYOUT[role].fte)) ||
    DEFAULT_MOBILE_LAYOUT.staff.fte

  const base = override && Array.isArray(override.bar) ? override : tmpl

  // Bar items are implicitly allowed; intersect with enabled + bar-eligible.
  const allowed = [...new Set([...(base.allowed || []), ...(base.bar || [])])]
    .filter(k => enabled.has(k) && BAR_ELIGIBLE_SET.has(k))
  const allowedSet = new Set(allowed)

  const bar = []
  for (const k of (base.bar || [])) {
    if (allowedSet.has(k) && !bar.includes(k)) bar.push(k)
    if (bar.length === 3) break
  }
  const barSet = new Set(bar)

  // Everything else enabled (incl. non-bar-eligible like tasks/radar),
  // ordered by the canonical registry order.
  const more = MOBILE_NAV_ORDER.filter(k => enabled.has(k) && !barSet.has(k))

  return { bar, more, allowed }
}
