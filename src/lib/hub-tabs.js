// PALETTE.1 — every hub's tab strip, as data.
//
// These arrays used to live inline in each hub layout
// (src/app/(sales|members|money|marketing|team|operations)/layout.js and
// src/app/communications/(marketing-era)/layout.js). They moved here,
// unchanged, so the ⌘K command palette (src/lib/command-palette.js) can
// offer every tab as a jump target from the SAME list the strips render
// from: a tab added to a hub is a palette destination on the same commit,
// and command-palette.test.js fails if one is not.
//
// Each layout still filters and renders exactly as before; this module is
// pure data (no permissions import), safe for the client palette.
//
// Tab shape: { id, label, href, perms?, roles?, newTab?, badgeUrl? }
//   perms  — the tab shows when the user holds ANY of these keys
//            (hasPermission at the active studio). Absent = signed-in only.
//   roles  — the tab also needs one of these ACTIVE-LOCATION roles
//            (user.role), the role floor its destination page enforces.
// Where a tab's href is a step target in src/lib/hub-index-chains.js the
// tab's perms/roles must equal that step's keys/roles: the chain is the
// module that guarantees "matches the destination's own gate", and
// command-palette.test.js pins the two together.

import { CHALLENGE_ADMIN_ROLES } from './challenges-access'
import { MANAGER_ROLES } from './schemas'

export const SALES_TABS = Object.freeze([
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline',   perms: ['pipeline'] },
  { id: 'contacts', label: 'Contacts', href: '/contacts',   perms: ['contacts'] },
  { id: 'tasks',    label: 'Tasks',    href: '/activities', perms: ['activities'] },
])

export const MEMBERS_TABS = Object.freeze([
  { id: 'bookings',   label: 'Bookings',    href: '/bookings',                perms: ['bookings'] },
  { id: 'events',     label: 'Events',      href: '/events',                  perms: ['races'] },
  // HUBDOOR.2 — `roles` is the destination's role floor. /challenges gates
  // on MANAGER_ROLES as well as the key (canAdminChallenges), so offering
  // the tab on the key alone showed a staff-role holder of `challenges` a
  // tab that bounced them. A tab with no `roles` has no floor.
  { id: 'challenges', label: 'Challenges',  href: '/challenges',              perms: ['challenges'], roles: CHALLENGE_ADMIN_ROLES },
  { id: 'pulse',      label: 'Pulse',       href: '/pulse',                   perms: ['pulse_admin'] },
  // UN1TBOOK.11 — class_roster alone opens /live (who's coming, no door).
  { id: 'live',       label: 'Live class',  href: '/live',                    perms: ['studio_management', 'class_roster'] },
  { id: 'timer',      label: 'Class timer', href: '/studio-management/timer', perms: ['class_timer'] },
  { id: 'hyrox',      label: 'Hyrox',       href: '/hyrox',                   perms: ['approvals_hyrox_sessions'] },
])

export const MONEY_TABS = Object.freeze([
  { id: 'overview', label: 'Overview',      href: '/accounting',    perms: ['accounting_hub'] },
  { id: 'invoices', label: 'Invoices',      href: '/invoices',      perms: ['invoices_inbox'], badgeUrl: '/api/invoices-inbox/unread-count' },
  { id: 'receipts', label: 'Card receipts', href: '/card-receipts', perms: ['card_receipts'] },
  // HUBDOOR.4 — same floor HUBDOOR.2 gave Challenges in the Members strip:
  // /orders gates on MANAGER_ROLES AND the key, so a staff/reception holder of
  // `orders` alone was shown a tab that bounced them.
  { id: 'orders',   label: 'Orders',        href: '/orders',        perms: ['orders'], roles: MANAGER_ROLES },
  { id: 'offers',   label: 'Offer sales',   href: '/offer-sales',   perms: ['approvals_offer_purchases'] },
  { id: 'class-fees', label: 'Class fees',  href: '/class-fees',    perms: ['class_fees'] },
  // DEEP.4 Task 1 (4A) — the two reviewer tabs: pages in the (team) route
  // group, reached only through this hub's strip.
  { id: 'contractor-invoices', label: 'Contractor invoices', href: '/schedule/invoices', perms: ['approvals_contractor_invoices'] },
  { id: 'expenses',            label: 'Staff expenses',      href: '/schedule/expenses', perms: ['approvals_fte_expenses'] },
])

// The campaign-lifecycle pages. Rendered twice: as the tail of the
// Marketing hub's strip and as the whole strip of
// src/app/communications/(marketing-era)/layout.js (one list, so the two
// strips cannot drift).
export const MARKETING_SEND_TABS = Object.freeze([
  { id: 'send',        label: 'Send',        href: '/communications/send',        perms: ['email', 'whatsapp'] },
  { id: 'sent',        label: 'Sent',        href: '/communications/sent',        perms: ['email', 'whatsapp'] },
  { id: 'templates',   label: 'Templates',   href: '/communications/templates',   perms: ['email', 'whatsapp'] },
  { id: 'segments',    label: 'Segments',    href: '/communications/segments',    perms: ['email', 'whatsapp'], roles: MANAGER_ROLES },
  { id: 'list-health', label: 'List health', href: '/communications/list-health', perms: ['email'] },
])

export const MARKETING_TABS = Object.freeze([
  // device_control is in this union for the same reason it's in the
  // sidebar entry's anyPermission (review fix, HUBS.2f) — the
  // Automations page's Studio music (Sonos) section (canDevices) gates
  // on it alone, so a device_control-only holder needs the tab to show too.
  { id: 'automations', label: 'Automations',  href: '/automations', perms: ['automations', 'email', 'whatsapp', 'device_control'] },
  // The PUBLIC marketing site, opened in a new tab. Not an in-app page, so
  // the palette skips it (the editor is the settings tree's Landing pages row).
  { id: 'landing',     label: 'Landing page', href: '/welcome',     perms: ['landing_page'], newTab: true },
  ...MARKETING_SEND_TABS,
])

export const TEAM_TABS = Object.freeze([
  { id: 'schedule',  label: 'Schedule',  href: '/schedule',  perms: ['schedule'] },
  { id: 'contracts', label: 'Contracts', href: '/contracts', perms: ['contracts'] },
  // No perms — /policies is login-gated only, so the tab shows for every
  // signed-in user (mirrors the page's own gate, same rule as always).
  { id: 'policies',  label: 'Policies',  href: '/policies' },
])

export const OPERATIONS_TABS = Object.freeze([
  { id: 'maintenance',   label: 'Maintenance',   href: '/maintenance',       perms: ['equipment_admin', 'equipment_inspect'] },
  { id: 'studio',        label: 'Studio',        href: '/studio-management', perms: ['studio_management'] },
  { id: 'tv',            label: 'TV displays',   href: '/tv-displays',       perms: ['tv_displays'] },
  { id: 'presentations', label: 'Presentations', href: '/presentations',     perms: ['presentations'] },
  // No key of its own: (operations)/checklists/page.js gates on studio_management.
  { id: 'checklists',    label: 'Checklists',    href: '/checklists',        perms: ['studio_management'] },
  // ADMIN.2h Task 2 — href is OUTSIDE the (operations) group (see that
  // layout's header comment): arriving here renders no strip, same as
  // (members)'s `live`. src/app/admin/layout.js admits both keys.
  { id: 'fleet',         label: 'Fleet',         href: '/admin/fleet',       perms: ['fleet_restart', 'fleet_admin'] },
])

// Hub href → its section name (as the sidebar labels it) and its tabs.
export const HUB_TABS = Object.freeze({
  '/sales':      Object.freeze({ section: 'Sales',      tabs: SALES_TABS }),
  '/members':    Object.freeze({ section: 'Members',    tabs: MEMBERS_TABS }),
  '/money':      Object.freeze({ section: 'Money',      tabs: MONEY_TABS }),
  '/marketing':  Object.freeze({ section: 'Marketing',  tabs: MARKETING_TABS }),
  '/team':       Object.freeze({ section: 'Team',       tabs: TEAM_TABS }),
  '/operations': Object.freeze({ section: 'Operations', tabs: OPERATIONS_TABS }),
})
