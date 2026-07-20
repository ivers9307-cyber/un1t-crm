// INTEG-D2 — tiny display formatters shared by the /admin/tenants
// console components (TenantsConsole + TenantDetailView). Pure,
// presentation-only; money maths stays in cents everywhere else.

/** EUR cents → "€1,234.56"; null/undefined → "—". Sign preserved. */
export function euro(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return '—'
  const n = Number(cents) / 100
  const abs = Math.abs(n).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : ''}€${abs}`
}

/** Signed EUR cents for ledger rows: "+€10.00" / "-€2.50". */
export function euroSigned(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return '—'
  return `${Number(cents) > 0 ? '+' : ''}${euro(cents)}`
}

/** Compact integer: 12841 → "12,841"; null → "0". */
export function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-IE') : '0'
}

/** ISO timestamp/date → "12 Jul 2026"; falsy → "—". */
export function shortDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** ISO timestamp → "12 Jul, 14:03"; falsy → "—". */
export function shortDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// Ledger kind → label + light-theme chip recipe (bg-*-500/10 text-*-700
// per the contrast rule in CLAUDE.md).
export const LEDGER_KINDS = {
  topup: { label: 'Top-up', chip: 'bg-green-500/10 text-green-700' },
  draw: { label: 'Draw', chip: 'bg-blue-500/10 text-blue-700' },
  adjustment: { label: 'Adjustment', chip: 'bg-purple-500/10 text-purple-700' },
  expiry_reset: { label: 'Expiry reset', chip: 'bg-gray-500/10 text-gray-700' },
}

// Integrations hub status → chip recipe (mirrors the hub's status
// model: connected | action_needed | error | not_connected).
export const STATUS_CHIPS = {
  connected: 'bg-green-500/10 text-green-700',
  action_needed: 'bg-amber-500/10 text-amber-700',
  error: 'bg-red-500/10 text-red-700',
  not_connected: 'bg-gray-500/10 text-gray-700',
}
