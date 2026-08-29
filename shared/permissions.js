// Single source of truth for web + mobile feature permissions.
//
// Both `src/components/StaffForm.jsx` (the admin UI on web) and
// `mobile/lib/permissions.js` (the gate the iOS app reads on login)
// import from this file. Adding a new feature here in one place
// guarantees the admin toggle, the mobile-side check, and the parity
// linter (`npm run check:mobile-parity`) all stay in sync.
//
// Plain JS, no Next.js / React imports — Metro (mobile bundler) can
// resolve it via the `watchFolders` setting in mobile/metro.config.js,
// and Next.js resolves it via the `@/shared/*` alias in jsconfig.json.
//
// BUNDLES.5 — one-directional import from permission-bundles.js (the
// bundle layer sitting above these keys). permission-bundles.js does
// NOT import back from here (its EXEMPT_KEYS is a deliberately literal
// list, not `[...NOTIFY_KEYS, ...APPROVAL_SUBPERMISSION_KEYS]`) — see
// the EXEMPT_KEYS comment there for why a reverse import would be
// circular against this file's top-to-bottom eval order.
import { bundlesDenyKey, bundlesDenyCategory } from './permission-bundles.js'

// ============================================================
// Web sidebar permissions
//
// Controls visibility of Sidebar.jsx nav links. Stored under
// profiles.permissions.<key>. Server-side authz (per-route guards
// + RLS) is the actual security boundary; this just hides UI from
// users who can't act on it anyway.
// ============================================================

// The three dashboard sub-views are CROSS-PLATFORM permissions —
// they appear in WEB_PERMISSIONS only (no `mobile.` prefix on disk)
// but both the web sidebar AND the mobile Home tab read them. This
// lets a single admin toggle in StaffForm control visibility on both
// devices at once. To check on mobile use `canDashboard(profile, key)`
// from lib/permissions.js (NOT canMobile() — those are mobile-only).
// Ordered into logical groups so the location feature matrix and
// the per-user permission picker scan top-to-bottom: dashboards →
// CRM → bookings/events → races → communications → operations →
// revenue → infra. New top-level routes go in the appropriate
// group, not at the end of the list.
export const WEB_PERMISSIONS = Object.freeze([
  // — Dashboards (cross-platform, see CROSS_PLATFORM_DASHBOARD_KEYS) —
  { key: 'dashboard_personal', label: 'Dashboard · Today',     hint: 'Personal home view — your shifts, swaps, inbox' },
  { key: 'dashboard_studio',   label: 'Dashboard · Studio',    hint: 'Web: revenue KPI scorecard by location · mobile: ops view' },
  { key: 'dashboard_business', label: 'Dashboard · Business',  hint: 'Owner-level — pipeline, won deals, payroll' },
  // ADS-REPORT.0 — paid-ad performance dashboard (/dashboard/ads).
  // Desktop analytics surface, like the other radar/analytics
  // dashboards — no mobile counterpart (see WEB_ONLY_OK in
  // scripts/check-mobile-parity.mjs). Owner + manager by default;
  // head_coach + staff off (acquisition-spend oversight, not a
  // staff surface).
  { key: 'dashboard_ads', label: 'Ads Dashboard',                hint: 'Paid-ad performance and cost-per-booking analytics.' },
  // — CRM —
  { key: 'pipeline',   label: 'Pipeline & Deals' },
  { key: 'contacts',   label: 'Contacts' },
  { key: 'activities', label: 'Tasks',                          hint: 'Renamed from Activities (mig 073). Tasks-kind activities only — auto-logged events stay on the contact timeline.' },
  // CHURN-RADAR.1 — at-risk member radar. Scores the active member
  // base on attendance signals (gone quiet, disengaging, no-shows),
  // offers win-back actions, and surfaces a quarantine triage list
  // for zero-activity records. Owner + head_coach by default — a
  // retention oversight tool, not a staff surface.
  { key: 'churn_radar', label: 'Churn Radar',                   hint: 'At-risk member radar — attendance-based churn signals, win-back actions, and quarantine triage. Owner + head coach by default.' },
  // LEAD-RADAR.1 — non-member triage radar. Splits the ~7,100
  // lead/trial/classpass base into a Funnel (live cohort worth a
  // follow-up) and a Cleanup list (dormant records to archive).
  // Owner + head_coach by default — an acquisition oversight tool,
  // mirroring churn_radar's defaults.
  { key: 'lead_radar', label: 'Lead Radar',                     hint: 'Non-member triage radar — funnel of leads / trials / ClassPass worth converting, plus cleanup of dormant records. Owner + head coach by default.' },
  // P2-7 — engagement→churn analytics dashboard tab (/dashboard/engagement).
  // Cross-tabs the member base by friend-count tier against churn-risk +
  // attendance ("members with more friends churn less") and tracks app /
  // social adoption. Retention oversight — owner + manager + head_coach.
  { key: 'engagement_analytics', label: 'Engagement Analytics',  hint: 'Member engagement vs churn — friend-count tiers against at-risk % + attendance, plus app/social adoption. Owner + manager + head coach by default.' },
  // PULSE-90.4 — the /pulse operator hub: management home for the
  // first-90-days journey (the 9-classes-in-6-weeks pace lane) and the
  // future Pulse app features (leaderboards, seasonal challenge). Links
  // out to the engagement dashboard + challenges admin rather than
  // duplicating them. Desktop operator surface (WEB_ONLY_OK). Owner +
  // manager + head_coach by default — a retention oversight tool, staff off.
  { key: 'pulse_admin', label: 'Pulse app',                      hint: 'Manage the Pulse customer app — the first-90-days member journey (9-classes-in-6-weeks pace lane, coach touches) plus the wider Pulse engagement features. Owner + manager + head coach by default.' },
  // — Calendly bookings + standalone race events —
  { key: 'events',     label: 'Calendly events',                hint: 'Booking event types (recurring availability, slot picker, /events + /bookings hub).' },
  { key: 'bookings',   label: 'Bookings list',                  hint: 'Enables the /bookings sub-tab inside the Calendly hub. Operators usually want this on alongside Events.' },
  // Mig 092 split: races used to ride on `events`. Locations that
  // don't run races can now hide them without losing booking events.
  { key: 'races',      label: 'Race events',                    hint: 'Standalone race events (mig 082). Hyrox-style team races with waves, member pricing, race-day control panel + TV display.' },
  // — Communications (single hub at /communications) —
  { key: 'email',      label: 'Email Marketing',                hint: 'Postmark broadcasts, sequences (drip campaigns), templates, segments.' },
  { key: 'whatsapp',   label: 'WhatsApp',                       hint: 'WhatsApp Cloud API inbox + broadcasts.' },
  { key: 'sms',        label: 'SMS',                            hint: 'Send SMS via Twilio. Per-location alpha sender ID configured in Location Settings.' },
  // — Operations —
  { key: 'schedule',          label: 'Schedule',                hint: 'Coach roster, shift blocks, time-off, swap requests.' },
  // Mig 120: zero-touch attendance tracking. Auto-stamps actual
  // arrival times from UniFi Access door unlocks and reports
  // on-time / late / no-show. NOT visible to staff themselves —
  // this is an owner-/manager-/master-only oversight tool.
  // Default-off for staff + head_coach below.
  { key: 'attendance_reports', label: 'Attendance Reports',     hint: 'Who turned up on time. Auto-stamped from UniFi Access door unlocks; staff cannot see this.' },
  { key: 'assistant',         label: 'AI Assistant',            hint: 'In-app chat assistant with CRM tool use.' },
  // Mig 093 (Nov 2026): renamed from `door_unlock` (mobile-only)
  // to `studio_management` (cross-platform, top-level on
  // permissions). Both web sidebar AND mobile read this single
  // key. Surface today is remote door unlock via UniFi Access;
  // future studio-ops actions (alarm arm/disarm, camera live view,
  // etc.) will land under the same gate.
  { key: 'studio_management', label: 'Studio Management',       hint: 'Remote door unlock + future on-site operations. Requires UniFi Access configured for the location.' },
  // CLASS-TIMER-PERM.1 — split off `studio_management` so coaches on
  // shift can run the class interval timer without also holding door
  // unlock / AC control. Cross-platform (same key gates the web page,
  // the mobile timer screen and every /api/timer/* route). ON for
  // every role by default — revoke per user/role via the Roles tab.
  { key: 'class_timer',       label: 'Class timer',             hint: 'Start, pause and stop the class interval timer on the studio TV, including quick-add presets and timer templates.' },
  // SONOS.16 — device_control now gates Sonos studio-music scheduling;
  // its old surface (Tapo plug/switch control, TAPO-T1.4) was deleted at
  // SONOS.14. Per-schedule playback windows (days/on/off/volume/
  // favourite), manual run-now, and a temporary pause override, live at
  // /automations/sonos (web). SONOSMOB.2 made the key cross-platform
  // (CROSS_PLATFORM_KEYS): the mobile Studio hub's "Studio music" screen
  // offers live control only — play/pause/skip, volume, favourites — over
  // the same /api/sonos/* routes. Owner + manager by default; head_coach +
  // staff off (on-site operations oversight).
  // SHELLY-UI.8 — the key now also gates Shelly smart plugs
  // (/automations/shelly, web): adopt a plug from the location's own
  // Shelly cloud account, power windows + class-linked rules, a live
  // on/off toggle, run-now and a temporary timed override, plus 30 days
  // of kWh history. Same key, no new permission — one "device control"
  // grant covers every piece of studio hardware. Role defaults are
  // UNCHANGED. The bundle layer widened with it: `device_control` is
  // now owned by bundle_marketing OR bundle_operations
  // (shared/permission-bundles.js + mig 564), because plugs and
  // speakers are an operations concern as much as a marketing one.
  // The hint keeps SONOSMOB.2's Web:/Mobile: split — this string renders
  // in LocationFeatures, AdminFeatureMatrix and StaffForm, so an admin
  // revoking the key has to be able to see that they are also taking the
  // phone's Studio music screen away, not just the web schedulers.
  { key: 'device_control', label: 'Device control',
    hint: 'Sonos speakers and Shelly smart plugs. Web: playback and power schedules, adopt/remove, run-now, temporary overrides. Mobile: live Sonos play/pause, volume and favourites.' },
  // STUDIO-GROUP.1 — sidebar regroup (May 2026): the four items
  // below used to be top-level sidebar entries gated to master/
  // owner via role-only checks (no per-user permission). They now
  // live as children of the expandable Studio Management section
  // in the sidebar, and each gets its own per-user permission so
  // operators can grant access individually. Defaults mirror the
  // old role gates: contracts + tv_displays were owner/master,
  // glofox_import + preferences_import were master-only.
  { key: 'contracts',          label: '… Contracts',             hint: 'Digital staff/contractor contracts. Issue, sign, revoke. Owner + master by default.' },
  { key: 'tv_displays',        label: '… TV Displays',           hint: 'Register and push content to studio TVs via UC Cast Pro. Owner/master/manager by default — marketing surface.' },
  { key: 'presentations',      label: '… Presentations',         hint: 'Run a slide deck across multiple screens from a laptop (workshops / events). Upload slide images, open a public viewer link per screen, advance from a presenter remote. Owner/master/manager/head_coach by default.' },
  { key: 'glofox_import',      label: '… Glofox import',         hint: 'Interactive Glofox member import + sync history. Master-only by default — touches every contact at the location.' },
  { key: 'preferences_import', label: '… Preferences import',    hint: 'Bulk import of marketing preferences from external platforms (Mailchimp / Klaviyo / CSV). Master-only by default — touches consent state across the contact base.' },
  // — Revenue —
  // Mig 092 split: orders used to inherit `events|car_processing`
  // OR via the sidebar. Standalone key lets a location hide /orders
  // even if they have race events or car processing on.
  { key: 'orders',     label: 'Orders',                          hint: 'Unified revenue view across race signups + car deposits (mig 085). Refund + retry-recovery flows live here.' },
  { key: 'car_processing', label: 'Car Processing',             hint: 'Tesla import tracker (CCF Autos). Off by default at user level — enable per user.' },
  // SPEND.P3 — company-card receipts. Permission gates SUBMISSION (who
  // holds a company card). Approval stays owner/master like the other
  // spend types; it rides the existing bookkeeper → Xero queue.
  { key: 'card_receipts', label: 'Company-card receipts',       hint: 'Submit a receipt for a purchase made on a company card (one per purchase, photo or PDF). Permission-gated to card holders; owner/master approves, then it rides the bookkeeper → Xero queue like every other spend type. Default master + owner + manager.' },
  // INVOICES.1 — Dext-style email-in inbox for supplier invoices.
  // Master + owner only by default. Finance surface; doesn't fit
  // under Studio Management because it's about supplier bills not
  // on-site operations.
  { key: 'invoices_inbox', label: 'Invoices',                   hint: 'Operator inbox for supplier invoices emailed in to <slug>-invoices@mail.un1tdublin.com. Quality + data approval before forwarding to Xero. Master + owner only by default.' },
  // RCOV.P0 — receipt-coverage board. Cross-references Xero bank
  // lines against collected receipts (contractor invoices, FTE
  // expenses, card receipts) to find bank activity with no matching
  // receipt on file. Weekly Friday pull + report email; desktop-only
  // bookkeeping surface (see WEB_ONLY_OK in
  // scripts/check-mobile-parity.mjs). Master + owner only by default —
  // same tier as invoices_inbox.
  {
    key: 'accounting_hub',
    label: 'Accounting hub',
    hint: 'Receipt-coverage board at /accounting — unreconciled Xero bank lines vs collected receipts, weekly Friday pull + report email. Master + owner only by default.'
  },
  // APPROVALS.1 — central approvals dashboard. Aggregates everything
  // awaiting the operator's review: contractor invoices, FTE
  // expense claims, time-off, swap requests, and any future
  // approval surfaces. Master + owner + manager by default; head
  // coach + staff don't approve anything so it's off for them.
  { key: 'approvals_inbox', label: 'Approvals',                 locationGateOnly: true,
    hint: 'Central inbox aggregating contractor invoices, FTE expenses, time-off and swap requests awaiting your review. Visible to anyone holding at least one per-category approval permission below.' },
  // APPROVALS-PERCAT.1 — per-category approval grants. Each maps 1:1 to an
  // approvals provider (src/lib/approvals/registry.js) and gates BOTH the
  // inbox tab and that category's source approve/decline route. `group`
  // renders them under an "Approvals" subsection in the grant editors;
  // they are NOT location-gated (see isFeatureGatedByLocation) — the
  // approvals_inbox feature card governs the aggregator only.
  { key: 'approvals_contractor_invoices', group: 'approvals', label: '… Contractor invoices', hint: 'Approve or decline contractor invoices. Owner + master by default.' },
  { key: 'approvals_fte_expenses',        group: 'approvals', label: '… Employee expenses',    hint: 'Approve or decline FTE expense claims. Owner + master by default.' },
  { key: 'approvals_agent_requests',      group: 'approvals', label: '… Agent requests',       hint: 'Approve or decline customer-agent requests (pause / cancel / booking drafts). Manager + head coach + owner + master by default.' },
  { key: 'approvals_time_off',            group: 'approvals', label: '… Time off',             hint: 'Approve or reject staff time-off requests. Manager + head coach + owner + master by default.' },
  { key: 'approvals_shift_swaps',         group: 'approvals', label: '… Shift swaps',          hint: 'Approve shift-swap requests. Manager + head coach + owner + master by default.' },
  { key: 'approvals_rosters',             group: 'approvals', label: '… Roster approvals',     hint: 'Approve over-budget draft rosters. Owner + master by default.' },
  { key: 'approvals_hyrox_sessions',      group: 'approvals', label: '… Hyrox sessions',       hint: 'Review and approve AI-generated Hyrox Training Club sessions before they publish to the studio TV.' },
  { key: 'approvals_offer_purchases',     group: 'approvals', label: '… Offer sales',          hint: 'See paid sale-offer purchases and mark them fulfilled once the member is set up in Glofox. Manager + head coach + owner + master by default.' },
  // AUTOMATIONS-HUB.1 — operator surface for toggling per-location
  // automations (e.g. auto-creating new leads in Glofox). Web-only;
  // no mobile counterpart (operator/admin surface only). Master +
  // owner + manager by default.
  { key: 'automations', label: 'Automations',                   hint: 'Operational-automation hub at /automations — toggle per-location automations like auto-creating new leads in Glofox. Master + owner + manager by default.' },
  // ENGAGEMENT-CHALLENGES — operator CRUD for member challenges
  // (individual or collective goals tracked against HR/class metrics).
  // Web-only operator surface: create/edit/delete challenges at
  // /challenges. No mobile counterpart — challenge *viewing* is in
  // the champ app (member-facing). Master + owner + manager by default.
  { key: 'challenges', label: 'Challenges' },
  // REPORT-ISSUE.2 — owner / master inbox for staff-reported
  // issues at the location. The submit + own-history surface
  // (REPORT-ISSUE.1) is open to all staff; THIS key gates the
  // handler inbox + claim/resolve actions. Master + owner only by
  // default per the "All owners at the studio" routing decision.
  { key: 'issues_inbox', label: 'Issues',                       hint: 'Handler inbox for staff-reported issues at the studio (broken kit, cleaning, safety). Master + owner only by default; the submitter surface is open to all staff.' },
  // EMAIL-TICKET.2 — the studio email inbox. NOT the same as `email`, which
  // gates marketing/campaign email. Two levels, like approvals_inbox: this key
  // gates the surface, and a row in email_mailbox_access (mig 485) gates each
  // individual account within it. Holding this key alone shows nothing — a
  // studio with no mailboxes, or a person with no grants, gets no inbox.
  { key: 'email_inbox', label: 'Mail',
    hint: 'Ticketed inbox for the studio email accounts (accounts@, sales@, studio@). Access to each individual account is granted separately per person. Master + owner + manager by default.' },
  // EQUIP-MAINT.1 — equipment maintenance. Two keys, deliberately
  // split: `equipment_admin` is the setup surface (register, types,
  // intervals, inspection weekday) and is owner + master only;
  // `equipment_inspect` is doing the walk-round and is universal, the
  // same way `issues` submission is open to all staff.
  { key: 'equipment_admin',   label: 'Equipment setup',      hint: 'Manage the equipment register, define equipment types with their inspection checklists and intervals, and set the studio inspection day. Owner + master only by default.' },
  { key: 'equipment_inspect', label: 'Equipment inspections', hint: 'See what equipment is due for inspection and complete the checklist. Universal by default — turning this OFF removes a person’s ability to run inspections.' },
  // FLEET-CMD.1 — remote actions on the studio Raspberry Pis. Two keys,
  // split by BLAST RADIUS rather than seniority, the same way
  // equipment_admin/equipment_inspect splits setup from the walk-round.
  //
  // `fleet_restart` covers the actions that cannot break anything: restart
  // the kiosk browser (5s, the launcher relaunches it) and read logs. It is
  // on for anyone on shift because the person who notices a frozen
  // leaderboard is a coach standing in the room, and the alternative is
  // messaging Richard and waiting for a laptop.
  //
  // `fleet_admin` covers what can strand a device — reboot, shutdown (which
  // needs a physical trip to undo; a Pi has no usable wake-on-LAN over WiFi)
  // and redeploying the bridge service. Owner + master only.
  { key: 'fleet_restart', label: 'Studio devices — restart', hint: 'Restart a frozen TV/kiosk browser and read device logs. Safe by design: the worst outcome is a screen blinking. On by default for anyone on shift.' },
  { key: 'fleet_admin',   label: 'Studio devices — power',   hint: 'Reboot or shut down a studio Raspberry Pi and redeploy the HR bridge. Shutdown requires someone to physically power-cycle the device afterwards. Owner + master only by default.' },
  // INVOICES-QUEUE.1 (mig 185) — bookkeeper flag. Gates the
  // analyse + send-to-Xero actions inside /invoices and unlocks a
  // dedicated Bookkeeper queue tab in /approvals. Owners can still
  // SEE the inbox via invoices_inbox (audit); only bookkeepers can
  // ACT on it. Defaults: master ON, everyone else OFF — operator
  // grants per-user via StaffForm for month-end coverage.
  { key: 'bookkeeper', label: 'Bookkeeper (accountant sign-off)', hint: 'Grants the final-sign-off step inside /invoices: run Claude Vision analysis on queued items and send approved invoices to Xero. Owners approve at the source feature (FTE expenses, contractor invoices); bookkeepers approve at the queue. Default master only — grant temporarily to a senior manager for month-end cover and remove again.' },
  // — Infra —
  // PERSON-LINK.1 — non-destructive identity linking. Gates the
  // link/unlink/set-primary API so only authorised staff can group
  // duplicate contacts into a person. Desktop-only contact-admin
  // action (like contact merge). Owner + manager + head_coach by
  // default; staff off.
  { key: 'contact_linking', label: 'Link duplicate contacts', hint: 'Non-destructive identity linking — group duplicate contacts into a single person view without merging or deleting.' },
  // CONSULTATIONS SP1 — coach/web surface for tracking member consultations
  // and goals. Gates the consultations + goals CRUD APIs and the contact-page
  // Consultations tab. Staff off by default (coach/owner surface); mobile
  // equivalent is the champ app member portal (SP3), not the staff mobile app.
  { key: 'consultations', label: 'Consultations', hint: 'Create and edit member consultations and goals. Coach/web surface — the member-facing equivalent is the champ app (SP3).' },
  { key: 'settings',   label: 'Settings & Staff Management',    hint: 'Location settings, staff management, integrations, branding.' },
  // Landing-page editor (mig 126-130, Phase LP1-3c). Operator
  // editor for the public /welcome marketing page (un1tdublin.com).
  // Owners + master by default — managers/head-coaches/staff don't
  // touch marketing copy. Default-on at the location level so
  // existing locations keep working unchanged; operators can flip
  // it off per location via Location Settings if they don't run
  // marketing for that studio (e.g. CCF Autos).
  { key: 'landing_page', label: 'Landing page editor',          hint: 'Edit the public marketing page at /welcome. Includes WYSIWYG editor + sidebar settings form.' },
  // ZOOMOPS.1 — operator controls for the Zoom Phone contact sync at
  // /settings/integrations/zoom-contacts (run history, the report of
  // contacts the sync can't use, and preview / run / guard-override
  // buttons). Deliberately NOT checked for a preview (dry: true) — a
  // preview writes nothing to Zoom, so it's open to anyone who can reach
  // the settings page. Running the sync for real, and especially
  // overriding its deletion guard, can add or remove thousands of
  // entries from the shared company phone directory, so both of those
  // are gated on this key. Owner + master by default. Web-only (see
  // WEB_ONLY_OK in scripts/check-mobile-parity.mjs) — the destructive
  // controls need a confirmation dialog the mobile app has no home for.
  { key: 'integrations_zoom_manage', label: 'Manage the Zoom phone directory sync', hint: 'Run the Zoom Phone contact sync for real, and override its deletion guard. Preview is open to anyone who can reach the settings page; running and the guard override are owner + master only.' },
])

// APPROVALS-PERCAT.1 — provider key → per-category permission key. The
// single definition of the category↔permission relationship, consumed by
// the registry (tab gating) and each source route (approve-ability).
export const APPROVAL_CATEGORY_PERMISSION = Object.freeze({
  contractor_invoices: 'approvals_contractor_invoices',
  fte_expenses: 'approvals_fte_expenses',
  agent_requests: 'approvals_agent_requests',
  time_off: 'approvals_time_off',
  shift_swaps: 'approvals_shift_swaps',
  rosters: 'approvals_rosters',
  hyrox_sessions: 'approvals_hyrox_sessions',
  offer_purchases: 'approvals_offer_purchases',
})

// Ordered list of the six per-category permission keys (matches
// APPROVAL_CATEGORY_PERMISSION values). Used to derive approvals_inbox
// visibility (holds ≥1) and to exempt them from the location gate.
export const APPROVAL_SUBPERMISSION_KEYS = Object.freeze(
  Object.values(APPROVAL_CATEGORY_PERMISSION)
)

// BUNDLES.5 final-review fix 1 — the reverse of APPROVAL_CATEGORY_PERMISSION
// (permission key → category), derived from that SAME single definition
// rather than re-deriving it (e.g. stripping an 'approvals_' prefix) so
// the two can never drift. Used by isFeatureEnabledAtLocation below to
// look up which shared/permission-bundles.js CATEGORY_BUNDLES entry an
// approvals_* key's bundle-denial should follow.
const APPROVAL_PERMISSION_CATEGORY = Object.freeze(
  Object.fromEntries(Object.entries(APPROVAL_CATEGORY_PERMISSION).map(([category, key]) => [key, category]))
)

export const DEFAULT_WEB_PERMISSIONS_BY_ROLE = Object.freeze({
  // Platform super-admin (mig 033) — every web feature on by default.
  // hasPermission() also short-circuits to true for master regardless
  // of these values, so this map is mainly here for completeness +
  // the parity / shared-permissions tests that iterate every role.
  master: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: true, dashboard_ads: true,
    pipeline: true, contacts: true, activities: true,
    churn_radar: true,
    lead_radar: true,
    engagement_analytics: true,
    pulse_admin: true,
    events: true, bookings: true, races: true,
    // EMAIL-TICKET.2 — email_inbox is deliberately coarse: it only gates
    // the inbox surface. The real control is the per-account grant in
    // email_mailbox_access (mig 485) — holding this key alone shows
    // nothing until a studio has a mailbox and the person has a grant
    // on it, the same two-level shape as approvals_inbox.
    email: true, email_inbox: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: true, assistant: true, studio_management: true, class_timer: true,
    device_control: true,
    // Studio Management children (STUDIO-GROUP.1) — master has all.
    contracts: true, tv_displays: true, glofox_import: true, preferences_import: true,
    presentations: true,
    orders: true, car_processing: true,
    card_receipts: true,
    invoices_inbox: true,
    accounting_hub: true,
    approvals_contractor_invoices: true, approvals_fte_expenses: true, approvals_agent_requests: true,
    approvals_time_off: true, approvals_shift_swaps: true, approvals_rosters: true, approvals_hyrox_sessions: true,
    approvals_offer_purchases: true,
    automations: true,
    challenges: true,
    issues_inbox: true,
    equipment_admin: true, equipment_inspect: true,
    fleet_restart: true, fleet_admin: true,
    bookkeeper: true,
    contact_linking: true,
    consultations: true,
    settings: true,
    landing_page: true,
    integrations_zoom_manage: true,
  },
  staff: {
    dashboard_personal: true, dashboard_studio: false, dashboard_business: false, dashboard_ads: false,
    pipeline: true, contacts: true, activities: true,
    churn_radar: false,                            // retention oversight — not a staff surface
    lead_radar: false,                             // acquisition oversight — not a staff surface
    engagement_analytics: false,                   // retention analytics — not a staff surface
    pulse_admin: false,                            // Pulse operator hub — retention oversight, not a staff surface
    events: true, bookings: true, races: true,    // race-day starts/finishes are a front-of-house duty
    email: false, email_inbox: false, whatsapp: false, sms: false,
    schedule: true, attendance_reports: false, assistant: false, studio_management: false, class_timer: true,
    device_control: false,                         // on-site device control — not a staff surface
    // Studio Management children — all off for staff.
    contracts: false, tv_displays: false, glofox_import: false, preferences_import: false,
    presentations: false,
    orders: false, car_processing: false,         // financial views off by default
    card_receipts: false,                          // card holders only — grant per user
    invoices_inbox: false,                         // supplier-invoice approval is finance, not staff
    accounting_hub: false,                         // bookkeeping oversight — master + owner only
    approvals_contractor_invoices: false, approvals_fte_expenses: false, approvals_agent_requests: false,
    approvals_time_off: false, approvals_shift_swaps: false, approvals_rosters: false, approvals_hyrox_sessions: false,  // staff don't approve anything
    approvals_offer_purchases: false,
    automations: false,                             // operator surface — not a staff concern
    challenges: false,                              // operator challenge admin — not a staff concern
    issues_inbox: false,                            // staff submit; owner + master handle
    equipment_admin: false, equipment_inspect: true, // setup is owner + master; anyone on shift runs a walk-round
    fleet_restart: true, fleet_admin: false,   // a coach on shift can restart a frozen board; nothing destructive
    bookkeeper: false,                              // accountant sign-off — never the default
    contact_linking: false,                         // admin-level contact dedup action
    consultations: false,                            // coach/web surface — off for staff
    settings: false,
    landing_page: false,                          // marketing copy isn't a staff concern
    integrations_zoom_manage: false,               // owner + master only — destructive directory writes
  },
  // Reception (2026-07) — front-of-house desk role. Staff-level
  // access plus the WhatsApp inbox (answering member messages is a
  // front-desk duty). Deliberately NO oversight/finance/marketing
  // surfaces; operators tune per location via the Roles tab
  // (Settings → location → Roles), so these code defaults stay lean.
  reception: {
    dashboard_personal: true, dashboard_studio: false, dashboard_business: false, dashboard_ads: false,
    pipeline: true, contacts: true, activities: true,
    churn_radar: false,
    lead_radar: false,
    engagement_analytics: false,
    pulse_admin: false,
    events: true, bookings: true, races: true,       // front desk runs the booking desk
    email: false, email_inbox: false, whatsapp: true, sms: false,        // WhatsApp inbox is the front-desk channel
    schedule: true, attendance_reports: false, assistant: false, studio_management: false, class_timer: true,
    device_control: false,
    contracts: false, tv_displays: false, glofox_import: false, preferences_import: false,
    presentations: false,
    orders: false, car_processing: false,
    card_receipts: false,
    invoices_inbox: false,
    accounting_hub: false,                         // bookkeeping oversight — master + owner only
    approvals_contractor_invoices: false, approvals_fte_expenses: false, approvals_agent_requests: false,
    approvals_time_off: false, approvals_shift_swaps: false, approvals_rosters: false, approvals_hyrox_sessions: false,
    approvals_offer_purchases: false,
    automations: false,
    challenges: false,
    issues_inbox: false,
    equipment_admin: false, equipment_inspect: true, // front-of-house is on shift too
    fleet_restart: true, fleet_admin: false,   // front-of-house stands next to the TVs
    bookkeeper: false,
    contact_linking: false,
    consultations: false,
    settings: false,
    landing_page: false,
    integrations_zoom_manage: false,               // owner + master only — destructive directory writes
  },
  head_coach: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false, dashboard_ads: false,
    pipeline: true, contacts: true, activities: true,
    churn_radar: true,                             // head coaches own member retention
    lead_radar: true,                              // head coaches own lead/trial conversion
    engagement_analytics: true,                    // retention analytics — head coaches own retention
    pulse_admin: true,                             // Pulse operator hub — head coaches own retention
    events: true, bookings: true, races: true,
    email: true, email_inbox: false, whatsapp: true, sms: true,
    schedule: true, attendance_reports: false,    // head coaches don't see attendance — owner/manager only
    assistant: true, studio_management: false,    // explicit opt-in
    class_timer: true,                             // running the class timer is a coaching duty
    device_control: false,                         // owner + manager by default; grant per-user
    // Studio Management children — all off for head_coach (explicit opt-in by admin).
    contracts: false, tv_displays: false, glofox_import: false, preferences_import: false,
    presentations: true,
    orders: false, car_processing: false,         // head coach doesn't need orders by default
    card_receipts: false,                          // card holders only — grant per user
    invoices_inbox: false,
    accounting_hub: false,                         // bookkeeping oversight — master + owner only
    approvals_contractor_invoices: false, approvals_fte_expenses: false, approvals_agent_requests: true,
    approvals_time_off: true, approvals_shift_swaps: true, approvals_rosters: false, approvals_hyrox_sessions: true,  // head coach approves schedule items only
    approvals_offer_purchases: true,               // head coach can fulfil a sale from the floor
    automations: false,                             // operator surface — head coach doesn't manage automations
    challenges: false,                              // operator challenge admin — head coach doesn't create challenges
    issues_inbox: false,                            // owner + master only by default
    equipment_admin: false, equipment_inspect: true,
    fleet_restart: true, fleet_admin: false,
    bookkeeper: false,
    contact_linking: true,
    consultations: true,
    settings: false,
    landing_page: false,
    integrations_zoom_manage: false,               // owner + master only — destructive directory writes
  },
  manager: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false, dashboard_ads: true,
    pipeline: true, contacts: true, activities: true,
    churn_radar: false,                            // owner + head_coach by default; grant per-user if needed
    lead_radar: false,                             // owner + head_coach by default; grant per-user if needed
    engagement_analytics: true,                    // managers track engagement / retention by default
    pulse_admin: true,                             // managers run the Pulse operator hub
    events: true, bookings: true, races: true,
    email: true, email_inbox: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: true, assistant: true, studio_management: true, class_timer: true,
    device_control: true,                          // managers run on-site device control
    // Studio Management children — manager gets TV displays (marketing
    // surface they handle day-to-day). Contracts + imports stay
    // off — those are owner/master decisions.
    contracts: false, tv_displays: true, glofox_import: false, preferences_import: false,
    presentations: true,
    orders: true, car_processing: false,          // managers run revenue ops; CCF Autos is per-user opt-in
    card_receipts: true,                           // managers commonly hold a company card
    invoices_inbox: false,                         // manager isn't an approver — owner/master only
    accounting_hub: false,                         // bookkeeping oversight — master + owner only
    approvals_contractor_invoices: false, approvals_fte_expenses: false, approvals_agent_requests: true,
    approvals_time_off: true, approvals_shift_swaps: true, approvals_rosters: false, approvals_hyrox_sessions: true,  // managers approve schedule items (time-off, swaps)
    approvals_offer_purchases: true,               // managers fulfil sale purchases in Glofox
    automations: true,                              // managers can toggle per-location automations
    challenges: true,                               // managers can create/edit challenges
    issues_inbox: false,                            // owner + master only by default
    equipment_admin: false, equipment_inspect: true,
    fleet_restart: true, fleet_admin: false,   // reboot/shutdown can strand a device — owner + master only
    bookkeeper: false,                              // grant temporarily for month-end cover if needed
    contact_linking: true,
    consultations: true,
    settings: true,
    landing_page: false,                          // owner/master decision; per-user override available
    integrations_zoom_manage: false,               // owner + master only — destructive directory writes
  },
  owner: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: true, dashboard_ads: true,
    pipeline: true, contacts: true, activities: true,
    churn_radar: true,
    lead_radar: true,
    engagement_analytics: true,
    pulse_admin: true,
    events: true, bookings: true, races: true,
    email: true, email_inbox: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: true, assistant: true, studio_management: true, class_timer: true,
    device_control: true,
    // Studio Management children — owner gets contracts + TV displays
    // by default (mirroring the old role-only gates). Imports stay
    // master-only on first install; owners can opt-in per user.
    contracts: true, tv_displays: true, glofox_import: false, preferences_import: false,
    presentations: true,
    orders: true, car_processing: false,          // OFF for owner too — explicit opt-in per profile
    card_receipts: true,                           // owners hold a company card
    invoices_inbox: true,                          // owner approves their location's supplier invoices
    accounting_hub: true,                          // owner reviews receipt coverage, same tier as invoices_inbox
    approvals_contractor_invoices: true, approvals_fte_expenses: true, approvals_agent_requests: true,
    approvals_time_off: true, approvals_shift_swaps: true, approvals_rosters: true, approvals_hyrox_sessions: true,  // owner approves invoices, expenses, schedule items
    approvals_offer_purchases: true,
    automations: true,                              // owner manages per-location automations
    challenges: true,                               // owner manages member challenges
    issues_inbox: true,                             // owner IS the handler per the routing design
    equipment_admin: true, equipment_inspect: true, // owner owns the register + schedule
    fleet_restart: true, fleet_admin: true,    // owner owns the hardware at their location
    bookkeeper: false,                              // owner approves at the source; accountant sign-off is master/dedicated only
    contact_linking: true,
    consultations: true,
    settings: true,
    landing_page: true,
    integrations_zoom_manage: true,
  },
})

// ============================================================
// Mobile (iOS app) feature toggles
//
// Stored under profiles.permissions.mobile.<key>. Read by the iOS
// app on login via /api/mobile/me. Missing keys are treated as "off"
// by the app (deny-by-default) so adding a new feature here doesn't
// auto-enable it for existing users.
//
// Notification keys (notify_<category>) are silenced when the master
// `push_notifications` flag is off — see src/lib/push.js for the
// server-side enforcement.
// ============================================================

export const MOBILE_PERMISSIONS = Object.freeze([
  { key: 'schedule',           label: 'Schedule',                 hint: 'View shifts, request time off, swap requests',                 webEquivalent: 'schedule' },
  { key: 'pipeline',           label: 'Pipeline & Deals',         hint: 'Move deals, log calls, see new leads',                          webEquivalent: 'pipeline' },
  // W1 — searchable member directory + contact lookup on mobile (read).
  // Mirrors the web contacts list (webEquivalent links them for the
  // parity linter, dropping contacts from WEB_ONLY_OK). Defaults on for
  // every role, same as web — front-of-house staff look members up too.
  { key: 'contacts',           label: 'Contacts',                 hint: 'Search the member directory and open a contact to call / message them. Read-only on mobile; editing stays on web.', webEquivalent: 'contacts' },
  { key: 'whatsapp',           label: 'WhatsApp Inbox',           hint: 'Reply to inbound WhatsApp messages on the go',                  webEquivalent: 'whatsapp' },
  // MOBILE-ASSISTANT.1 (P2-8) — the in-app AI assistant chat on mobile,
  // mirroring the web /assistant bubble. Buffered (non-streaming) path
  // first; streaming is a fast-follow. webEquivalent links it to the web
  // `assistant` key for the parity linter, so `assistant` drops out of
  // WEB_ONLY_OK now that the mobile screen ships. Defaults mirror the web
  // assistant role defaults exactly (master/owner/manager on, head_coach
  // explicit opt-in on, staff off).
  { key: 'assistant',          label: 'AI Assistant',             hint: 'Chat with the in-app assistant — navigate the CRM and ask questions. Mirrors the web assistant.', webEquivalent: 'assistant' },
  // MOBILE-CONTACT-SEND.1 — ad-hoc one-to-one send from the mobile
  // contact card, via the platform's linked service (Twilio / Postmark)
  // so the message comes from the company, not the staffer's personal
  // phone. These gate the SMS / Email buttons; WhatsApp reuses the
  // `whatsapp` key above. webEquivalent links them to the web sms / email
  // keys for the parity linter — dropping both from WEB_ONLY_OK, since the
  // ad-hoc single-contact send is no longer web-only (broadcasts /
  // campaign editor stay desktop-only and keep their web gating).
  { key: 'sms',                label: 'SMS (send to a contact)',  hint: 'Text a contact from the company Twilio sender, not your phone. Broadcasts/sequences stay on web.', webEquivalent: 'sms' },
  { key: 'email',              label: 'Email (send to a contact)', hint: 'Email a contact from the company Postmark sender, not your phone. The campaign editor stays on web.', webEquivalent: 'email' },
  // STUDIO-HUB.1 — TV displays on the mobile Studio hub. View the
  // location's registered TVs + what each is currently showing, copy the
  // cast URL, and clear a TV back to idle. Content authoring (templates /
  // image upload) stays on web. webEquivalent links it to the web
  // tv_displays key, dropping it from WEB_ONLY_OK. Master/owner/manager by
  // default (mirrors the web tv_displays role defaults).
  { key: 'tv_displays',        label: 'TV Displays',              hint: 'View studio TVs + what each is showing, copy the cast URL, clear a TV. Authoring (templates / uploads) stays on web.', webEquivalent: 'tv_displays' },
  // HYROX-MOBILE — the Hyrox Training Club planner on the phone. Review,
  // approve / send back, regenerate and push a class session to the studio TV.
  // Mirrors the web /admin/hyrox planner; webEquivalent links it to the web
  // approvals_hyrox_sessions key for the parity linter.
  { key: 'hyrox',              label: 'Hyrox Training Club',      hint: 'Review, approve, regenerate and push AI-designed Hyrox class sessions to the studio TV from your phone. Mirrors the web Hyrox planner.', webEquivalent: 'approvals_hyrox_sessions' },
  // NOTIF.2: mobile mirror of the web 'activities' feature (Tasks tab).
  // Different name from the web key because 'tasks' reads better on a
  // small screen — the parity linter uses webEquivalent='activities'
  // to match them up.
  { key: 'tasks',              label: 'Tasks',                    hint: 'View and complete tasks assigned to you',                      webEquivalent: 'activities' },
  // NOTIF.2: mobile mirror of the web 'bookings' feature. Operator
  // view — today + tomorrow's bookings at the active location. New
  // bookings still get created on the web (Calendly hub).
  { key: 'bookings',           label: 'Bookings (today/tomorrow)', hint: "Operator view of today's and tomorrow's bookings",            webEquivalent: 'bookings' },
  { key: 'time_off',           label: 'Time Off Requests',        hint: 'Submit and view leave requests (the mobile Request-time-off button + form). Distinct from `schedule`, which only shows the roster.',  webEquivalent: 'schedule' },
  // MOBILE-RADAR — read-only glance mirrors of the web radars. The
  // full triage dashboards (scoring, win-back, quarantine/cleanup)
  // stay desktop-only; mobile gets a headline-numbers + weekly-trend
  // view reached from the More tab. Separate .mobile toggle so an
  // operator can grant the phone glance independently of the desktop
  // dashboard. Owner + head_coach by default, mirroring the web
  // churn_radar / lead_radar permissions; webEquivalent links them
  // for the parity linter.
  { key: 'churn_radar',        label: 'Churn Radar (glance)',     hint: 'Read-only at-risk member summary — counts + weekly trend. Triage stays on web.', webEquivalent: 'churn_radar' },
  { key: 'lead_radar',         label: 'Lead Radar (glance)',      hint: 'Read-only lead funnel summary — counts + weekly trend. Triage stays on web.',    webEquivalent: 'lead_radar' },
  // MOBILE-PERMS — personal / self-service surfaces that previously had
  // NO per-user toggle (gated only by employment_type, or universal-by-
  // design). Each now has an admin toggle so a studio can hide it per
  // user. All default ON for every role, so existing behaviour is
  // unchanged until an admin opts a user out. mobileOnly — the web
  // equivalents (invoices_inbox / issues_inbox / contracts admin) are
  // the *approver/admin* surfaces, a different capability, so these
  // don't map 1:1 to a web sidebar key.
  { key: 'invoices',   label: 'Invoices (own submissions)',  hint: 'Contractor self-service — photograph + submit your own invoices. Only shown to contractor-type staff; this toggle can hide it per user. Default on.', mobileOnly: true },
  { key: 'expenses',   label: 'Expenses (own receipts)',     hint: 'FTE self-service — capture + submit your own expense receipts. Only shown to FTE staff; this toggle can hide it per user. Default on.', mobileOnly: true },
  // SPEND.P3 — company-card receipt capture (+ owner/master approve) on
  // mobile, mirroring the web card_receipts key (webEquivalent links them
  // for the parity linter). Gates the capture screen for card holders;
  // the approve/decline routes enforce owner-at-location / master.
  { key: 'card_receipts', label: 'Company-card receipts',    hint: 'Photograph + submit a receipt for a company-card purchase. Card holders only; owners + master also approve here. Master + owner + manager by default.', webEquivalent: 'card_receipts' },
  { key: 'issues',     label: 'Report a Problem',            hint: 'Submit studio issues (broken kit, cleaning, safety) + view your own reports. Universal by default — turning this OFF removes a person’s ability to flag problems from the app, so leave on unless you have a reason.', mobileOnly: true },
  { key: 'contracts',  label: 'Your Contracts',              hint: 'Browse + sign your own staff/contractor contracts. Default on. (A pending-contract signing prompt still appears regardless, so a required signature is never blocked.)', mobileOnly: true },
  { key: 'policies',   label: 'Policies',                    hint: 'Read studio HR policies + acknowledge new ones. Default on.', mobileOnly: true },
  // MOBILE-APPROVALS — manager inbox mirroring the web /approvals dashboard.
  // webEquivalent links it to the web approvals_inbox key for the parity linter
  // (which lets us drop approvals_inbox from WEB_ONLY_OK). The tile is gated by
  // this permission; per-category approve rights stay enforced by the routes
  // (managers: time-off/swaps; owners/master: + expenses/invoices).
  { key: 'approvals',  label: 'Approvals inbox',             hint: 'Manager queue — approve/decline pending time-off, swaps, FTE expenses and contractor invoices at the active location.', webEquivalent: 'approvals_inbox' },
  // STAFF-C3 — the staff & access management surface on mobile (directory
  // + role/permissions editors). Mirrors the staff-management half of the
  // web `settings` permission; webEquivalent links them for the parity
  // linter (so `settings` drops out of WEB_ONLY_OK). This key gates
  // whether the Staff surface is *visible*; edit capability stays
  // owner/master-gated inside the editors, so manager defaults to a
  // read-only directory.
  { key: 'staff_management', label: 'Staff management',       hint: 'See the staff directory and member details. Editing roles, permissions and door access stays owner/master. Master + owner + manager by default.', webEquivalent: 'settings' },
  // W1 — handler inbox for staff-reported issues (claim / resolve /
  // close on the go). Mirrors the web issues_inbox (webEquivalent links
  // them for the parity linter, so issues_inbox drops out of WEB_ONLY_OK).
  // Master + owner only — matches the isHandler gate on every triage route.
  { key: 'issue_triage', label: 'Issue inbox',                hint: 'Triage staff-reported issues at the studio — claim, resolve and close them. Master + owner only (the submit + own-history surface stays open to all staff).', webEquivalent: 'issues_inbox' },
  // EQUIP-MAINT.1 — the walk-round itself. This is where the work
  // actually happens: staff on the floor tapping through due kit.
  // webEquivalent links it to the web key for the parity linter.
  { key: 'equipment_inspect', label: 'Equipment inspections', hint: 'See what equipment is due for inspection today and complete the checklist, reporting faults with photos.', webEquivalent: 'equipment_inspect' },
  // W2 — supplier/contractor-invoice approver inbox (review + approve /
  // decline) on mobile, mirroring the web invoices_inbox. Master + owner
  // only — the approve/decline routes enforce owner-at-location / master.
  // The contractor SUBMIT side already ships (the `invoices` key).
  { key: 'invoices_inbox', label: 'Invoices inbox',           hint: 'Review and approve or decline invoices at the active studio. Master + owner only; the submit side stays on the contractor Invoices tab.', webEquivalent: 'invoices_inbox' },
  // W2 — read-only revenue view (race signups + car deposits) on mobile,
  // mirroring the web Orders. Master + owner + manager by default (the
  // route gate is MANAGER_ROLES + hasPermission('orders')); refund + retry
  // stay desktop-only.
  { key: 'orders', label: 'Orders',                           hint: 'Revenue view across race signups + car deposits at the active studio (read-only on mobile). Master + owner + manager by default.', webEquivalent: 'orders' },
  // W2 — CCF Autos car-import tracker (read-only on mobile: list + car
  // detail). Off by default for everyone except master — enable per user,
  // same as the web car_processing. Heavy actions (deposit link, Xero,
  // uploads, status changes) stay desktop.
  { key: 'car_processing', label: 'Car processing',           hint: 'Tesla import tracker (CCF Autos) — read-only on mobile. Off by default; enable per user.', webEquivalent: 'car_processing' },
  // W3 — trackside race-day control (start / finish / reset runners) on
  // mobile/tablet, mirroring the web RaceControlPanel. Manager+ by default:
  // the race LIST route (GET /api/races) is MANAGER_ROLES, and that's the
  // mobile entry point. The board + actions re-check the races feature
  // server-side. Race event authoring stays on the web.
  { key: 'races', label: 'Race-day control',                  hint: 'Trackside race-day control (start / finish / reset runners) on mobile. Manager+ by default; race event authoring stays on the web.', webEquivalent: 'races' },
  // Mig 093: door_unlock was promoted to a cross-platform key
  // named `studio_management` (lives in WEB_PERMISSIONS, top-level
  // on profiles.permissions — same shape as dashboard_*). Both
  // web sidebar AND the mobile app read it from the same key.
  // Removed from MOBILE_PERMISSIONS so it's not double-listed in
  // the StaffForm picker.
  { key: 'push_notifications', label: 'Push Notifications',       hint: 'Master switch — turn off to silence everything',                mobileOnly: true },
  { key: 'notify_time_off',    label: '… Time-off decisions',     hint: 'Notify on approval/decline of own requests',                    mobileOnly: true, isNotify: true },
  { key: 'notify_schedule',    label: '… Schedule published',     hint: 'Notify when a new week is published',                           mobileOnly: true, isNotify: true },
  { key: 'notify_swap',        label: '… Swap requests',          hint: 'Notify on inbound swap requests and responses',                 mobileOnly: true, isNotify: true },
  { key: 'notify_lead',        label: '… New leads assigned',     hint: 'Notify when a new contact is created at your location',         mobileOnly: true, isNotify: true },
  { key: 'notify_whatsapp',    label: '… WhatsApp messages',      hint: 'Notify on inbound WhatsApp (subject to inbox permission)',      mobileOnly: true, isNotify: true },
  { key: 'notify_instagram',   label: '… Instagram messages',     hint: 'Notify on inbound Instagram DMs (subject to inbox permission)', mobileOnly: true, isNotify: true },
  // EMAIL-INBOUND-PUSH.1 — recipients are already narrowed server-side to
  // people who could open the ticket (email_inbox at its location + a grant
  // on its mailbox, or elevated); this key is only the personal opt-out.
  { key: 'notify_email',       label: '… Email tickets',          hint: 'Notify when new inbound email lands in a mailbox you can open (subject to inbox permission)', mobileOnly: true, isNotify: true },
  { key: 'notify_agent_activity', label: '… Mia is handling a chat', hint: 'One quiet ping per active chat when the AI agent is handling a customer (subject to inbox permission)', mobileOnly: true, isNotify: true },
  // APPROVALS-STUDIO.1 — a customer approval landed in the queue (Mia
  // booking issue, /start funnel review, pause/cancel request). Fans out
  // to owner/manager (+masters); defaults on for approver roles only.
  { key: 'notify_agent_requests', label: '… Customer approval needed', hint: 'Notify when a customer request from Mia or the website needs a decision (approver roles by default)', mobileOnly: true, isNotify: true },
  // HOST-APPROVALS.1 — a host submitted an event for review on the events
  // platform. Approver roles only.
  { key: 'notify_host_event_review', label: '… Host event needs review', hint: 'Notify when an event host submits an event for review (approver roles by default)', mobileOnly: true, isNotify: true },
  // Contractor invoice events (mig 101). Approved + declined go to
  // the contractor; FTE staff don't have an invoice flow so the
  // toggles are still listed but default off for non-contractors.
  { key: 'notify_invoice_approved', label: '… Invoice approved',   hint: 'Notify when an invoice you submitted is approved',              mobileOnly: true, isNotify: true },
  { key: 'notify_invoice_declined', label: '… Invoice declined',   hint: 'Notify when an invoice you submitted needs adjustment',         mobileOnly: true, isNotify: true },
  // FTE expense claims (FTE-EXPENSES.1) — the expense mirror of the
  // contractor invoice toggles above. `submitted` fans out to the
  // approval queue (owners at the location + masters), so it defaults
  // on for master/owner/manager/head_coach and off for staff;
  // approved + declined go to the submitting FTE, so they default on
  // for every role (same as the invoice outcome toggles).
  { key: 'notify_expense_submitted', label: '… Expense submitted',  hint: 'Notify when an FTE at your studio submits an expense claim for approval (approver roles by default)', mobileOnly: true, isNotify: true },
  { key: 'notify_expense_approved',  label: '… Expense approved',   hint: 'Notify when an expense claim you submitted is approved',        mobileOnly: true, isNotify: true },
  { key: 'notify_expense_declined',  label: '… Expense declined',   hint: 'Notify when an expense claim you submitted needs adjustment',   mobileOnly: true, isNotify: true },
  // Partial-shift overrides (mig 099/100). Coach gets a push when a
  // manager adjusts their times — the schedule effectively shifted
  // out from under them, so a heads-up is high-value.
  { key: 'notify_shift_adjusted',   label: '… Shift adjusted',     hint: 'Notify when a manager changes the times on one of your shifts', mobileOnly: true, isNotify: true },
  // Digital contracts (mig 106). Recipient gets a push when a
  // master/owner issues them a contract for signature. Default-on
  // for every role because the prompt-to-sign flow depends on it.
  { key: 'notify_contract_issued',  label: '… Contract issued',    hint: 'Notify when UN1T issues you a contract that needs signing',     mobileOnly: true, isNotify: true },
  // NOTIF.1: lead-time reminders for tasks + bookings. The
  // send-push-reminders cron (every 5 min) sends two reminders
  // per item — one 24h ahead and one 1h ahead. Categories are
  // 'tasks' and 'bookings' — push.js gates on
  // permissions.mobile.notify_<category>.
  { key: 'notify_tasks',            label: '… Task reminders',     hint: 'Notify 24h and 1h before a task is due',                        mobileOnly: true, isNotify: true },
  { key: 'notify_bookings',         label: '… Booking reminders',  hint: 'Notify 24h and 1h before bookings at your location',            mobileOnly: true, isNotify: true },
  // CHECKLIST.3 — closer/opener accountability. Two flavours:
  // - notify_checklist_overdue: the coach themselves gets a heads-up
  //   when their shift ends with items still unticked. Default on
  //   for everyone — the rule's whole point is gentle accountability.
  // - notify_checklist_compliance: head coach + owner + master get a
  //   summary push when a coach at their location ends a shift with
  //   missed items. Default on for those roles only.
  { key: 'notify_checklist_overdue',    label: '… Checklist overdue',       hint: 'Heads-up at end of shift when your checklist has unticked items',                                                       mobileOnly: true, isNotify: true },
  { key: 'notify_checklist_compliance', label: '… Checklist compliance',    hint: 'Notify when a coach at your studio ends a shift with missed checklist items (head coach + owner only by default)',     mobileOnly: true, isNotify: true },
  // REPORT-ISSUE.2 — staff-submitted issue reports.
  // - submitted: handlers (owner + master at the location) get pinged
  //   when a new issue is reported. Default on for owner + master.
  // - resolved: the original submitter gets pinged when their report
  //   has been resolved. Default on for everyone (it's their own
  //   report; they want closure).
  { key: 'notify_issue_submitted',      label: '… Issue submitted',         hint: 'Notify when a staff member at your studio reports a problem (owner + master by default)',                              mobileOnly: true, isNotify: true },
  { key: 'notify_issue_resolved',       label: '… Issue resolved',          hint: 'Notify when an issue you reported has been resolved',                                                                   mobileOnly: true, isNotify: true },
  // EQUIP-MAINT.3 — inspection reminders. Registered here because an
  // UNREGISTERED category resolves FALSE for every role but master, so
  // an unregistered push reaches only whoever tested it and silently
  // nobody else (bit app_update and test within a day of each other).
  { key: 'notify_inspection_due',     label: '… Equipment inspections due', hint: 'Notify on your studio inspection day when equipment is due to be checked', mobileOnly: true, isNotify: true },
  { key: 'notify_inspection_overdue', label: '… Inspections not done',      hint: 'Notify owners when equipment was due for inspection and no one submitted it', mobileOnly: true, isNotify: true },
])

export const DEFAULT_MOBILE_PERMISSIONS_BY_ROLE = Object.freeze({
  // Platform super-admin (mig 033) — every mobile feature on. canMobile
  // also short-circuits true for master regardless of these values.
  master: {
    hyrox: true,
    schedule: true, pipeline: true, whatsapp: true, assistant: true,
    sms: true, email: true,
    tv_displays: true,
    contacts: true,
    tasks: true, bookings: true,
    time_off: true,
    approvals: true,
    staff_management: true,
    issue_triage: true,
    equipment_inspect: true,
    invoices_inbox: true,
    card_receipts: true,
    orders: true,
    car_processing: true,
    races: true,
    invoices: true, expenses: true, issues: true, contracts: true, policies: true,
    churn_radar: true, lead_radar: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true, notify_instagram: true, notify_email: true, notify_agent_activity: true,
    notify_agent_requests: true,
    notify_host_event_review: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_expense_submitted: true, notify_expense_approved: true, notify_expense_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
    notify_checklist_overdue: true, notify_checklist_compliance: true,
    notify_issue_submitted: true, notify_issue_resolved: true,
    notify_inspection_due: true, notify_inspection_overdue: true,
  },
  staff: {
    hyrox: false,
    schedule: true, pipeline: false, whatsapp: false, assistant: false,
    sms: false, email: false,
    tv_displays: false,
    contacts: true,
    // Coaches see tasks (they get assigned them) but not booking
    // reminders by default — those are for the on-shift operator,
    // surfaced through the manager/head_coach defaults below.
    tasks: true, bookings: false,
    time_off: true,
    approvals: false,
    staff_management: false,
    issue_triage: false,
    equipment_inspect: true,
    invoices_inbox: false,
    card_receipts: false,
    orders: false,
    car_processing: false,
    races: false,
    invoices: true, expenses: true, issues: true, contracts: true, policies: true,
    churn_radar: false, lead_radar: false,  // retention/acquisition oversight — not a staff surface
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: false, notify_whatsapp: false, notify_instagram: false, notify_email: false, notify_agent_activity: false,
    notify_agent_requests: false,
    notify_host_event_review: false,
    notify_invoice_approved: true, notify_invoice_declined: true,
    // Staff submit expenses — outcomes on, but not the approval-queue
    // ping (they aren't approvers).
    notify_expense_submitted: false, notify_expense_approved: true, notify_expense_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: false,
    // Staff get the 'you missed items' push but NOT the compliance
    // roll-up (which is operator-oversight, not personal).
    notify_checklist_overdue: true, notify_checklist_compliance: false,
    // Staff don't handle issue reports — only get resolved on their
    // own reports.
    notify_issue_submitted: false, notify_issue_resolved: true,
    notify_inspection_due: true, notify_inspection_overdue: false,
  },
  // Reception — staff-level mobile access + the WhatsApp inbox and
  // the operator bookings view (today/tomorrow is the desk's core
  // screen). Notification defaults follow: WhatsApp + booking
  // reminders on; everything oversight/approval stays off.
  reception: {
    hyrox: false,
    schedule: true, pipeline: false, whatsapp: true, assistant: false,
    sms: false, email: false,
    tv_displays: false,
    contacts: true,
    tasks: true, bookings: true,
    time_off: true,
    approvals: false,
    staff_management: false,
    issue_triage: false,
    equipment_inspect: true,
    invoices_inbox: false,
    card_receipts: false,
    orders: false,
    car_processing: false,
    races: false,
    invoices: true, expenses: true, issues: true, contracts: true, policies: true,
    churn_radar: false, lead_radar: false,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: false, notify_whatsapp: true, notify_instagram: false, notify_email: false, notify_agent_activity: true,
    notify_agent_requests: false,
    notify_host_event_review: false,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_expense_submitted: false, notify_expense_approved: true, notify_expense_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
    notify_checklist_overdue: true, notify_checklist_compliance: false,
    notify_issue_submitted: false, notify_issue_resolved: true,
    notify_inspection_due: true, notify_inspection_overdue: false,
  },
  head_coach: {
    hyrox: true,
    schedule: true, pipeline: true, whatsapp: true, assistant: true,    // explicit opt-in, mirrors web
    sms: true, email: true,
    tv_displays: false,
    contacts: true,
    tasks: true, bookings: true,
    time_off: true,
    approvals: true,
    staff_management: false,
    issue_triage: false,
    equipment_inspect: true,
    invoices_inbox: false,
    card_receipts: false,
    orders: false,
    car_processing: false,
    races: true,
    invoices: true, expenses: true, issues: true, contracts: true, policies: true,
    churn_radar: true, lead_radar: true,    // head coaches own retention + conversion
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true, notify_instagram: true, notify_email: false, notify_agent_activity: true,
    notify_agent_requests: true,
    notify_host_event_review: false,
    notify_invoice_approved: true, notify_invoice_declined: true,
    // Approval-queue ping on by default (senior role covering the
    // studio); own-claim outcomes on like every role.
    notify_expense_submitted: true, notify_expense_approved: true, notify_expense_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
    // Head coach owns the floor — gets both the personal heads-up
    // (they're often on shift themselves) and the compliance summary.
    notify_checklist_overdue: true, notify_checklist_compliance: true,
    // Head coach isn't the issue handler by default (owner + master
    // routing) but can be granted via per-user opt-in.
    notify_issue_submitted: false, notify_issue_resolved: true,
    notify_inspection_due: true, notify_inspection_overdue: false,
  },
  manager: {
    hyrox: true,
    schedule: true, pipeline: true, whatsapp: true, assistant: true,
    sms: true, email: true,
    tv_displays: true,
    contacts: true,
    tasks: true, bookings: true,
    time_off: true,
    approvals: true,
    staff_management: true,
    issue_triage: false,
    equipment_inspect: true,
    invoices_inbox: false,
    card_receipts: true,
    orders: true,
    car_processing: false,
    races: true,
    invoices: true, expenses: true, issues: true, contracts: true, policies: true,
    churn_radar: false, lead_radar: false,  // owner + head_coach by default; grant per-user if needed
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true, notify_instagram: true, notify_email: true, notify_agent_activity: true,
    notify_agent_requests: true,
    notify_host_event_review: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    // Managers run the approval queue day-to-day — submitted ping on;
    // own-claim outcomes on (parity-superset of staff too).
    notify_expense_submitted: true, notify_expense_approved: true, notify_expense_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
    // Managers oversee front-of-house + sometimes work a shift —
    // get both the personal heads-up and the compliance summary.
    // Also required by the parity invariant (manager must be a
    // superset of staff; staff has notify_checklist_overdue on).
    notify_checklist_overdue: true, notify_checklist_compliance: true,
    // Manager isn't the issue handler by default (owner + master
    // routing) but resolved stays on (parity-superset of staff).
    notify_issue_submitted: false, notify_issue_resolved: true,
    notify_inspection_due: true, notify_inspection_overdue: false,
  },
  owner: {
    hyrox: true,
    schedule: true, pipeline: true, whatsapp: true, assistant: true,
    sms: true, email: true,
    tv_displays: true,
    contacts: true,
    tasks: true, bookings: true,
    time_off: true,
    approvals: true,
    staff_management: true,
    issue_triage: true,
    equipment_inspect: true,
    invoices_inbox: true,
    card_receipts: true,
    orders: true,
    car_processing: false,         // CCF Autos — per-user opt-in, matches web
    races: true,
    invoices: true, expenses: true, issues: true, contracts: true, policies: true,
    churn_radar: true, lead_radar: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true, notify_instagram: true, notify_email: true, notify_agent_activity: true,
    notify_agent_requests: true,
    notify_host_event_review: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    // Owner IS the expense approver (per the routes: owner-at-location
    // + master) — submitted ping on; own-claim outcomes on.
    notify_expense_submitted: true, notify_expense_approved: true, notify_expense_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
    // Owners get both — they get the compliance summary as
    // operators and the personal heads-up for the rare cases they
    // cover a shift. Can be opted out per-user. (Also avoids any
    // future owner-vs-manager superset invariant.)
    notify_checklist_overdue: true, notify_checklist_compliance: true,
    // Owner IS the issue handler by default (per the "all owners at
    // the studio" routing decision in REPORT-ISSUE.1).
    notify_issue_submitted: true, notify_issue_resolved: true,
    notify_inspection_due: true, notify_inspection_overdue: true,
  },
})

// ============================================================
// Editor hydration
//
// Single canonical hydration for the two permission editors —
// web StaffForm.jsx and mobile staff/permissions/[id].jsx. Turns
// a stored per-assignment blob into a FULL truthful blob for
// display + save: role defaults are merged UNDER the stored
// values, for both the flat web keys and the `.mobile` sub-object.
//
// Why merge-under (PR #754 Q1): resolvePermission (tier 3) and the
// push gate (src/lib/push.js — suppresses only an EXPLICIT false)
// both treat a MISSING key as "role default applies" / "send". A
// blob saved before a key existed therefore rendered as OFF in the
// editors (falsy read of a missing key) while the server behaved
// as the role default — a phantom "shows OFF but is ON". Hydrating
// missing keys from the CURRENT role's defaults makes the toggles
// show the effective state, and the next save writes the full
// explicit blob (explicit value == role default is behaviourally
// identical to missing for both resolvePermission and the push
// gate's defaulted-ON categories).
//
// Stored explicit values ALWAYS win — only genuinely-missing keys
// pick up the role default. Non-boolean extras riding on the blob
// (e.g. `mobile.lead_time_overrides`) are preserved by the spread.
// An empty/null blob (the "use role defaults" sentinel) hydrates
// to the role's full default blob. Unknown roles hydrate nothing
// (missing keys stay missing → toggles show OFF, matching
// resolvePermission's false for an unknown role).
//
// PERM-AUDIT.2: the optional third param is the operator-edited
// role template for this (location, role) — merged BETWEEN the code
// defaults and the stored per-user values, mirroring the resolver's
// tier order (code default < template < user override).
//
// @param {object|null|undefined} rawPermissions  stored profile_locations.permissions blob
// @param {string} role  the assignment's CURRENT per-location role
// @param {object|null|undefined} roleTemplate  location_role_permissions blob for (location, role)
// @returns {object} a full { ...web, mobile: { ...mobile } } blob
// ============================================================

export function hydratePermissions(rawPermissions, role, roleTemplate = null) {
  const web = DEFAULT_WEB_PERMISSIONS_BY_ROLE[role] || {}
  const mob = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role] || {}
  const raw = rawPermissions || {}
  const tpl = roleTemplate || {}
  return {
    ...web,
    ...stripMobile(tpl),
    ...stripMobile(raw),
    mobile: { ...mob, ...(tpl.mobile || {}), ...(raw.mobile || {}) },
  }
}

// Spread helper — the template/raw blobs carry a `mobile` sub-object
// that must not leak into the top-level web spread (a plain spread
// would overwrite the carefully-merged mobile object with whichever
// blob spread last).
function stripMobile(blob) {
  if (!blob || typeof blob !== 'object') return {}
  const { mobile: _mobile, ...rest } = blob
  return rest
}

// RECEPTION.2 — merge an employment-type variant template over the
// role's base ('all') template. Both are sparse blobs in the standard
// { ...webKeys, mobile: {...} } shape; the variant's keys win, and
// the mobile sub-objects merge rather than clobber. Null/undefined
// inputs are fine — merging two nulls yields null (no template),
// so callers can pass the result straight to resolvePermission /
// hydratePermissions without special-casing.
export function mergeTemplates(base, variant) {
  if (!base && !variant) return null
  const b = base || {}
  const v = variant || {}
  const merged = { ...stripMobile(b), ...stripMobile(v) }
  const mobile = { ...(b.mobile || {}), ...(v.mobile || {}) }
  if (Object.keys(mobile).length > 0) merged.mobile = mobile
  return merged
}

// Cross-platform dashboard keys — top-level on profiles.permissions,
// not nested under mobile.* . Listed here so the parity linter knows
// they're shared by design (no webEquivalent needed since they ARE
// the web equivalent of themselves). Kept as a named export for the
// mobile bundle's existing import; new code should reach for
// CROSS_PLATFORM_KEYS below which is the broader, future-friendly
// list.
export const CROSS_PLATFORM_DASHBOARD_KEYS = Object.freeze([
  'dashboard_personal',
  'dashboard_studio',
  'dashboard_business',
])

// Every cross-platform key. Mig 093 added `studio_management` —
// when adding more shared-by-design keys (e.g. `notifications`,
// `assistant`-on-mobile), add them here too. The parity linter
// uses this list to skip the "missing mobile counterpart" check
// for these keys.
export const CROSS_PLATFORM_KEYS = Object.freeze([
  ...CROSS_PLATFORM_DASHBOARD_KEYS,
  'studio_management',
  // CLASS-TIMER-PERM.1 — one toggle governs the web timer page and
  // the mobile timer screen, same shape as studio_management.
  'class_timer',
  // INV-M.1 — the mobile bookkeeper queue (app/invoices/queue.jsx:
  // bulk extract + the Not-in-Xero supplier flag) reads the SAME
  // top-level key the /api/invoices-inbox bulk routes enforce, so
  // one admin toggle governs both platforms. Field edits + the
  // send-to-Xero step stay web-only.
  'bookkeeper',
  // EMAIL-TICKET-M.1 — the mobile email surface now rides
  // /api/email/*, and EVERY one of those routes gates on the
  // top-level `email_inbox` key (hasPermission / hasPermissionForLocation
  // — they are service-role routes, so that check IS the gate). A
  // separate mobile-namespaced key would let the UI gate and the server
  // gate disagree in the worst direction: `.mobile.email_inbox` ON with
  // the web key OFF renders an inbox where every call 403s. Same
  // reasoning as `bookkeeper` above — the platform that enforces the key
  // decides which key it is. Per-account visibility is still the
  // email_mailbox_access grant, on both platforms.
  'email_inbox',
  // SONOSMOB.2 — live control of the studio Sonos (now-playing, transport,
  // volume, favourites) on mobile rides the SAME /api/sonos/* routes the
  // web strip calls, and every one of those gates on the top-level
  // `device_control` key. Same reasoning as `email_inbox` above: the
  // platform that enforces the key decides which key it is, or the UI
  // gate and the server gate can disagree. Scheduling (windows, run-now,
  // the pause override) stays web-only; the mobile screen is control only.
  'device_control',
])

// ============================================================
// Per-location feature gate
//
// Migration 032 added `locations.features` (JSONB). Owners flip
// individual feature keys to false on a per-location basis to
// disable that feature for everyone at that studio, regardless of
// per-user permissions or role defaults.
//
// Resolution: missing key OR explicit true → ENABLED at location;
//             explicit false                → DENIED at location.
//
// User-level notification preferences (notify_*) remain user-only
// even when the parent feature is enabled at location level — the
// owner shouldn't dictate which alerts a user wants. NOTIFY_KEYS
// is the set we exempt; isFeatureGatedByLocation() answers the
// gating question for any given key.
// ============================================================

export const NOTIFY_KEYS = Object.freeze(
  MOBILE_PERMISSIONS.filter(p => p.isNotify).map(p => p.key)
)

export function isFeatureGatedByLocation(key) {
  // Notification preferences are personal — never location-gated.
  if (NOTIFY_KEYS.includes(key)) return false
  // APPROVALS-PERCAT.1 — per-category approval grants are pure grants,
  // not location features; the approvals_inbox card is the only gate.
  // "Not location-gated" means exempt from THIS PER-KEY toggle only —
  // BUNDLES.5 final-review fix 1 makes isFeatureEnabledAtLocation below
  // apply a SEPARATE, category-level bundle check to these same keys,
  // so they're exempt from `features['approvals_x']` but NOT exempt
  // from the bundle layer as a whole. See that function's comment.
  if (APPROVAL_SUBPERMISSION_KEYS.includes(key)) return false
  return true
}

/**
 * Returns true iff this feature key is enabled at the given location
 * (or the location object is null/undefined — defensive default
 * matches "no location info → don't block").
 *
 * BUNDLES.5 — ANDs in the bundle layer (shared/permission-bundles.js)
 * on top of the existing individual-key check: a key is enabled only
 * if it isn't individually denied AND isn't denied by every bundle
 * that owns it. A key owned by zero bundles (core/exempt) is never
 * bundle-denied, so this is purely additive — see the polarity +
 * completeness tests in permission-bundles.test.js.
 *
 * BUNDLES.5 final-review fix 1 (the "Money chrome leak") — the 8
 * approvals_* per-category grants are exempt from isFeatureGatedByLocation
 * (a location can't deny "approvals_contractor_invoices" as an
 * individual key — see that function's comment) but that used to mean
 * they were ALSO fully exempt from the bundle layer, since this
 * function short-circuited to `true` before bundlesDenyKey was ever
 * consulted. Money's nav-items.js `anyPermission` union, the /money
 * redirect chain, (money)/layout.js's review tabs and /offer-sales all
 * gate on one of these three keys — so a senior role (owner default:
 * every one of those keys true) kept ALL of Money's chrome lit even at
 * `bundle_money: false`, because none of the checks ever reached
 * bundlesDenyKey. Fixed HERE, at the resolver's tier-1 root, rather than
 * at each call site: an approvals_* key stays exempt from its OWN
 * per-key toggle (features['approvals_contractor_invoices'] === false
 * still does nothing — the exemption above is unchanged) but now
 * follows its owning CATEGORY's bundle, via the exact same
 * CATEGORY_BUNDLES map + bundlesDenyCategory() the approvals registry
 * (src/lib/approvals/registry.js) already uses for Task 2 — so every
 * caller that routes through hasPermission/resolvePermission (nav
 * unions, the money chain, the tabs, the offer-sales page, AND the
 * registry) now agrees automatically. The registry's own
 * bundlesDenyCategory check becomes a harmless double-application of
 * this same rule for the providers that have a permissionKey — see the
 * comment on isProviderVisible() there.
 *
 * @param {{features?: object} | null | undefined} location
 * @param {string} key
 */
export function isFeatureEnabledAtLocation(location, key) {
  const features = location?.features || {}
  if (!isFeatureGatedByLocation(key)) {
    const category = APPROVAL_PERMISSION_CATEGORY[key]
    // Only approvals_* keys have a category to follow; NOTIFY_KEYS stay
    // fully exempt (category is undefined for them, bundlesDenyCategory
    // never denies an unmapped category).
    return !bundlesDenyCategory(features, category)
  }
  // Missing key OR explicit true → enabled.
  // Only an explicit `false` denies.
  return features[key] !== false && !bundlesDenyKey(features, key)
}

// ============================================================
// Canonical resolver
//
// Single canonical implementation of the tiered permission check.
// Both web (src/lib/permissions.js → hasPermission) and mobile
// (mobile/lib/permissions.js → canMobile + canDashboard) call this
// via thin platform-specific adapters so the tier ordering /
// semantics live in exactly one place.
//
// Tiers:
//   1.   LOCATION gate (mig 032). Notification keys are exempt
//        because per-user comms toggles are personal, not org-wide.
//   2.   PER-LOCATION USER override (mig 058). Caller passes the
//        already-namespaced permission bag (e.g. mobile callers
//        pass `permissions.mobile`, web passes `permissions`).
//   2.5  ROLE TEMPLATE (mig 364, PERM-AUDIT.2) — the operator-
//        edited per-(location, role) template. Sparse: only keys
//        the operator changed away from the code default exist.
//        Caller passes the already-namespaced bag, same convention
//        as tier 2 (mobile callers pass `roleTemplate.mobile`).
//   3.   ROLE code default. Caller passes the appropriate defaults
//        map (DEFAULT_WEB_PERMISSIONS_BY_ROLE or
//        DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).
//
// Master bypasses tiers 2, 2.5 and 3 once tier 1 passes — once the
// location says yes, master sees it without a per-user entry.
//
// The web `hasPermission` adds one extra rule on top: master gets
// the `settings` key even when the location says no, so a master
// always has a way back into the per-location feature toggles
// from the sidebar. That's a web-specific escape hatch and lives
// in the web adapter, not here.
// ============================================================

/**
 * Pure tiered resolver. Returns boolean.
 *
 * @param {object} args
 * @param {string} args.role                               'master' | 'owner' | 'manager' | 'head_coach' | 'staff' | …
 * @param {{features?: object} | null | undefined} args.location  Used for tier 1.
 * @param {object | null | undefined} args.permissions    Per-user overrides (already namespaced — mobile callers pass `permissions.mobile`, web passes top-level).
 * @param {object | null | undefined} args.roleTemplate   Operator-edited role template for THIS user's role at THIS location (mig 364). Already namespaced, same convention as `permissions`. Sparse — missing key falls through to the code default.
 * @param {object} args.defaults                          Role → key → boolean map. Pass DEFAULT_WEB_… or DEFAULT_MOBILE_… as appropriate.
 * @param {string} args.key
 * @returns {boolean}
 */
export function resolvePermission({ role, location, permissions, roleTemplate, defaults, key }) {
  // Tier 1: location gate. Applies to all roles including master.
  if (!isFeatureEnabledAtLocation(location, key)) return false
  // Master bypasses the per-user + role tiers — once the location
  // says yes, master sees it without needing role-default, template
  // or per-user permission entries.
  if (role === 'master') return true
  // Tier 2: per-location user override (mig 058). Explicit
  // true/false in the bag wins over the role layers below.
  if (permissions && typeof permissions === 'object' && key in permissions) {
    return permissions[key] === true
  }
  // Tier 2.5: operator-edited role template (mig 364). Explicit
  // true/false wins over the code default; missing key falls through.
  if (roleTemplate && typeof roleTemplate === 'object' && key in roleTemplate) {
    return roleTemplate[key] === true
  }
  // Tier 3: code role default at the active-location role.
  return defaults?.[role]?.[key] === true
}

// ============================================================
// AC-ROLE.1 — AC device allowlist resolution
//
// The set of AC units a user may operate resolves through the same
// tier order as resolvePermission: per-user override (mig 210,
// profile_locations.ac_device_ids) → role template (mig 379,
// location_role_permissions.ac_device_ids) → code default.
//
// Allowlist value semantics at every tier:
//   null  → not set, inherit the next tier
//   []    → explicit "none"
//   [ids] → exactly those device ids
// The code default supplies the "all" that manager/owner rely on
// (returned as the sentinel string 'ALL').
// ============================================================

export const DEFAULT_AC_ACCESS_BY_ROLE = Object.freeze({
  master: 'all',
  owner: 'all',
  manager: 'all',
  head_coach: 'none',
  staff: 'none',
  reception: 'none',
})

// Returns the sentinel 'ALL' or a concrete array of allowed ids.
export function resolveAcAllowlist({ role, userList, templateList, defaults = DEFAULT_AC_ACCESS_BY_ROLE }) {
  if (role === 'master') return 'ALL'
  if (Array.isArray(userList)) return userList        // tier 2: per-user override ([] = none)
  if (Array.isArray(templateList)) return templateList // tier 2.5: role template
  return defaults?.[role] === 'all' ? 'ALL' : []       // tier 3: code default
}

export function isAcDeviceAllowed(resolved, deviceId) {
  return resolved === 'ALL' || (Array.isArray(resolved) && resolved.includes(deviceId))
}

export function filterAcDevices(resolved, devices) {
  if (resolved === 'ALL') return devices
  const allowed = new Set(Array.isArray(resolved) ? resolved : [])
  return devices.filter((d) => allowed.has(d.id))
}

// Convenience exports — saves callers from doing array-to-set work.
export const WEB_PERMISSION_KEYS = Object.freeze(
  WEB_PERMISSIONS.map(p => p.key)
)
export const MOBILE_PERMISSION_KEYS = Object.freeze(
  MOBILE_PERMISSIONS.map(p => p.key)
)

// ============================================================
// Blob sanitiser (PERM-AUDIT.1)
//
// The staff-save routes used to accept any JSONB shape
// (z.record(z.string(), z.unknown())), so junk/stale keys could
// land in profile_locations.permissions (a pre-mig-092 `dashboard`
// key was found in prod). This is the single whitelist both save
// routes run the incoming blob through: known web keys with
// boolean values at top level, known mobile keys with boolean
// values under `.mobile`, plus the named non-boolean extras that
// legitimately ride on the mobile sub-object. Everything else is
// silently dropped — so a save also self-heals historical junk.
// ============================================================

// Non-permission extras stored on permissions.mobile by design:
// `layout` (per-user tab-bar arrangement) and `lead_time_overrides`
// (per-user reminder lead times). Add here if a new extra is ever
// introduced — anything unlisted is stripped on save.
export const MOBILE_BLOB_EXTRA_KEYS = Object.freeze([
  'layout',
  'lead_time_overrides',
])

// Sparse-diff helper (PERM-AUDIT.2) — reduce a FULL desired blob to
// only the keys that differ from a base blob (a hydrated role blob).
// This is what keeps the role-template layer (and, in PERM-AUDIT.3,
// the per-user layer) sparse: store the decision, inherit the rest.
//
// `includeExtras` controls whether the named non-boolean mobile
// extras (layout, lead_time_overrides) are carried across — true for
// per-user blobs (they live there by design), false for role
// templates (extras are personal, never role-level).
export function diffPermissionsBlob(fullBlob, baseBlob, { includeExtras = true } = {}) {
  const full = fullBlob || {}
  const base = baseBlob || {}
  const out = {}
  for (const key of WEB_PERMISSION_KEYS) {
    if (typeof full[key] === 'boolean' && full[key] !== (base[key] === true)) out[key] = full[key]
  }
  const fullMob = full.mobile || {}
  const baseMob = base.mobile || {}
  const mob = {}
  for (const key of MOBILE_PERMISSION_KEYS) {
    if (typeof fullMob[key] === 'boolean' && fullMob[key] !== (baseMob[key] === true)) mob[key] = fullMob[key]
  }
  if (includeExtras) {
    for (const extra of MOBILE_BLOB_EXTRA_KEYS) {
      if (extra in fullMob) mob[extra] = fullMob[extra]
    }
  }
  if (Object.keys(mob).length > 0) out.mobile = mob
  return out
}

export function sanitizePermissionsBlob(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of WEB_PERMISSION_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  const rawMobile = raw.mobile
  if (rawMobile && typeof rawMobile === 'object' && !Array.isArray(rawMobile)) {
    const mob = {}
    for (const key of MOBILE_PERMISSION_KEYS) {
      if (typeof rawMobile[key] === 'boolean') mob[key] = rawMobile[key]
    }
    for (const extra of MOBILE_BLOB_EXTRA_KEYS) {
      if (extra in rawMobile) mob[extra] = rawMobile[extra]
    }
    out.mobile = mob
  }
  return out
}

// ============================================================
// Default landing-page preference
//
// Stored under profiles.permissions.landing_preference. Honoured by
// /dashboard/page.js (web) and the Home tab segmented control
// (mobile/app/(staff)/(tabs)/dashboard.jsx). When unset OR set to 'auto' the
// existing role-based fallback applies (Business → Studio → Today
// for whichever the user has permission to see).
//
// 'personal' here matches the dashboard_personal permission key —
// kept short for storage and URL-friendliness. Same for studio and
// business.
//
// Validation: any value not in LANDING_PREFERENCE_VALUES is treated
// as 'auto' by the resolver (defensive). The /account form and the
// /api/me/preferences route both reject unknown values up front so
// junk never lands in the JSONB.
// ============================================================

export const LANDING_PREFERENCE_VALUES = Object.freeze([
  'auto', 'personal', 'studio', 'business',
])

export const LANDING_PREFERENCE_OPTIONS = Object.freeze([
  { value: 'auto',     label: 'Smart default',    hint: 'Lands on the most-aggregated dashboard you have access to (Business → Studio → Today)' },
  { value: 'personal', label: 'Today',            hint: 'Your shifts across all locations, swap requests, inbox', perm: 'dashboard_personal' },
  { value: 'studio',   label: 'Studio',           hint: 'Revenue KPI scorecard by location', perm: 'dashboard_studio' },
  { value: 'business', label: 'Business',         hint: 'Owner-level view for the active location',  perm: 'dashboard_business' },
])

// Map preference → { route, perm } used by the redirect logic.
export const LANDING_PREFERENCE_TARGETS = Object.freeze({
  personal: { route: '/dashboard/today',    perm: 'dashboard_personal' },
  studio:   { route: '/dashboard/studio',   perm: 'dashboard_studio'   },
  business: { route: '/dashboard/business', perm: 'dashboard_business' },
})

/**
 * Resolve a user's landing preference to a known value, or 'auto'.
 * Pure helper — no permission check; the caller is responsible for
 * verifying the user actually has the dashboard permission before
 * redirecting (see /dashboard/page.js).
 *
 * @param {{permissions?: object} | null | undefined} user
 * @returns {'auto'|'personal'|'studio'|'business'}
 */
export function resolveLandingPreference(user) {
  const raw = user?.permissions?.landing_preference
  if (typeof raw !== 'string') return 'auto'
  return LANDING_PREFERENCE_VALUES.includes(raw) ? raw : 'auto'
}
