// SIDEBAR-IA.1 / HUBS.2a — the sidebar's information architecture,
// extracted from Sidebar.jsx so the structure is a testable policy
// contract (nav-items.test.js) instead of data trapped inside a client
// component. Sidebar.jsx owns rendering/filtering/badges; this module
// owns WHAT is in the nav and WHERE it sits.
//
// HUBS.2a regroups the flat SIDEBAR-IA.1 sections into the phase-2 hub
// programme — each section below is (or is becoming) a hub with its own
// route and tab strip, rather than a department label:
//   messages    — the Messages hub. HUBS.2f Task 1 collapses it the same
//                 way: the Communications hub entry and the standalone
//                 Email inbox ticket-queue entry fold into one, with
//                 `email_inbox` OR'd into the entry's own anyPermission
//                 (there's no second route to add to extraActivePaths —
//                 the ticket queue already lives under /communications).
//   queues      — Approvals + Issues. INTERIM: header-less, until the
//                 phase-3 Home queue absorbs both into one inbox.
//   sales       — the Sales hub. HUBS.2a Task 2 collapsed it to a single
//                 sidebar entry backed by /sales's tab strip; the old
//                 standalone Pipeline/Contacts/Tasks entries are gone
//                 from here (they remain deep-linkable via the ⌘K
//                 palette and extraActivePaths keeps the hub entry lit
//                 while a user is on one of those routes).
//   members     — the Members hub. HUBS.2b Task 4 collapses it the same
//                 way: bookings, events, challenges, pulse, live floor
//                 HR (+ nested Class timer) and Hyrox Training Club all
//                 fold into a single /members entry.
//   money       — the Money hub. HUBS.2c Task 3 collapses it the same way:
//                 bookkeeping (RCOV.P2), the invoices queue, company-card
//                 receipts, the orders ledger, and (newly surfaced) offer
//                 sales all fold into a single /money entry.
//   marketing   — automations + the public landing page.
//   team        — schedule, staff contracts, HR policies.
//   operations  — studio management (door/TV/presentations) + equipment
//                 maintenance.
//   modules     — vertical modules bolted onto the core product (Cars).
//                 Header-less, out of the daily scan path.
//   account     — config.
// Sales, Members and Money are now collapsed; the remaining multi-entry
// sections (Team, Operations) are candidates for the same treatment in a
// later PR.
//
// The radars (churn/lead) are deliberately NOT here — SIDEBAR-IA.1
// relocated them under the Dashboard tab strip (/dashboard/churn-radar,
// /dashboard/lead-radar). DASHBOARD_LINK_PERM_KEYS below ORs their
// permissions into the Dashboard link so a radar-only user still gets
// an entry point (dashboard-redirect.js lands them on their radar).

import {
  LayoutDashboard, MessagesSquare,
  Settings, Car,
  Globe, ClipboardCheck, AlertCircle,
  Workflow, Building2,
  Wrench, Handshake, HeartPulse, Wallet, UsersRound,
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
  'engagement_analytics',
  // ADS-REPORT.3 — /dashboard/ads joined the dashboard tab family
  // (paid-ad performance + cost-per-booking). Same OR-in-the-
  // Dashboard-link treatment as the radars/engagement above.
  'dashboard_ads',
]

// Every top-level item carries a `section` (UI-FOUND.4) so the sidebar
// renders as labelled groups instead of one flat list. Dashboard has no
// section (pinned at the top). Section order + headers live in
// NAV_SECTIONS below. Within a section, items render in the order they
// appear here.
export const ALL_NAV = [
  // REPSET-ACCOUNT.1 — ACCOUNT-tier home (org portfolio). Pinned above
  // the Dashboard link and section headers because it sits ABOVE the
  // studio surfaces in the tier model (Account → Studio). Owner+/master
  // only (role-gated, like the other privileged config surfaces — no
  // per-user permission key). `/account` is the personal account page,
  // so the org portfolio lives at /portfolio.
  { href: '/portfolio',  label: 'Account home', icon: Building2,       masterOrOwnerOnly: true },
  { href: '/dashboard',  label: 'Dashboard',   icon: LayoutDashboard, dashboardGroup: true },

  // ── Messages hub ──────────────────────────────────────────────
  // HUBS.2f Task 1 — sixth application of the hub-collapse pattern
  // (after Sales HUBS.2a, Members HUBS.2b, Money HUBS.2c, Team HUBS.2d,
  // Operations HUBS.2e): what was two standalone sidebar entries
  // (Communications, the Email inbox ticket queue) becomes one hub
  // entry. `email_inbox` folds into the anyPermission union — this is
  // what the old separate EMAIL-TICKET.4 entry existed to express in
  // the first place (a different population: someone who only answers
  // accounts@/sales@ and holds none of the marketing `email`/
  // `whatsapp`/`sms` keys still needs a way into the hub). Folding the
  // key into the union rather than dropping the entry is what keeps
  // that population seeing Messages at all. The ticket queue itself
  // didn't move — it's still reachable as the "Email inbox" tab inside
  // CommunicationsTabs (COMMS-IA.3), gated the same way, badge intact —
  // only its OWN top-level sidebar row is gone. No extraActivePaths:
  // every one of its routes (/communications/send, /communications/
  // tickets, /communications/inbox, …) is already a literal child of
  // /communications, so the bare href prefix-matches all of them.
  { href: '/communications', label: 'Messages', icon: MessagesSquare,
    anyPermission: ['email', 'whatsapp', 'sms', 'email_inbox'], section: 'messages' },

  // ── queues — the interim action-queue zone (header-less). HUBS.2a
  // leaves Approvals + Issues here rather than folding them into a
  // hub; the phase-3 Home queue is what eventually absorbs both into
  // one inbox, so this section is deliberately a holding pen, not a
  // hub in its own right.
  //
  // APPROVALS.1 — central approvals dashboard. Aggregates contractor
  // invoices, FTE expense claims, time-off, swap requests, and any
  // future approval surfaces (extensible via src/lib/approvals
  // registry). Sidebar badge shows total pending count for items
  // the user can approve. Default-on for master + owner + manager —
  // head_coach + staff see nothing approvable so it's off for them.
  { href: '/approvals',  label: 'Approvals',    icon: ClipboardCheck,  permission: 'approvals_inbox', section: 'queues' },
  // REPORT-ISSUE.2 — handler inbox for staff-reported issues at the
  // active location. Owner + master by default; the submit + own-
  // history surface (REPORT-ISSUE.1) is open to all staff via the
  // mobile More tab and doesn't appear on the web sidebar.
  { href: '/issues',     label: 'Issues',       icon: AlertCircle,     permission: 'issues_inbox', section: 'queues' },

  // ── Sales hub ─────────────────────────────────────────────────
  // HUBS.2a — Sales collapses from three standalone sidebar entries
  // (Pipeline, Contacts, Tasks) to a single hub entry. The route
  // /sales exists since HUBS.2a Task 2 and renders a shared tab strip
  // (HubTabs) over the unchanged /pipeline, /contacts and /activities
  // URLs — the pages, permissions and data didn't move, only the
  // sidebar's presentation of them did. anyPermission ORs the three
  // underlying permissions so the hub entry is visible to anyone who
  // could reach any tab; extraActivePaths lights the entry while the
  // user is actually sitting on one of those routes (the hub's own
  // /sales URL redirects into a default tab rather than rendering
  // content itself, so without this the sidebar would go dark the
  // moment you land on a tab).
  { href: '/sales', label: 'Sales', icon: Handshake,
    anyPermission: ['pipeline', 'contacts', 'activities'],
    extraActivePaths: ['/pipeline', '/contacts', '/activities'],
    section: 'sales' },
  // ADS-REPORT — /dashboard/ads lives in the dashboard tab strip
  // (app/dashboard/layout.js SEGMENTS), not the sidebar. dashboard_ads
  // stays in DASHBOARD_LINK_PERM_KEYS so the pinned Dashboard link
  // remains visible for a user holding only that permission.
  // PERSON-LINK.2 — duplicate review is a tab on /contacts?tab=duplicates,
  // not a standalone sidebar entry. No sidebar item needed.

  // ── Members hub ───────────────────────────────────────────────
  // HUBS.2b Task 4 — mirrors the HUBS.2a Sales collapse: what was six
  // standalone sidebar entries (Bookings, Events, Challenges, Pulse,
  // the Live HR group + its Class timer child, Hyrox Training Club)
  // becomes one hub entry. anyPermission ORs every underlying
  // permission so the entry is visible to anyone who could reach any
  // tab; extraActivePaths keeps it lit while the user is actually
  // sitting on one of those routes (same rationale as Sales —
  // /members redirects into a default tab rather than rendering
  // content itself). `'events'` stays in the union even though no
  // current members tab reads it: it's a visibility superset carried
  // over from the old /bookings entry (anyPermission: ['events',
  // 'bookings']) so an events-holder who never held `bookings` still
  // sees the section — nobody loses access in the collapse.
  //
  // TRAP: `/studio-management/timer` also appears in the Operations
  // section's `/studio-management` entry's prefix match (the bare
  // pathname-startsWith matcher used for active-state highlighting) —
  // both this hub AND Studio Management light up on the timer page.
  // Accepted for this PR; the matcher fix belongs to whichever PR
  // gives Operations its own hub treatment.
  //
  // Folded-forward context from the old standalone entries:
  //  - Bookings landed on /bookings (high-frequency "what's booked
  //    today" view) with a tab strip switching booking types/reservations.
  //  - Events (mig 082 origin, multi-kind from mig 122) was labelled
  //    "Races" before the expansion — same race_events table, now spans
  //    race/workshop/seminar/open_day/masterclass via `kind`. URL
  //    relocated /races → /events; permission key `races` stays internal.
  //  - Challenges (ENGAGEMENT-CHALLENGES) — operator CRUD over the
  //    challenges table.
  //  - Pulse (PULSE-90.4) — the /pulse operator hub for the customer
  //    app's first-90-days journey lane + future engagement features.
  //  - Live HR (mig 110-113) — coach view of in-studio HR, redirects to
  //    /live/<activeLocation>; shares `studio_management` with Studio
  //    Management. Class timer nested under it (runs on the studio TV
  //    alongside the HR board — same floor surface, not an admin task).
  //  - Hyrox Training Club (HYROX-TC.2) — coach planner: generate/review/
  //    approve a 12-week Hyrox block before it publishes to the studio TV.
  { href: '/members', label: 'Members', icon: HeartPulse,
    anyPermission: ['bookings', 'events', 'races', 'challenges', 'pulse_admin', 'studio_management', 'class_timer', 'approvals_hyrox_sessions'],
    extraActivePaths: ['/bookings', '/events', '/challenges', '/pulse', '/live', '/studio-management/timer', '/hyrox'],
    section: 'members' },

  // ── Money hub ──────────────────────────────────────────────────
  // HUBS.2c Task 3 — third application of the hub-collapse pattern
  // (after Sales in HUBS.2a and Members in HUBS.2b): what was four
  // standalone sidebar entries (Accounting, Invoices, Company-card
  // receipts, Orders) becomes one hub entry. anyPermission ORs every
  // underlying permission so the entry is visible to anyone who could
  // reach any tab; extraActivePaths keeps it lit while the user is
  // actually sitting on one of those routes (same rationale as Sales/
  // Members — /money redirects into a default tab rather than
  // rendering content itself).
  //
  // `approvals_offer_purchases` in the union is a deliberate
  // visibility ADD, not just a fold-forward: /offer-sales had no
  // sidebar entry of its own before this PR — it was reachable only
  // by drilling into Approvals. The (money) route group's tab strip
  // (src/app/(money)/layout.js) already surfaces it as the "Offer
  // sales" tab, so the Money hub entry now has to light up for an
  // offer-purchases-only approver too, or the hub itself would stay
  // invisible to them while the tab inside it works fine.
  //
  // `/orders` overshow (pre-existing, carried forward): the old
  // standalone Orders entry showed on the `orders` permission alone,
  // but the page itself additionally gates on
  // MANAGER_ROLES.includes(user.role) — a non-manager holding the
  // permission sees the sidebar/tab entry and then bounces off the
  // page. Not fixed here; same overshow the (money) layout's own
  // /orders tab comment documents.
  //
  // Folded-forward context from the old standalone entries:
  //  - Accounting (RCOV.P0/P2) — receipt-coverage hub: coverage
  //    board, exceptions (audit F2–F5), runs & health. Master + owner
  //    only by default. RCOV.P2, Richard's "prevent sprawl" call, is
  //    why it leads the hub rather than Invoices.
  //  - Invoices (INVOICES.1) — Dext-style email-in inbox. Master +
  //    owner only by default. Per-location forwarding addresses show
  //    at the top of the page; quality + data approvals run before
  //    forward-to-Xero.
  //  - Company-card receipts (SPEND.P3) — a card holder photographs/
  //    uploads a receipt; owner/master approves it, then it rides the
  //    bookkeeper → Xero queue (the /approvals dashboard also
  //    surfaces the pending ones). Gated by `card_receipts` — default
  //    master + owner + manager; card-holding staff get it granted
  //    per-user.
  //  - Orders (mig 085) spans all revenue streams (race signups +
  //    cars). Got its own permission key in the mig-092 audit.
  //    Demoted from the Gym section 2026-06-12 — Richard confirmed
  //    it's not a daily surface; the ⌘K palette keeps it one
  //    keystroke away. HUBS.2a regrouped it under Money as a revenue
  //    ledger beside Accounting/Invoices.
  { href: '/money', label: 'Money', icon: Wallet,
    anyPermission: ['accounting_hub', 'invoices_inbox', 'card_receipts', 'orders', 'approvals_offer_purchases'],
    extraActivePaths: ['/accounting', '/invoices', '/card-receipts', '/orders', '/offer-sales'],
    section: 'money' },

  // ── Marketing ──────────────────────────────────────────────────
  { href: '/automations', label: 'Automations', icon: Workflow, anyPermission: ['automations', 'email', 'whatsapp'], section: 'marketing' },
  // HUBS.2a — promoted from a Studio Management child to Marketing
  // (it's the public-facing landing page, not a building-admin
  // surface). Public landing page — preview link, opens in new tab.
  // (The edit form moved to Settings → Landing page in SIDEBAR-IA.1.)
  { href: '/welcome', label: 'Landing page', icon: Globe,
    permission: 'landing_page', openInNewTab: true, section: 'marketing' },

  // ── Team hub ───────────────────────────────────────────────────
  // HUBS.2d — fourth application of the hub-collapse pattern (after
  // Sales in HUBS.2a, Members in HUBS.2b, Money in HUBS.2c): what was
  // three standalone sidebar entries (Schedule, Contracts, Policies)
  // becomes one hub entry. Team's specialty among the four: Policies
  // was already `openToAll` (POLICIES.1 — versioned HR policies open
  // to every signed-in employee, no permission gate), which had
  // already made the whole section universally visible in practice —
  // any signed-in user could see the Team header via that entry alone.
  // So the collapsed /team entry carrying `openToAll: true` is PARITY,
  // not an access add: nobody gains or loses visibility, the hub just
  // presents what was already true as one line instead of three.
  // extraActivePaths keeps the entry lit while the user is actually
  // sitting on one of the underlying routes (same rationale as Sales/
  // Members/Money — /team redirects into a default tab rather than
  // rendering content itself). The `/contracts` path in that list is
  // the NEW contracts home (moved this branch, HUBS.2d — the old
  // `/admin/contracts` URL now redirects there).
  //
  // Folded-forward context from the old standalone entries:
  //  - Schedule — internal tab strip (ScheduleTabs.jsx) holds
  //    Schedule / Approvals / Reporting / Invoices / Attendance. The
  //    Attendance tab (mig 120 — auto-stamped from UniFi Access door
  //    unlocks) used to be a top-level sidebar entry; folded into the
  //    schedule tab strip in May 2026 because operationally it sits
  //    next to Invoices (both are about staff time + pay). Same
  //    attendance_reports permission gate; the standalone
  //    /schedule/attendance URL still works as a deep link for
  //    cron-driven emails / scheduled reminders.
  //  - Contracts (mig 106) — digital staff/contractor contracts.
  //    HUBS.2a had promoted it from a Studio Management child to Team
  //    (staff contracts belong beside the schedule they're tied to,
  //    not under building admin); HUBS.2d moved its URL from
  //    /admin/contracts to /contracts as part of this collapse.
  //  - Policies (POLICIES.1) — versioned HR policies, open to every
  //    authenticated employee. No permission gate; the section always
  //    showed to anyone signed in so they could find the documents
  //    they're being asked to acknowledge — that's the universal
  //    visibility the collapsed entry now carries directly.
  { href: '/team', label: 'Team', icon: UsersRound,
    openToAll: true,
    extraActivePaths: ['/schedule', '/contracts', '/policies'],
    section: 'team' },

  // ── Operations hub ─────────────────────────────────────────────
  // HUBS.2e Task 5 — fifth application of the hub-collapse pattern
  // (after Sales HUBS.2a, Members HUBS.2b, Money HUBS.2c, Team
  // HUBS.2d): what was two standalone sidebar entries (Maintenance,
  // the Studio Management expandable group with its TV Displays +
  // Presentations children) becomes one hub entry. anyPermission ORs
  // every underlying permission so the entry is visible to anyone who
  // could reach any tab; extraActivePaths keeps it lit while the user
  // is actually sitting on one of those routes (same rationale as
  // Sales/Members/Money/Team — /operations redirects into a default
  // tab rather than rendering content itself). The `/checklists` path
  // is in the union even though checklists shares the `studio_management`
  // permission key with the Studio tab rather than getting its own —
  // its gate note lives on the (operations) route group's HubTabs
  // definition (src/app/(operations)/layout.js).
  //
  // The `/studio-management/timer` path is DELIBERATELY ABSENT from
  // this list. That route belongs to the Members hub's
  // extraActivePaths, not here — it's a coach-facing floor tool shown
  // alongside the live HR board, not an Operations admin surface. The
  // old double-light this used to cause (both Members AND the Studio
  // Management group lit on the timer page) is now structurally
  // impossible: activeHrefFor is a longest-match single winner, and
  // since Operations doesn't claim the timer path at all, Members's
  // longer, more specific extraActivePaths entry
  // (`/studio-management/timer`) is simply the only candidate that
  // matches — there's no second claimant left to race against it.
  //
  // fleet (device/AC control) and studio-devices surfaces are
  // deliberately deferred to a future dissolution of this hub — noted
  // here as a spec deviation, not an oversight.
  //
  // Folded-forward context from the old standalone entries:
  //  - Maintenance (EQUIP-MAINT.1) — equipment register + inspection
  //    checklists. Visible to anyone holding either equipment_admin
  //    (the setup surfaces — register, types, intervals, inspection
  //    weekday) or equipment_inspect (the walk-round; equipment_inspect
  //    is the universal default granted to every staff role). The page
  //    itself (src/app/(operations)/maintenance/page.js) gates which
  //    tabs render for which permission.
  //  - Studio Management (mig 093) — the door-unlock panel + its
  //    expandable children. SIDEBAR-IA.1 moved the rare set-and-forget
  //    surfaces (Glofox import, Preferences import, Landing page
  //    settings) onto the Settings index page; HUBS.2a promoted the
  //    remaining member/marketing/team-shaped children (Hyrox, Landing
  //    page, Contracts) out to their own hub sections, shrinking the
  //    group to TV displays (TV.1 — UC Cast Pro renders /tv/<token>)
  //    and Presentations (PRESENT — run a slide deck across multiple
  //    screens from a laptop for workshops/events) before this PR
  //    folded those two, plus Studio itself, into this single entry.
  { href: '/operations', label: 'Operations', icon: Wrench,
    anyPermission: ['equipment_admin', 'equipment_inspect', 'studio_management', 'tv_displays', 'presentations'],
    extraActivePaths: ['/maintenance', '/studio-management', '/tv-displays', '/presentations', '/checklists'],
    section: 'operations' },

  // ── modules — vertical modules zone (header-less) ────────────────
  // Header-less bottom zone for things that are real but not daily,
  // so they stop costing attention in the daily scan path.
  //
  // Car Processing — different business entirely. For CCF Autos
  // users the location feature gate already hides everything else,
  // so this reads as their primary entry either way.
  { href: '/cars/active', label: 'Car Processing', icon: Car,          permission: 'car_processing', section: 'modules' },

  // ── Account ────────────────────────────────────────────────────
  { href: '/settings',   label: 'Settings',     icon: Settings,        permission: 'settings', section: 'account' },
]

// UI-FOUND.4 / HUBS.2a — section render order + headers. A `label` of
// null renders the section's items with no header. HUBS.2a regroups
// SIDEBAR-IA.1's flat sections into the phase-2 hub programme:
//   - `queues` is INTERIM and deliberately header-less — Approvals +
//     Issues live here only until the phase-3 Home queue absorbs both
//     into one inbox, so it isn't styled as a hub of its own.
//   - `modules` is also header-less: vertical modules bolted onto the
//     core product (Cars today), kept out of the daily scan path.
// A section with no visible items for the current user renders nothing
// — no empty header. Dashboard is pinned above all sections (it has no
// `section`).
// activeHrefFor(pathname, items) — which ONE nav entry should light, and
// via which of its paths. Longest-match across every item's href,
// extraActivePaths, and children hrefs (CalendlyTabs semantics, already
// used by HubTabs). The old per-item bare startsWith let every prefix
// light simultaneously — /communications + /communications/tickets both
// lit on the tickets page, and Members + Operations both lit on the
// class timer. One winner only.
// Returns { itemHref, matchedPath } or null. A child match returns the
// PARENT item's href as itemHref and the child's href as matchedPath, so
// the group can open and the child row can light (current behaviour kept).
export function activeHrefFor(pathname, items) {
  let best = null
  for (const item of items) {
    const candidates = [
      { owner: item.href, path: item.href },
      ...(item.extraActivePaths || []).map(p => ({ owner: item.href, path: p })),
      ...(item.children || []).map(c => ({ owner: item.href, path: c.href })),
    ]
    for (const { owner, path } of candidates) {
      if (pathname === path || (path !== '/' && pathname.startsWith(`${path}/`))) {
        if (!best || path.length > best.matchedPath.length) {
          best = { itemHref: owner, matchedPath: path }
        }
      }
    }
  }
  return best
}

export const NAV_SECTIONS = [
  { id: 'messages',   label: 'Messages' },
  { id: 'queues',     label: null },
  { id: 'sales',      label: 'Sales' },
  { id: 'members',    label: 'Members' },
  { id: 'money',      label: 'Money' },
  { id: 'marketing',  label: 'Marketing' },
  { id: 'team',       label: 'Team' },
  { id: 'operations', label: 'Operations' },
  { id: 'modules',    label: null },
  { id: 'account',    label: 'Account' },
]
