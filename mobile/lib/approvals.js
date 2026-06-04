// Pure helpers for the mobile Approvals inbox. No React/Supabase — operates on
// the /api/approvals/pending `providers` array. Lives in mobile/lib so the root
// vitest picks it up (config includes mobile/lib/**).

// The approval categories the mobile inbox actions, in display order.
export const MOBILE_APPROVAL_KEYS = ['time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices']

function byKey(providers) {
  const map = {}
  for (const p of Array.isArray(providers) ? providers : []) {
    if (p && p.key) map[p.key] = p
  }
  return map
}

// The non-empty mobile-actionable provider sections, in MOBILE_APPROVAL_KEYS
// order. Each is the provider object ({ key, label, count, items }).
export function mobileApprovalSections(providers) {
  const map = byKey(providers)
  return MOBILE_APPROVAL_KEYS
    .map((k) => map[k])
    .filter((p) => p && Array.isArray(p.items) && p.items.length > 0)
}

// Badge total = pending items across the four mobile categories only.
export function approvalsBadgeCount(providers) {
  const map = byKey(providers)
  return MOBILE_APPROVAL_KEYS.reduce((sum, k) => sum + (map[k]?.count || 0), 0)
}
