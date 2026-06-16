// SIDEBAR-IA.1 — the sidebar's information architecture, extracted
// from Sidebar.jsx so the structure is a testable policy contract
// (nav-items.test.js) instead of data trapped inside a client
// component. Sidebar.jsx owns rendering/filtering/badges; this module
// owns WHAT is in the nav and WHERE it sits.
//
// Sections are grouped by job, not department:
//   Work    — the action queues (everything with a badge): what needs me?
//   Sales   — who are we selling to?
//   Gym     — what's on at the gym?
//   studio  — the building (self-labelled collapsible group, no header)
//   other   — occasional surfaces: car-import business + orders ledger
//             (header-less bottom zone, out of the daily scan path)
//   Account — config + policies
//
// The radars (churn/lead) are deliberately NOT here — SIDEBAR-IA.1
// relocated them under the Dashboard tab strip (/dashboard/churn-radar,
// /dashboard/lead-radar). DASHBOARD_LINK_PERM_KEYS below ORs their
// permissions into the Dashboard link so a radar-only user still gets
// an entry point (dashboard-redirect.js lands them on their radar).

import {
  LayoutDashboard, Users, Columns3, CheckSquare, Calendar, MessagesSquare,
  CalendarClock, Settings, Car, Flag, Receipt, DoorOpen, FileSignature,
  Heart, Globe, Tv, BookOpen, Inbox, ClipboardCheck, AlertCircle, CreditCard,
  Workflow,
} from 'lucide-react'

// The sidebar Dashboard link is visible if ANY of these are true. The
// first three are the dashboard sub-permissions (sub-page selection
// happens via the segmented control at the top of /dashboard/*); the
// radar keys joined in SIDEBAR-IA.1 when the radars became dashboard
// tabs. command-palette.js shares this list for the ⌘K Dashboard entry.
export const DASHBOARD_LINK_PERM_KEYS = [
  'dashboard_personal',
  'dashboard_studio',
  'dashboard_business',
  'churn_radar',
  'lead_radar',
]

// Every top-level item carries a `section` (UI-FOUND.4) so the sidebar
// renders as labelled groups instead of one flat list. Dashboard has no
// section (pinned at the top). Section order + headers live in
// NAV_SECTIONS below. Within a section, items render in the order they
// appear here.
export const ALL_NAV = [
  { href: '/dashboard',  label: 'Dashboard',   icon: LayoutDashboard, dashboardGroup: true },

  // ── Work — the action queues. One section for everything that
  // accrues pending counts, so the morning loop is "walk the Work
  // section top to bottom" instead of polling entries scattered
  // across Sales/Operations/Communications (the pre-SIDEBAR-IA.1
  // layout). Badge wiring stays in Sidebar.jsx.
  //
  // Single Communications entry replacing the old Email + WhatsApp.
  // Visible if the user has EITHER permission — sub-tabs inside the
  // hub gate themselves further.
  { href: '/communications', label: 'Communications', icon: MessagesSquare,
    anyPermission: ['email', 'whatsapp'], section: 'work' },
  // Single entry replacing the old Events + Bookings ("Calendly").
  // The hub lands on /bookings (the high-frequency operational view —
  // "what's booked today / coming up") with a tab strip at the top of
  // /bookings/* that switches between booking types and reservations.
  { href: '/bookings',   label: 'Bookings',     icon: Calendar,
    anyPermission: ['events', 'bookings'], section: 'work' },
  // APPROVALS.1 — central approvals dashboard. Aggregates contractor
  // invoices, FTE expense claims, time-off, swap requests, and any
  // future approval surfaces (extensible via src/lib/approvals
  // registry). Sidebar badge shows total pending count for items
  // the user can approve. Default-on for master + owner + manager —
  // head_coach + staff see nothing approvable so it's off for them.
  { href: '/approvals',  label: 'Approvals',    icon: ClipboardCheck,  permission: 'approvals_inbox', section: 'work' },
  // REPORT-ISSUE.2 — handler inbox for staff-reported issues at the
  // active location. Owner + master by default; the submit + own-
  // history surface (REPORT-ISSUE.1) is open to all staff via the
  // mobile More tab and doesn't appear on the web sidebar.
  { href: '/issues',     label: 'Issues',       icon: AlertCircle,     permission: 'issues_inbox', section: 'work' },
  // INVOICES.1 — Dext-style email-in inbox. Master + owner only by
  // default. Per-location forwarding addresses are shown at the top
  // of the page; quality + data approvals run before forward-to-Xero.
  { href: '/invoices',   label: 'Invoices',     icon: Inbox,           permission: 'invoices_inbox', section: 'work' },
  // SPEND.P3 — company-card receipts. A card holder photographs/uploads
  // a receipt; owner/master approves it, then it rides the bookkeeper →
  // Xero queue (the /approvals dashboard also surfaces the pending ones).
  // Gated by the `card_receipts` permission — default master + owner +
  // manager; card-holding staff get it granted per-user. No sidebar
  // badge: approvable receipts already count on the Approvals entry.
  { href: '/card-receipts', label: 'Company-card receipts', icon: CreditCard, permission: 'card_receipts', section: 'work' },

  // ── Sales ──────────────────────────────────────────────────────
  { href: '/pipeline',            label: 'Pipeline',  icon: Columns3,   permission: 'pipeline',        section: 'sales' },
  { href: '/contacts',            label: 'Contacts',  icon: Users,      permission: 'contacts',        section: 'sales' },
  // PERSON-LINK.2 — duplicate review is now a tab on /contacts?tab=duplicates,
  // not a standalone sidebar entry. No sidebar item needed.
  { href: '/activities',          label: 'Tasks',     icon: CheckSquare, permission: 'activities',     section: 'sales' },

  // ── Gym — what's on at the gym ─────────────────────────────────
  //
  // Schedule hub — single sidebar entry. Internal tab strip
  // (ScheduleTabs.jsx) holds Schedule / Approvals / Reporting /
  // Invoices / Attendance. The Attendance tab (mig 120 — auto-
  // stamped from UniFi Access door unlocks) used to be a top-level
  // sidebar entry; folded into the schedule tab strip in May 2026
  // because operationally it sits next to Invoices (both are
  // about staff time + pay). Same attendance_reports permission
  // gate; the standalone /schedule/attendance URL still works as
  // a deep link for cron-driven emails / scheduled reminders.
  { href: '/schedule',   label: 'Schedule',     icon: CalendarClock,   permission: 'schedule', section: 'gym' },
  // Events (mig 082 origin, multi-kind from mig 122 onwards). Was
  // labelled "Races" before the events expansion — same data table
  // (race_events), now spans race + workshop + seminar + open_day +
  // masterclass via the kind discriminator. URL relocated /races →
  // /events; permission key 'races' stays internal (gates UI, not
  // user-visible). extraActivePaths keeps the entry highlighted on
  // old /events/* URLs that hit the back-compat rewrite.
  { href: '/events',     label: 'Events',       icon: Flag,            permission: 'races',
    extraActivePaths: ['/events'], section: 'gym' },
  // Live class — coach view of in-studio HR (mig 110-113). Renders
  // attendees with current zone color, available straps panel, and
  // override-pairing flow. /live redirects to /live/<activeLocation>.
  // Same permission gate as Studio Management — anyone running
  // class can use it. Stays a top-level entry (not nested under
  // Studio Management) because operationally it's its own surface
  // (live HR is a primary screen, not an admin task). Lived under
  // the Communications header before SIDEBAR-IA.1 — a misfile.
  { href: '/live', label: 'Live HR', icon: Heart, permission: 'studio_management', section: 'gym' },

  // ── Automations ────────────────────────────────────────────────
  { href: '/automations', label: 'Automations', icon: Workflow, anyPermission: ['automations', 'email', 'whatsapp'], section: 'automations' },

  // ── Studio Management — expandable group ───────────────────────
  // Parent route /studio-management renders the door-unlock panel
  // (mig 093 cross-platform key). Children each carry their own
  // per-user permission (STUDIO-GROUP.1) so operators can grant
  // access individually. Lives in its own (header-less) `studio`
  // section — it's already self-labelled and collapsible, so an
  // extra section header would be redundant. SIDEBAR-IA.1 moved the
  // rare set-and-forget surfaces (Glofox import, Preferences import,
  // Landing page settings) onto the Settings index page, shrinking
  // this group to the genuinely studio-shaped surfaces.
  {
    href: '/studio-management',
    label: 'Studio Management',
    icon: DoorOpen,
    permission: 'studio_management',
    section: 'studio',
    groupId: 'studio',  // localStorage key for expand state
    children: [
      // Contracts (mig 106) — digital staff/contractor contracts.
      { href: '/admin/contracts',         label: 'Contracts',             icon: FileSignature, permission: 'contracts' },
      // TV.1 — TV display management. UC Cast Pro renders /tv/<token>.
      { href: '/admin/tv-displays',       label: 'TV Displays',           icon: Tv,            permission: 'tv_displays' },
      // Public landing page — preview link, opens in new tab. (The
      // edit form moved to Settings → Landing page in SIDEBAR-IA.1.)
      { href: '/welcome',                 label: 'Landing page',          icon: Globe,         permission: 'landing_page', openInNewTab: true },
    ],
  },

  // ── Other — occasional surfaces zone ───────────────────────────
  // Header-less bottom zone for things that are real but not daily,
  // so they stop costing attention in the daily scan path.
  //
  // Car Processing — different business entirely. For CCF Autos
  // users the location feature gate already hides everything else,
  // so this reads as their primary entry either way.
  { href: '/cars',       label: 'Car Processing', icon: Car,           permission: 'car_processing', section: 'other' },
  // Orders (mig 085) spans all revenue streams (race signups + cars).
  // Got its own permission key in the mig-092 audit. Demoted from the
  // Gym section 2026-06-12 — Richard confirmed it's not a daily
  // surface; the ⌘K palette keeps it one keystroke away. (Segments
  // was demoted the same way earlier — moved under /communications/
  // segments; the /segments URL still works via legacy redirect.)
  { href: '/orders',     label: 'Orders',       icon: Receipt,         permission: 'orders', section: 'other' },

  // ── Account ────────────────────────────────────────────────────
  // Policies (POLICIES.1) — versioned HR policies, open to every
  // authenticated employee. No permission gate; sidebar always shows
  // the entry to anyone signed in so they can find the documents
  // they're being asked to acknowledge.
  { href: '/policies',   label: 'Policies',     icon: BookOpen,        openToAll: true, section: 'account' },
  { href: '/settings',   label: 'Settings',     icon: Settings,        permission: 'settings', section: 'account' },
]

// UI-FOUND.4 — section render order + headers. A `label` of null renders
// the section's items with no header (used for the self-labelled Studio
// Management group and the occasional-surfaces zone). A section with no
// visible items for the current user renders nothing — no empty header.
// Dashboard is pinned above all sections (it has no `section`).
export const NAV_SECTIONS = [
  { id: 'work',    label: 'Work' },
  { id: 'sales',   label: 'Sales' },
  { id: 'gym',          label: 'Gym' },
  { id: 'automations',  label: 'Automations' },
  { id: 'studio',       label: null },
  { id: 'other',   label: null },
  { id: 'account', label: 'Account' },
]
