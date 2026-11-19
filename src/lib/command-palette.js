// CMD-K.1 — pure logic for the global ⌘K command palette. Kept out of
// the .jsx shell so it's unit-testable in the Node test env (no DOM),
// mirroring the components/ui/styles.js convention.

// SIDEBAR-IA.1 — the Dashboard entry's permission keys (3 dashboard
// sub-views + the 2 radars, which are dashboard tabs now) are shared
// with the Sidebar via nav-items.js so the two gates can't drift.
import { DASHBOARD_LINK_PERM_KEYS } from './nav-items'
// PALETTE.1 — the palette also offers every hub tab and every settings
// row as a jump target, generated from the same data the tab strips, the
// hub index redirects and the /settings index render from.
import { HUB_TABS } from './hub-tabs'
import { HUB_INDEX_CHAINS } from './hub-index-chains'
import { SETTINGS_TREE } from './settings-tree'
import { isActiveOrgAdmin } from './org-admin'
import { MANAGER_ROLES } from './schemas'

// Curated jump destinations. A hand-maintained list of the top-level
// destinations, kept for their labels and ids (recents and tests key on
// them). PALETTE.1: it is no longer the whole list — JUMP_COMMANDS below
// adds every hub tab and every /settings row, generated from their own data,
// and a curated entry here wins over a generated one with the same href.
// A curated entry's gate must equal the generated one's for that href
// (command-palette.test.js), so curating a label never loosens a gate.
export const NAV_COMMANDS = [
  { id: 'dashboard', label: 'Dashboard', href: '/dashboard', dashboardGroup: true },
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline', permission: 'pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts', permission: 'contacts' },
  { id: 'tasks', label: 'Tasks', href: '/activities', permission: 'activities' },
  // SIDEBAR-IA.1 — radars live under the dashboard tab strip; the old
  // standalone URLs are forever-aliased in next.config redirects.
  { id: 'churn-radar', label: 'Churn Radar', href: '/dashboard/churn-radar', permission: 'churn_radar' },
  // PALETTE.1 — was anyPermission ['events', 'bookings'], but /bookings gates
  // on `bookings` alone (hub-index-chains.js: `events` reaches no surface),
  // so an events-only holder was offered a page that bounced them.
  { id: 'bookings', label: 'Bookings', href: '/bookings', permission: 'bookings' },
  // HUBS.2f — relabelled "Messages" to match the sidebar's collapsed entry
  // (nav-items.js), and email_inbox folded into the OR for the same reason
  // as the sidebar's: an accounts@/sales@-only user (email_inbox only)
  // still needs to find this command. The email-mail entry below stays
  // separate — its own deep link into the conversation queue tab.
  { id: 'communications', label: 'Messages', href: '/communications', anyPermission: ['email', 'whatsapp', 'email_inbox'] },
  // EMAIL-TICKET.4 — the studio email surface. `email_inbox`, not the
  // marketing `email` key (different population of people). INBOX-SPLIT.1
  // relabelled it "Email"; COMMS-IA.3 relabels it again to "Email inbox" so a
  // palette search for "inbox" finds it and it is not confused with sending.
  // The id, href and permission are unchanged.
  { id: 'email-mail', label: 'Mail', href: '/communications/mail', permission: 'email_inbox' },
  // PALETTE.1 — the Messages hub's other tab ((hub)/inbox/page.js gates on
  // `whatsapp`). Curated because that strip is a client component with no
  // data list to generate from.
  { id: 'inbox', label: 'WhatsApp & Instagram inbox', href: '/communications/inbox', permission: 'whatsapp' },
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
  // PALETTE.1 — role floor added: (money)/orders/page.js also requires
  // MANAGER_ROLES (the Money strip and hub-index-chains.js carry the same).
  { id: 'orders', label: 'Orders', href: '/orders', permission: 'orders', roles: MANAGER_ROLES },
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
  { id: 'send-message', label: 'Send a message', href: '/communications/send', anyPermission: ['email', 'whatsapp'] },
  // K5 — was /whatsapp/broadcasts/new, retired by PILLAR2 Phase 1b and kept
  // only as a redirect here. The same href as 'send-message' is deliberate,
  // not a leftover: the unified composer IS where a WhatsApp broadcast is
  // written now, and operators still search the palette for "whatsapp" and
  // "broadcast". Two labels onto one destination is the cheapest way to keep
  // those words findable. (Recents dedupe by href, so this cannot double up
  // there.) If /communications/send ever takes a channel preselect, this is
  // the entry that should pass it.
  { id: 'new-broadcast', label: 'New WhatsApp broadcast', href: '/communications/send', permission: 'whatsapp' },
  // QUICKEMAIL-RETIRE.1 — email moved out of /communications/send to the full editor.
  { id: 'new-email', label: 'New email', href: '/communications/new-email', permission: 'email' },
  { id: 'new-event', label: 'New event', href: '/events/new', permission: 'races' },
  // PALETTE.1 — the /settings index's Add Location button. The page gates on
  // `user.role === 'master'` (the active role, not profileRole), so roles.
  { id: 'new-location', label: 'New location', href: '/settings/locations/new', roles: ['master'] },
]

// PALETTE.1 — a generated label where the tab's own label means nothing out
// of its strip (the Money hub's first tab says only "Overview").
const LABEL_OVERRIDES = Object.freeze({
  '/accounting': 'Accounting overview',
})

// PALETTE.1 — words people type that are not in a page's label. Keyed by
// href so a curated and a generated entry for the same page share them.
// Matching is per word (matchesQuery), so 'whatsapp numbers' needs both.
export const PALETTE_KEYWORDS = Object.freeze({
  '/settings': ['preferences', 'config', 'configuration'],
  '/settings/holidays': ['holidays', 'bank holidays', 'public holidays', 'closures'],
  '/settings/class-categories': ['classes', 'cardio', 'strength', 'conditioning'],
  '/settings/pipelines': ['boards', 'offers', 'funnel'],
  '/settings/promos': ['corporate', 'corp', 'partner', 'free classes'],
  '/settings/offers': ['offers', 'sale', 'pack', 'gift card', 'black friday'],
  '/settings/hosts': ['stripe', 'organisers', 'connect'],
  '/achievements': ['badges'],
  '/settings/service-credentials': ['strava', 'garmin', 'apple health', 'credentials'],
  '/settings/staff': ['staff', 'team', 'employees', 'users', 'people', 'coaches'],
  '/settings/staff/new': ['staff', 'invite', 'new staff', 'add user', 'hire'],
  '/settings/impersonate': ['impersonate', 'view as', 'sign in as'],
  '/settings/email-domain': ['email', 'dns', 'dkim', 'sending domain'],
  '/settings/notifications': ['push', 'alerts', 'reminders'],
  '/settings/customer-agent': ['mia', 'ai', 'bot', 'agent', 'instagram', 'whatsapp'],
  '/settings/scoring': ['points', 'heart rate', 'zones'],
  '/settings/integrations-hub': ['integrations', 'connections', 'glofox', 'xero', 'whatsapp numbers', 'instagram', 'meta', 'zoom', 'integration health'],
  '/settings/status-page': ['status', 'outage'],
  '/admin/webhook-dead-letter': ['webhooks', 'dead letters', 'failed deliveries', 'postmark'],
  '/settings/billing': ['plan', 'subscription', 'wallet', 'platform invoices'],
  '/settings/usage': ['caps', 'limits', 'ai usage'],
  '/settings/glofox-import': ['glofox', 'import', 'members'],
  '/settings/marketing-import': ['consent', 'import', 'marketing preferences'],
  '/settings/api-keys': ['api', 'api keys', 'tokens', 'developer', 'integration key'],
  '/settings/landing-page': ['website', 'pages', 'landing', 'welcome'],
  '/settings/audit-log': ['audit', 'logs', 'history'],
  '/account/access-history': ['impersonation', 'audit', 'access'],
  '/settings/locations/new': ['studio', 'location', 'add location'],
  '/schedule': ['rota', 'roster', 'shifts', 'hours', 'payroll'],
  '/schedule/invoices': ['payroll', 'contractor', 'pay'],
  '/schedule/expenses': ['payroll', 'expenses', 'reimbursement'],
  '/contracts': ['employment', 'hr'],
  '/policies': ['hr', 'handbook'],
  '/accounting': ['xero', 'bookkeeping', 'finance', 'accounts'],
  '/card-receipts': ['receipts', 'company card', 'expenses'],
  '/offer-sales': ['offers', 'sales'],
  '/class-fees': ['late cancel', 'no show', 'fees'],
  '/communications/inbox': ['whatsapp', 'instagram', 'dm', 'chat'],
  '/communications/sent': ['campaigns', 'broadcasts', 'history'],
  '/communications/templates': ['email templates', 'whatsapp templates'],
  '/communications/segments': ['audiences', 'lists'],
  '/communications/list-health': ['bounces', 'unsubscribes', 'deliverability'],
  '/automations': ['sequences', 'drips', 'flows', 'sonos', 'music'],
  '/admin/fleet': ['devices', 'tablets', 'restart'],
  '/live': ['heart rate', 'hr'],
  '/pulse': ['survey', 'feedback'],
})

// The hub-index chain step whose target is `href`, if any. The chain is the
// module that guarantees a step's keys/roles match its destination's own
// gate (hub-index-chains.js header), so a tab's gate is read from there
// first and from the tab only where no chain step points at it.
function chainStepFor(href) {
  for (const hub of Object.values(HUB_INDEX_CHAINS)) {
    const step = hub.chain.find((s) => s.target === href)
    if (step) return step
  }
  return null
}

function hubTabCommand(hubHref, section, tab) {
  const step = chainStepFor(tab.href)
  const keys = step ? step.keys : tab.perms
  const roles = step ? step.roles : tab.roles
  return {
    id: `hub:${hubHref.slice(1)}:${tab.id}`,
    label: LABEL_OVERRIDES[tab.href] || tab.label,
    href: tab.href,
    section,
    ...(keys ? { anyPermission: [...keys] } : { openToAll: true }),
    ...(roles ? { roles: [...roles] } : {}),
  }
}

function settingsRowCommand(group, row) {
  // The row's gate verbatim (settings-tree.js vocabulary, one field per
  // row), which commandAllowed evaluates exactly as settingsRowVisible does.
  return {
    id: `settings:${row.id}`,
    label: row.label,
    href: row.href,
    section: 'Settings',
    group: group.label,
    ...row.gate,
  }
}

/**
 * Every generated jump destination: each hub tab (bar the one that opens
 * the public site in a new tab) and each /settings row that has a page.
 * Pure; no dedupe (buildJumpCommands does that).
 */
export function generatedJumpCommands() {
  const out = []
  for (const [hubHref, hub] of Object.entries(HUB_TABS)) {
    for (const tab of hub.tabs) {
      if (tab.newTab) continue
      out.push(hubTabCommand(hubHref, hub.section, tab))
    }
  }
  for (const group of SETTINGS_TREE) {
    for (const row of group.rows) {
      if (!row.href) continue // "coming soon" rows have no page
      out.push(settingsRowCommand(group, row))
    }
  }
  return out
}

/**
 * Curated first, then every generated destination whose href is not already
 * a curated jump or a quick-create (the Marketing strip's `Send` is the
 * 'Send a message' create action). Curated entries keep their label and
 * gate and borrow the generated entry's section; all pick up PALETTE_KEYWORDS.
 */
export function buildJumpCommands(curated = NAV_COMMANDS, generated = generatedJumpCommands(), creates = CREATE_COMMANDS) {
  const byHref = new Map()
  for (const g of generated) if (!byHref.has(g.href)) byHref.set(g.href, g)
  const taken = new Set([...curated, ...creates].map((c) => c.href))
  const withKeywords = (c) => (PALETTE_KEYWORDS[c.href] ? { ...c, keywords: PALETTE_KEYWORDS[c.href] } : c)
  const curatedOut = curated.map((c) => {
    const g = byHref.get(c.href)
    return withKeywords(g && !c.section ? { ...c, section: g.section, ...(g.group ? { group: g.group } : {}) } : c)
  })
  const seen = new Set()
  const generatedOut = []
  for (const g of generated) {
    if (taken.has(g.href) || seen.has(g.href)) continue
    seen.add(g.href)
    generatedOut.push(withKeywords(g))
  }
  return [...curatedOut, ...generatedOut]
}

/** What the palette offers under "Go to": curated + generated, deduped by href. */
export const JUMP_COMMANDS = buildJumpCommands()

/**
 * Is a command visible to this user? `hasPerm` is a `(key) => boolean`
 * predicate the caller supplies (so this module stays free of the
 * permissions/user coupling). Mirrors the Sidebar `matches()` gates.
 *
 * PALETTE.1 — `user` (the getCurrentUser() object the palette is handed)
 * answers the role-shaped gates a permission predicate cannot:
 *   roles       — user.role (the ACTIVE-LOCATION role, the field every
 *                 role-gated page reads) is one of these
 *   masterOnly  — user.profileRole or user.role is 'master' (the
 *                 settings-tree and Sidebar formula)
 *   orgAdmin    — isActiveOrgAdmin(user) (src/lib/org-admin.js)
 *   openToAll   — any signed-in user
 * Every gate a command carries must pass (AND), and each of these FAILS
 * CLOSED: with no user, or no role on it, the command is hidden rather
 * than offered as a link its page would bounce.
 */
export function commandAllowed(cmd, hasPerm, user = null) {
  if (!cmd) return false
  if (cmd.roles && (typeof user?.role !== 'string' || !cmd.roles.includes(user.role))) return false
  if (cmd.masterOnly && !(user?.profileRole === 'master' || user?.role === 'master')) return false
  if (cmd.orgAdmin && !(user && isActiveOrgAdmin(user))) return false
  if (cmd.openToAll && !user) return false
  if (cmd.always) return true
  if (cmd.dashboardGroup) return DASHBOARD_LINK_PERM_KEYS.some((k) => !!hasPerm(k))
  if (cmd.anyPermission) return cmd.anyPermission.some((k) => !!hasPerm(k))
  if (cmd.permission) return !!hasPerm(cmd.permission)
  return true
}

/** The text a command is searched by: label, section, `Section › Label`, group, keywords. */
function searchFields(target) {
  if (target == null || typeof target !== 'object') return [String(target ?? '')]
  const fields = [target.label || '']
  if (target.section) fields.push(target.section, `${target.section} › ${target.label || ''}`)
  if (target.group) fields.push(target.group)
  if (Array.isArray(target.keywords)) fields.push(...target.keywords)
  return fields
}

/**
 * Case-insensitive match of the query against a label (a string) or a
 * command (label, section, group and keywords). PALETTE.1: matched per
 * word, each word a substring of one of those fields, so "api keys",
 * "settings holidays" and "Settings › Bank" all find their page. A
 * one-word query against a label is the old substring match.
 */
export function matchesQuery(target, query) {
  const words = String(query || '').toLowerCase().split(/[\s›>]+/).filter(Boolean)
  if (!words.length) return true
  const fields = searchFields(target).map((f) => String(f).toLowerCase())
  return words.every((w) => fields.some((f) => f.includes(w)))
}

/** Permission-gate + query-filter a static command list. */
export function visibleCommands(commands, query, hasPerm, user = null) {
  return (commands || []).filter((c) => commandAllowed(c, hasPerm, user) && matchesQuery(c, query))
}

/** The line under a jump result: `Settings › Security`, `Money`, or ''. */
export function commandSublabel(cmd) {
  if (!cmd?.section) return ''
  return cmd.group ? `${cmd.section} › ${cmd.group}` : cmd.section
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
