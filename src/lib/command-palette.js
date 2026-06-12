// CMD-K.1 — pure logic for the global ⌘K command palette. Kept out of
// the .jsx shell so it's unit-testable in the Node test env (no DOM),
// mirroring the components/ui/styles.js convention.

// SIDEBAR-IA.1 — the Dashboard entry's permission keys (3 dashboard
// sub-views + the 2 radars, which are dashboard tabs now) are shared
// with the Sidebar via nav-items.js so the two gates can't drift.
import { DASHBOARD_LINK_PERM_KEYS } from './nav-items'

// Curated jump destinations. Deliberately a hand-maintained subset of
// the Sidebar nav rather than an import of `ALL_NAV` — the palette wants
// flat label+href+permission tuples, not the sidebar's icon/section/
// children structure. When a top-level destination is added to the
// sidebar and is worth jumping to, add it here too.
export const NAV_COMMANDS = [
  { id: 'dashboard', label: 'Dashboard', href: '/dashboard', dashboardGroup: true },
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline', permission: 'pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts', permission: 'contacts' },
  { id: 'tasks', label: 'Tasks', href: '/activities', permission: 'activities' },
  // SIDEBAR-IA.1 — radars live under the dashboard tab strip; the old
  // standalone URLs are forever-aliased in next.config redirects.
  { id: 'churn-radar', label: 'Churn Radar', href: '/dashboard/churn-radar', permission: 'churn_radar' },
  { id: 'lead-radar', label: 'Lead Radar', href: '/dashboard/lead-radar', permission: 'lead_radar' },
  { id: 'bookings', label: 'Bookings', href: '/bookings', anyPermission: ['events', 'bookings'] },
  { id: 'communications', label: 'Communications', href: '/communications', anyPermission: ['email', 'whatsapp'] },
  { id: 'schedule', label: 'Schedule', href: '/schedule', permission: 'schedule' },
  { id: 'events', label: 'Events', href: '/events', permission: 'races' },
  { id: 'cars', label: 'Car Processing', href: '/cars', permission: 'car_processing' },
  { id: 'orders', label: 'Orders', href: '/orders', permission: 'orders' },
  { id: 'invoices', label: 'Invoices', href: '/invoices', permission: 'invoices_inbox' },
  { id: 'approvals', label: 'Approvals', href: '/approvals', permission: 'approvals_inbox' },
  { id: 'issues', label: 'Issues', href: '/issues', permission: 'issues_inbox' },
  { id: 'settings', label: 'Settings', href: '/settings', permission: 'settings' },
]

// Quick-create actions. v1 ships only the destinations that have a clean
// standalone create flow — `/contacts/new`. Deals come from Glofox sync +
// the classifier (no manual-create UI), and task create lives in the
// /activities modal (contact-scoped) — both deferred rather than wiring
// a half-flow here. Jump-to-contact + PersonActionBar cover those.
export const CREATE_COMMANDS = [
  { id: 'new-contact', label: 'New contact', href: '/contacts/new', permission: 'contacts' },
]

/**
 * Is a command visible to this user? `hasPerm` is a `(key) => boolean`
 * predicate the caller supplies (so this module stays free of the
 * permissions/user coupling). Mirrors the Sidebar `matches()` gates.
 */
export function commandAllowed(cmd, hasPerm) {
  if (!cmd) return false
  if (cmd.always) return true
  if (cmd.dashboardGroup) return DASHBOARD_LINK_PERM_KEYS.some((k) => !!hasPerm(k))
  if (cmd.anyPermission) return cmd.anyPermission.some((k) => !!hasPerm(k))
  if (cmd.permission) return !!hasPerm(cmd.permission)
  return true
}

/** Case-insensitive substring match of the query against a label. */
export function matchesQuery(label, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  return String(label || '').toLowerCase().includes(q)
}

/** Permission-gate + query-filter a static command list. */
export function visibleCommands(commands, query, hasPerm) {
  return (commands || []).filter((c) => commandAllowed(c, hasPerm) && matchesQuery(c.label, query))
}

/**
 * Strip characters that would break a PostgREST `.or(...)` ilike filter:
 * commas separate the OR clauses, parens group them, and `% _ *` are
 * wildcards we don't want a user smuggling into the pattern. Collapses
 * whitespace. Returns '' for unusable input.
 */
export function sanitizeSearchTerm(term) {
  return String(term || '')
    .replace(/[,()%*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Minimum sanitized length before we hit the DB for contact search. */
export const MIN_CONTACT_SEARCH_LEN = 2
