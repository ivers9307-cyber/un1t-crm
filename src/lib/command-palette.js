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
  // HUBS.2f — relabelled "Messages" to match the sidebar's collapsed entry
  // (nav-items.js), and email_inbox folded into the OR for the same reason
  // as the sidebar's: an accounts@/sales@-only user (email_inbox only)
  // still needs to find this command. The email-tickets entry below stays
  // separate — its own deep link into the ticket queue tab.
  { id: 'communications', label: 'Messages', href: '/communications', anyPermission: ['email', 'whatsapp', 'sms', 'email_inbox'] },
  // EMAIL-TICKET.4 — the studio email queue. `email_inbox`, not the
  // marketing `email` key (different population of people). INBOX-SPLIT.1
  // relabelled it "Email"; COMMS-IA.3 relabels it again to "Email inbox" so a
  // palette search for "inbox" finds it and it is not confused with sending.
  // The id, href and permission are unchanged.
  { id: 'email-tickets', label: 'Email inbox', href: '/communications/tickets', permission: 'email_inbox' },
  { id: 'schedule', label: 'Schedule', href: '/schedule', permission: 'schedule' },
  { id: 'events', label: 'Events', href: '/events', permission: 'races' },
  // EQUIP-MAINT.1 — mirrors the nav-items.js Sidebar entry's gate.
  { id: 'maintenance', label: 'Maintenance', href: '/maintenance', anyPermission: ['equipment_admin', 'equipment_inspect'] },
  // SEC-PALETTE-OPS.1 — the Operations hub (nav-items.js) collapsed these
  // four into one sidebar entry with a looser anyPermission union; the
  // palette wants individual jump targets, so each is gated on the SAME
  // permission its own destination page checks, not the hub's union.
  { id: 'studio-management', label: 'Studio Management', href: '/studio-management', permission: 'studio_management' },
  { id: 'tv-displays', label: 'TV Displays', href: '/tv-displays', permission: 'tv_displays' },
  { id: 'presentations', label: 'Presentations', href: '/presentations', permission: 'presentations' },
  // Checklists has no permission of its own — src/app/(operations)/checklists/page.js
  // gates on studio_management (shared with the Studio tab; see the
  // Operations hub's ALL_NAV entry comment in nav-items.js).
  { id: 'checklists', label: 'Checklists', href: '/checklists', permission: 'studio_management' },
  // K5 — /cars is a redirect-only stub to /cars/active. Same wasted hop as
  // the broadcast entry below; the palette is the fast path, so it lands on
  // the page that actually renders.
  { id: 'cars', label: 'Car Processing', href: '/cars/active', permission: 'car_processing' },
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
  // K5 — was /whatsapp/broadcasts/new, retired by PILLAR2 Phase 1b and kept
  // only as a redirect here. The same href as 'send-message' is deliberate,
  // not a leftover: the unified composer IS where a WhatsApp broadcast is
  // written now, and operators still search the palette for "whatsapp" and
  // "broadcast". Two labels onto one destination is the cheapest way to keep
  // those words findable. (Recents dedupe by href, so this cannot double up
  // there.) If /communications/send ever takes a channel preselect, this is
  // the entry that should pass it.
  { id: 'new-broadcast', label: 'New WhatsApp broadcast', href: '/communications/send', permission: 'whatsapp' },
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

// AUDIT-13.G — a LAUNCHER_ENTITIES constant used to sit here, listing the
// entity/permission pairs "the search endpoint" gates on. Nothing ever
// imported it: src/app/api/launcher/search/route.js writes the three
// hasPermission() calls inline. It was born unused and was therefore a
// drift hazard rather than documentation — adding an entity to the list
// did nothing, while reading it told you the wiring was data-driven when
// it is not. Deleted; the route is the single source of truth.

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
      // K5 — `/events/<id>` was a hard 404, not a redirect: there is no
      // src/app/events/[id]/page.js, only the checkin/control/edit/teams
      // sub-routes. Every event picked out of the launcher landed on
      // not-found. `/teams` is the entrants view and the first link the
      // Events list itself offers per event, so it is the "open this event"
      // target the palette was reaching for.
      return { type, key: `event:${row.id}`, label: row.name || 'Event', sublabel: row.sublabel || '', href: `/events/${row.id}/teams` }
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
