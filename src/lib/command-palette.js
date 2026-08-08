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
  { id: 'communications', label: 'Communications', href: '/communications', anyPermission: ['email', 'whatsapp', 'sms'] },
  // EMAIL-TICKET.4 — the studio email queue. `email_inbox`, not the
  // marketing `email` key (different population of people). INBOX-SPLIT.1
  // relabelled it "Email" (the only place email is worked now); the id,
  // href and permission are unchanged.
  { id: 'email-tickets', label: 'Email', href: '/communications/tickets', permission: 'email_inbox' },
  { id: 'schedule', label: 'Schedule', href: '/schedule', permission: 'schedule' },
  { id: 'events', label: 'Events', href: '/events', permission: 'races' },
  // EQUIP-MAINT.1 — mirrors the nav-items.js Sidebar entry's gate.
  { id: 'maintenance', label: 'Maintenance', href: '/maintenance', anyPermission: ['equipment_admin', 'equipment_inspect'] },
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
  // FEAT-LAUNCH.1 — quick actions beyond new-contact. All are real standalone
  // destinations (verified routes), permission-gated like the nav commands.
  { id: 'send-message', label: 'Send a message', href: '/communications/send', anyPermission: ['email', 'whatsapp', 'sms'] },
  { id: 'new-broadcast', label: 'New WhatsApp broadcast', href: '/whatsapp/broadcasts/new', permission: 'whatsapp' },
  { id: 'new-event', label: 'New event', href: '/events/new', permission: 'races' },
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

/** Minimum sanitized length before we hit the DB for entity search. */
export const MIN_CONTACT_SEARCH_LEN = 2

// FEAT-LAUNCH.2 — multi-entity search. Beyond contacts, the launcher searches
// staff and events (both have a real deep-link target and a clear permission
// gate). Invoices are intentionally excluded until there's an /invoices/[id]
// detail route to land on. Per-entity cap keeps the palette scannable.
export const LAUNCHER_RESULT_CAP = 5

// Which permission gates each entity in the search endpoint. Staff live under
// the settings-gated admin area; events use the same 'races' key as the page.
export const LAUNCHER_ENTITIES = [
  { type: 'contact', permission: 'contacts' },
  { type: 'staff', permission: 'settings' },
  { type: 'event', permission: 'races' },
]

/**
 * Shape one DB row into a launcher result. Pure — the route selects the
 * columns and calls this so href/label derivation has a single source of
 * truth (and is unit-testable without a DB).
 */
export function entityResult(type, row) {
  if (!row?.id) return null
  switch (type) {
    case 'contact':
      return { type, key: `contact:${row.id}`, label: row.name || row.email || 'Contact', sublabel: row.email || row.phone || '', href: `/contacts/${row.id}` }
    case 'staff':
      return { type, key: `staff:${row.id}`, label: row.full_name || row.email || 'Staff', sublabel: row.email || '', href: `/settings/staff/${row.id}` }
    case 'event':
      return { type, key: `event:${row.id}`, label: row.name || 'Event', sublabel: row.sublabel || '', href: `/events/${row.id}` }
    default:
      return null
  }
}

// FEAT-LAUNCH.1 — recents. Track the last few destinations the operator jumped
// to from the palette so they can return in two keystrokes. Pure list-mgmt
// (dedup-by-href, most-recent-first, capped); the .jsx owns localStorage I/O.
export const RECENTS_CAP = 6

export function addRecent(recents, item) {
  if (!item?.href) return Array.isArray(recents) ? recents : []
  const rest = (Array.isArray(recents) ? recents : []).filter((r) => r && r.href !== item.href)
  return [{ label: item.label, href: item.href, type: item.type || 'go' }, ...rest].slice(0, RECENTS_CAP)
}

// Keep only well-formed recents (defends against corrupt/legacy localStorage).
export function sanitizeRecents(recents) {
  return (Array.isArray(recents) ? recents : [])
    .filter((r) => r && typeof r.href === 'string' && r.href.startsWith('/') && typeof r.label === 'string')
    .slice(0, RECENTS_CAP)
}
