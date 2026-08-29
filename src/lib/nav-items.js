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
//   marketing   — the Marketing hub. HUBS.2f Task 2 collapses it the same
//                 way: Automations and the public Landing page link fold
//                 into a single /marketing entry, with `landing_page`
//                 OR'd in (same reasoning as Messages' email_inbox fold)
//                 and the Landing page tab reached inside the hub via
//                 HubTabs' new `newTab` capability rather than its own
//                 top-level sidebar row.
//   team        — the Team hub. HUBS.2d collapsed it the same way:
//                 schedule, staff contracts, HR policies fold into a
//                 single /team entry.
//   operations  — the Operations hub. HUBS.2e collapsed it the same way:
//                 studio management (door/TV/presentations) + equipment
//                 maintenance fold into a single /operations entry.
//   modules     — vertical modules bolted onto the core product (Cars).
//                 Header-less, out of the daily scan path.
//   account     — config.
// Messages, Sales, Members, Money, Marketing, Team and Operations are now
// all collapsed to single hub entries — every multi-entry section from
// the original HUBS.2a regroup has gone through the pattern.
//
// The radars (churn/lead) are deliberately NOT here — SIDEBAR-IA.1
// relocated them under the Dashboard tab strip (/dashboard/churn-radar,
// /dashboard/lead-radar). DASHBOARD_LINK_PERM_KEYS below ORs their
// permissions into the Dashboard link so a radar-only user still gets
// an entry point (dashboard-redirect.js lands them on their radar).

import {
  LayoutDashboard, MessagesSquare,
  Settings, Car,
  Megaphone, Building2,
  Wrench, Handshake, HeartPulse, Wallet, UsersRound,
  ClipboardCheck,
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

  // HOME.3 retired this row in favour of the needs-attention queue;
  // RESTORED by operator request (Richard, 19 Aug 2026) — the queue
  // surfaces approval items, but he wants the dedicated dashboard one
  // click away as a pinned row too. Issues stays retired. Pinned
  // (sectionless) rather than reviving the old 'queues' section, so
  // the hub programme's section groups stay as HUBS.2 left them.
  { href: '/approvals',  label: 'Approvals',   icon: ClipboardCheck,  permission: 'approvals_inbox' },

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
  // that population seeing Messages at all. Email is the "Mail" tab
  // inside CommunicationsTabs (/communications/mail — RETIRE-TICKETS.1
  // retired the old ticket-queue tab), gated the same way, badge
  // intact. No extraActivePaths: every one of its routes
  // (/communications/send, /communications/mail, /communications/
  // inbox, …) is already a literal child of /communications, so the
  // bare href prefix-matches all of them.
  //
  // DEEP.4 Task 2 (4B) — the union below is UNCHANGED even though the
  // campaign-lifecycle pages (Send/Sent/Templates/Segments/List health)
  // moved ownership to Marketing: /communications/send etc. still live
  // literally under /communications, so someone holding only `email` or
  // `sms` (a one-off-sends-only permission shape, no `whatsapp`, no
  // `email_inbox`) still needs a sidebar door into that URL space, and
  // this entry is still it. What changed is which entry WINS the
  // active-state fight once they're actually on one of those pages —
  // see the Marketing hub entry below, whose extraActivePaths now
  // claims those specific paths and out-matches this bare
  // `/communications` prefix (activeHrefFor is longest-match). A user
  // can legitimately see BOTH Messages and Marketing lit in the
  // sidebar's visible-sections sense (holding `email` alone satisfies
  // both unions) while only ONE is highlighted active at a time.
  { href: '/communications', label: 'Messages', icon: MessagesSquare,
    anyPermission: ['email', 'whatsapp', 'sms', 'email_inbox'], section: 'messages' },

  // HOME.3 — the standalone Approvals + Issues sidebar entries (the old
  // "queues" holding pen) retired here. The needs-attention queue on
  // /dashboard/today (assembleHomeQueue, src/lib/home-queue.js) is now
  // the entry point for both: it merges approvals + issues + mail
  // + the unified inbox into one item-level list, so a
  // dedicated Approvals/Issues sidebar row would just be a second way
  // to reach a subset of what the queue already shows. Both pages
  // still exist and both routes still work — /approvals and /issues
  // remain reachable as deep-link destinations (⌘K palette commands
  // below in command-palette.js, and every queue row's href) — only
  // their OWN top-level sidebar rows are gone.

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
  //
  // DEEP.4 Task 1 (4A) — approvals_contractor_invoices and
  // approvals_fte_expenses join the union so a reviewer who holds ONLY
  // one of these two keys still sees the Money hub entry at all: the
  // (money) route group's tab strip (src/app/(money)/layout.js) grew
  // two cross-hub review tabs pointing at /schedule/invoices and
  // /schedule/expenses (submitters keep using Team → Schedule; this is
  // the reviewer-side door). Deliberately NOT added to
  // extraActivePaths — those two routes are (team)-group pages and
  // Team's own extraActivePaths already claims the /schedule prefix,
  // so landing on either page lights Team's sidebar entry, not
  // Money's (activeHrefFor is a longest-match ONE winner; see
  // nav-items.test.js's "cross-hub tab active-state" cases). Same
  // pattern as (operations)'s `fleet` tab (/admin/fleet) and
  // (members)'s `live` tab (/live) — a hub tab whose href lives
  // outside that hub's own route group and sidebar territory.
  { href: '/money', label: 'Money', icon: Wallet,
    anyPermission: ['accounting_hub', 'invoices_inbox', 'card_receipts', 'orders', 'approvals_offer_purchases', 'approvals_contractor_invoices', 'approvals_fte_expenses'],
    extraActivePaths: ['/accounting', '/invoices', '/card-receipts', '/orders', '/offer-sales'],
    section: 'money' },

  // ── Marketing hub ─────────────────────────────────────────────
  // HUBS.2f Task 2 — seventh application of the hub-collapse pattern
  // (after Sales HUBS.2a, Members HUBS.2b, Money HUBS.2c, Team
  // HUBS.2d, Operations HUBS.2e, Messages HUBS.2f Task 1): what was
  // two standalone sidebar entries (Automations, the public Landing
  // page link) becomes one hub entry. anyPermission ORs both
  // underlying permissions plus `landing_page` — folding landing_page
  // into the union (rather than dropping it) is what keeps a
  // landing-page-only editor seeing Marketing at all, the same
  // reasoning Messages' `email_inbox` fold used. extraActivePaths
  // keeps the entry lit while the user is actually on /automations
  // (same rationale as every prior hub — /marketing redirects into a
  // default tab rather than rendering content itself).
  //
  // Review fix — `device_control` joined the union: the Automations
  // page also gates its Studio music (Sonos) section on device_control
  // alone (canDevices in src/app/(marketing)/automations/page.js), a
  // population the original union missed entirely. Without it a
  // device_control-only holder saw no Marketing sidebar entry at all,
  // even though /automations was reachable and useful to them.
  //
  // `/welcome` is deliberately ABSENT from extraActivePaths: it's the
  // PUBLIC marketing site (outside auth entirely, per the public-path
  // allowlist), never an in-app pathname the sidebar could be sitting
  // on, so there's nothing there for the hub entry to light against.
  // Its reachability didn't disappear — it moved from its own
  // top-level sidebar row to the (marketing) hub's Landing page tab
  // (src/app/(marketing)/layout.js), which renders it via HubTabs'
  // new `newTab: true` capability (HUBS.2f Task 2): a plain
  // target="_blank" anchor with an ExternalLink glyph, same idiom the
  // old standalone sidebar entry used via openInNewTab.
  //
  // Folded-forward context from the old standalone entries:
  //  - Automations (curated toggles + custom email/WhatsApp flows +
  //    device control) — visible to anyone holding `automations`
  //    (the curated cards), `email`/`whatsapp` (custom flows), or
  //    `device_control` (the device-control section); the page itself
  //    (src/app/(marketing)/automations/page.js) gates which sections
  //    render for which permission, matching this union exactly.
  //  - Landing page (HUBS.2a — promoted from a Studio Management child
  //    to Marketing; it's the public-facing landing page, not a
  //    building-admin surface). The edit form lives at Settings →
  //    Landing page (SIDEBAR-IA.1); this was always just the public
  //    preview link.
  //
  // DEEP.4 Task 2 (4B) — `sms` joins the union: it had NO conversational
  // surface of its own (no SMS inbox — the channel is broadcast-only),
  // so unlike `email`/`whatsapp` it was never in this union via the
  // Automations page's own gate. It's here now because /communications/
  // send and /communications/sent (both in extraActivePaths below) are
  // reachable on `sms` alone, and an sms-only holder needs a Marketing
  // door to them. `email`/`whatsapp`/`device_control` were already
  // present (the Automations page's own gate) and stay for the same
  // reason they always did — the campaign-lifecycle move didn't change
  // what /automations itself requires.
  //
  // extraActivePaths grew five entries: /communications/send, /sent,
  // /templates, /segments, /list-health. These are the SAME five
  // (marketing-era) cross-hub tabs added to (marketing)/layout.js
  // above — claiming them here is what makes activeHrefFor highlight
  // Marketing (not Messages, whose bare `/communications` href would
  // otherwise be the only candidate) once the user is actually on one
  // of those pages. Longest-match: Marketing's longer, more specific
  // path always wins over Messages' bare prefix.
  //
  // FU-COSMETICS awareness note — `/communications/templates` as a
  // prefix also matches the FULL-SCREEN template editors under
  // src/app/communications/(editors)/templates/email|whatsapp (route
  // groups don't affect the URL, so those pages' real paths are
  // /communications/templates/email/... and .../whatsapp/...). Those
  // editors deliberately opt OUT of the (marketing-era) hub's own tab
  // strip (see src/app/communications/layout.js's header comment), but
  // AppShell still renders the persistent Sidebar around them, so
  // Marketing lights up there too — a user deep in one campaign's WYSIWYG
  // editor sees "Marketing" tinted in the sidebar despite not being on
  // any hub tab. Accepted-by-design: it's still the correct SECTION
  // (you did get there via Marketing → Templates), the editor itself
  // has no tab strip to conflict with, and narrowing extraActivePaths to
  // exclude the editor sub-paths would just make the *list* page light
  // up while its own editor doesn't — worse, not better.
  { href: '/marketing', label: 'Marketing', icon: Megaphone,
    anyPermission: ['automations', 'email', 'whatsapp', 'device_control', 'landing_page', 'sms'],
    extraActivePaths: ['/automations', '/communications/send', '/communications/sent', '/communications/templates', '/communications/segments', '/communications/list-health'],
    section: 'marketing' },

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
  //  - Schedule — second-level tab strip (ScheduleTabs.jsx) holds
  //    Schedule / Reporting / Time Off / Swaps / Invoices / Expenses /
  //    Attendance. The Attendance tab (mig 120 — auto-stamped from UniFi
  //    Access door unlocks) used to be a top-level sidebar entry; folded
  //    into the schedule tab strip in May 2026 because operationally it
  //    sits next to Invoices (both are about staff time + pay). Same
  //    attendance_reports permission gate; the standalone
  //    /schedule/attendance URL still works as a deep link for
  //    cron-driven emails / scheduled reminders. SCHED.9 (2026-08) made
  //    every tab a real Link to its own /schedule/* page instead of a
  //    useState swap — Reporting is the one exception (no standalone page
  //    exists, so it's distinguished by a /schedule?view=reporting search
  //    param instead); ScheduleTabs.jsx's own header comment has the
  //    full duplication-vs-convergence writeup.
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
  // ADMIN.2h Task 2 review fix — fleet_restart/fleet_admin joined the
  // union below. The (operations) route group grew a `fleet` tab
  // (href /admin/fleet, outside the group — see its layout's header
  // comment) so fleet is now reachable through this hub, but without
  // these two keys in anyPermission an edge persona holding ONLY
  // fleet_restart/fleet_admin (every other Operations permission
  // revoked) would never see the Operations sidebar entry at all —
  // exactly the "no persistent nav home" problem ADMIN.2h set out to
  // fix, just one permission-shape narrower. studio-devices remains
  // deliberately deferred to a future dissolution of this hub (it has
  // no Operations tab and isn't reachable from here at all) — noted
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
  //
  // HUBDOOR.1 — the review fix above added the two fleet keys to the union
  // but nothing else: /operations' own index chain had no fleet branch, so
  // the persona it was written for clicked the entry and bounced to '/'.
  // The chain (now src/lib/hub-index-chains.js) grew a
  // fleet_restart|fleet_admin → /admin/fleet step, and '/admin/fleet' joins
  // extraActivePaths below so the entry they clicked stays lit on arrival.
  // Claiming it is uncontested — no other nav entry owns any /admin path
  // (the Platform Console is a separate tier, platform-nav.js) — so this is
  // not the longest-match race that kept Money out of /schedule/*; there is
  // simply no other candidate, and without the claim the sidebar goes dark
  // on a page the Operations hub deliberately links to.
  { href: '/operations', label: 'Operations', icon: Wrench,
    anyPermission: ['equipment_admin', 'equipment_inspect', 'studio_management', 'tv_displays', 'presentations', 'fleet_restart', 'fleet_admin'],
    extraActivePaths: ['/maintenance', '/studio-management', '/tv-displays', '/presentations', '/checklists', '/admin/fleet'],
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
//   - `modules` is header-less: vertical modules bolted onto the
//     core product (Cars today), kept out of the daily scan path.
// HOME.3 retired the `queues` section (the interim Approvals + Issues
// holding pen) — the needs-attention queue on /dashboard/today now
// absorbs both, exactly as this comment used to say it eventually
// would.
// A section with no visible items for the current user renders nothing
// — no empty header. Dashboard is pinned above all sections (it has no
// `section`).
// activeHrefFor(pathname, items) — which ONE nav entry should light, and
// via which of its paths. Longest-match across every item's href,
// extraActivePaths, and children hrefs (CalendlyTabs semantics, already
// used by HubTabs). The old per-item bare startsWith let every prefix
// light simultaneously — /communications + /communications/mail both
// lit on the mail page, and Members + Operations both lit on the
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
  { id: 'sales',      label: 'Sales' },
  { id: 'members',    label: 'Members' },
  { id: 'money',      label: 'Money' },
  { id: 'marketing',  label: 'Marketing' },
  { id: 'team',       label: 'Team' },
  { id: 'operations', label: 'Operations' },
  { id: 'modules',    label: null },
  { id: 'account',    label: 'Account' },
]
