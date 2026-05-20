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
  { key: 'dashboard_studio',   label: 'Dashboard · Studio',    hint: 'Operational view — leads, members, approvals' },
  { key: 'dashboard_business', label: 'Dashboard · Business',  hint: 'Owner-level — pipeline, won deals, payroll' },
  // — CRM —
  { key: 'pipeline',   label: 'Pipeline & Deals' },
  { key: 'contacts',   label: 'Contacts' },
  { key: 'activities', label: 'Tasks',                          hint: 'Renamed from Activities (mig 073). Tasks-kind activities only — auto-logged events stay on the contact timeline.' },
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
  { key: 'glofox_import',      label: '… Glofox import',         hint: 'Interactive Glofox member import + sync history. Master-only by default — touches every contact at the location.' },
  { key: 'preferences_import', label: '… Preferences import',    hint: 'Bulk import of marketing preferences from external platforms (Mailchimp / Klaviyo / CSV). Master-only by default — touches consent state across the contact base.' },
  // — Revenue —
  // Mig 092 split: orders used to inherit `events|car_processing`
  // OR via the sidebar. Standalone key lets a location hide /orders
  // even if they have race events or car processing on.
  { key: 'orders',     label: 'Orders',                          hint: 'Unified revenue view across race signups + car deposits (mig 085). Refund + retry-recovery flows live here.' },
  { key: 'car_processing', label: 'Car Processing',             hint: 'Tesla import tracker (CCF Autos). Off by default at user level — enable per user.' },
  // INVOICES.1 — Dext-style email-in inbox for supplier invoices.
  // Master + owner only by default. Finance surface; doesn't fit
  // under Studio Management because it's about supplier bills not
  // on-site operations.
  { key: 'invoices_inbox', label: 'Invoices',                   hint: 'Operator inbox for supplier invoices emailed in to <slug>-invoices@un1tdublin.com. Quality + data approval before forwarding to Xero. Master + owner only by default.' },
  // APPROVALS.1 — central approvals dashboard. Aggregates everything
  // awaiting the operator's review: contractor invoices, FTE
  // expense claims, time-off, swap requests, and any future
  // approval surfaces. Master + owner + manager by default; head
  // coach + staff don't approve anything so it's off for them.
  { key: 'approvals_inbox', label: 'Approvals',                 hint: 'Central inbox aggregating contractor invoices, FTE expenses, time-off and swap requests awaiting your review. Master + owner + manager by default.' },
  // INVOICES-QUEUE.1 (mig 185) — bookkeeper flag. Gates the
  // analyse + send-to-Xero actions inside /invoices and unlocks a
  // dedicated Bookkeeper queue tab in /approvals. Owners can still
  // SEE the inbox via invoices_inbox (audit); only bookkeepers can
  // ACT on it. Defaults: master ON, everyone else OFF — operator
  // grants per-user via StaffForm for month-end coverage.
  { key: 'bookkeeper', label: 'Bookkeeper (accountant sign-off)', hint: 'Grants the final-sign-off step inside /invoices: run Claude Vision analysis on queued items and send approved invoices to Xero. Owners approve at the source feature (FTE expenses, contractor invoices); bookkeepers approve at the queue. Default master only — grant temporarily to a senior manager for month-end cover and remove again.' },
  // — Infra —
  { key: 'settings',   label: 'Settings & Staff Management',    hint: 'Location settings, staff management, integrations, branding.' },
  // Landing-page editor (mig 126-130, Phase LP1-3c). Operator
  // editor for the public /welcome marketing page (un1tdublin.com).
  // Owners + master by default — managers/head-coaches/staff don't
  // touch marketing copy. Default-on at the location level so
  // existing locations keep working unchanged; operators can flip
  // it off per location via Location Settings if they don't run
  // marketing for that studio (e.g. CCF Autos).
  { key: 'landing_page', label: 'Landing page editor',          hint: 'Edit the public marketing page at /welcome. Includes WYSIWYG editor + sidebar settings form.' },
])

export const DEFAULT_WEB_PERMISSIONS_BY_ROLE = Object.freeze({
  // Platform super-admin (mig 033) — every web feature on by default.
  // hasPermission() also short-circuits to true for master regardless
  // of these values, so this map is mainly here for completeness +
  // the parity / shared-permissions tests that iterate every role.
  master: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: true,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: true, assistant: true, studio_management: true,
    // Studio Management children (STUDIO-GROUP.1) — master has all.
    contracts: true, tv_displays: true, glofox_import: true, preferences_import: true,
    orders: true, car_processing: true,
    invoices_inbox: true,
    approvals_inbox: true,
    bookkeeper: true,
    settings: true,
    landing_page: true,
  },
  staff: {
    dashboard_personal: true, dashboard_studio: false, dashboard_business: false,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,    // race-day starts/finishes are a front-of-house duty
    email: false, whatsapp: false, sms: false,
    schedule: true, attendance_reports: false, assistant: false, studio_management: false,
    // Studio Management children — all off for staff.
    contracts: false, tv_displays: false, glofox_import: false, preferences_import: false,
    orders: false, car_processing: false,         // financial views off by default
    invoices_inbox: false,                         // supplier-invoice approval is finance, not staff
    approvals_inbox: false,                        // staff don't approve anything
    bookkeeper: false,                              // accountant sign-off — never the default
    settings: false,
    landing_page: false,                          // marketing copy isn't a staff concern
  },
  head_coach: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: false,    // head coaches don't see attendance — owner/manager only
    assistant: true, studio_management: false,    // explicit opt-in
    // Studio Management children — all off for head_coach (explicit opt-in by admin).
    contracts: false, tv_displays: false, glofox_import: false, preferences_import: false,
    orders: false, car_processing: false,         // head coach doesn't need orders by default
    invoices_inbox: false,
    approvals_inbox: false,                        // head coach isn't an approver by default
    bookkeeper: false,
    settings: false,
    landing_page: false,
  },
  manager: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: true, assistant: true, studio_management: true,
    // Studio Management children — manager gets TV displays (marketing
    // surface they handle day-to-day). Contracts + imports stay
    // off — those are owner/master decisions.
    contracts: false, tv_displays: true, glofox_import: false, preferences_import: false,
    orders: true, car_processing: false,          // managers run revenue ops; CCF Autos is per-user opt-in
    invoices_inbox: false,                         // manager isn't an approver — owner/master only
    approvals_inbox: true,                         // managers approve schedule items (time-off, swaps)
    bookkeeper: false,                              // grant temporarily for month-end cover if needed
    settings: true,
    landing_page: false,                          // owner/master decision; per-user override available
  },
  owner: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: true,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, attendance_reports: true, assistant: true, studio_management: true,
    // Studio Management children — owner gets contracts + TV displays
    // by default (mirroring the old role-only gates). Imports stay
    // master-only on first install; owners can opt-in per user.
    contracts: true, tv_displays: true, glofox_import: false, preferences_import: false,
    orders: true, car_processing: false,          // OFF for owner too — explicit opt-in per profile
    invoices_inbox: true,                          // owner approves their location's supplier invoices
    approvals_inbox: true,                         // owner approves invoices, expenses, schedule items
    bookkeeper: false,                              // owner approves at the source; accountant sign-off is master/dedicated only
    settings: true,
    landing_page: true,
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
  { key: 'whatsapp',           label: 'WhatsApp Inbox',           hint: 'Reply to inbound WhatsApp messages on the go',                  webEquivalent: 'whatsapp' },
  // NOTIF.2: mobile mirror of the web 'activities' feature (Tasks tab).
  // Different name from the web key because 'tasks' reads better on a
  // small screen — the parity linter uses webEquivalent='activities'
  // to match them up.
  { key: 'tasks',              label: 'Tasks',                    hint: 'View and complete tasks assigned to you',                      webEquivalent: 'activities' },
  // NOTIF.2: mobile mirror of the web 'bookings' feature. Operator
  // view — today + tomorrow's bookings at the active location. New
  // bookings still get created on the web (Calendly hub).
  { key: 'bookings',           label: 'Bookings (today/tomorrow)', hint: "Operator view of today's and tomorrow's bookings",            webEquivalent: 'bookings' },
  { key: 'time_off',           label: 'Time Off Requests',        hint: 'Submit and view leave requests',                                webEquivalent: 'schedule' },
  { key: 'assistant',          label: 'AI Assistant',             hint: 'Use the in-app assistant from mobile',                          webEquivalent: 'assistant' },
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
  // Contractor invoice events (mig 101). Approved + declined go to
  // the contractor; FTE staff don't have an invoice flow so the
  // toggles are still listed but default off for non-contractors.
  { key: 'notify_invoice_approved', label: '… Invoice approved',   hint: 'Notify when an invoice you submitted is approved',              mobileOnly: true, isNotify: true },
  { key: 'notify_invoice_declined', label: '… Invoice declined',   hint: 'Notify when an invoice you submitted needs adjustment',         mobileOnly: true, isNotify: true },
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
])

export const DEFAULT_MOBILE_PERMISSIONS_BY_ROLE = Object.freeze({
  // Platform super-admin (mig 033) — every mobile feature on. canMobile
  // also short-circuits true for master regardless of these values.
  master: {
    schedule: true, pipeline: true, whatsapp: true,
    tasks: true, bookings: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
  },
  staff: {
    schedule: true, pipeline: false, whatsapp: false,
    // Coaches see tasks (they get assigned them) but not booking
    // reminders by default — those are for the on-shift operator,
    // surfaced through the manager/head_coach defaults below.
    tasks: true, bookings: false,
    time_off: true, assistant: false,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: false, notify_whatsapp: false,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: false,
  },
  head_coach: {
    schedule: true, pipeline: true, whatsapp: true,
    tasks: true, bookings: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
  },
  manager: {
    schedule: true, pipeline: true, whatsapp: true,
    tasks: true, bookings: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
  },
  owner: {
    schedule: true, pipeline: true, whatsapp: true,
    tasks: true, bookings: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
    notify_contract_issued: true,
    notify_tasks: true, notify_bookings: true,
  },
})

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
  return !NOTIFY_KEYS.includes(key)
}

/**
 * Returns true iff this feature key is enabled at the given location
 * (or the location object is null/undefined — defensive default
 * matches "no location info → don't block").
 *
 * @param {{features?: object} | null | undefined} location
 * @param {string} key
 */
export function isFeatureEnabledAtLocation(location, key) {
  if (!isFeatureGatedByLocation(key)) return true
  const features = location?.features || {}
  // Missing key OR explicit true → enabled.
  // Only an explicit `false` denies.
  return features[key] !== false
}

// ============================================================
// Three-tier resolver
//
// Single canonical implementation of the 3-tier permission check.
// Both web (src/lib/permissions.js → hasPermission) and mobile
// (mobile/lib/permissions.js → canMobile + canDashboard) call this
// via thin platform-specific adapters so the tier ordering /
// semantics live in exactly one place.
//
// Tiers:
//   1. LOCATION gate (mig 032). Notification keys are exempt
//      because per-user comms toggles are personal, not org-wide.
//   2. PER-LOCATION USER override (mig 058). Caller passes the
//      already-namespaced permission bag (e.g. mobile callers
//      pass `permissions.mobile`, web passes `permissions`).
//   3. ROLE default. Caller passes the appropriate defaults map
//      (DEFAULT_WEB_PERMISSIONS_BY_ROLE or
//      DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).
//
// Master bypasses tiers 2+3 once tier 1 passes — once the
// location says yes, master sees it without a per-user entry.
//
// The web `hasPermission` adds one extra rule on top: master gets
// the `settings` key even when the location says no, so a master
// always has a way back into the per-location feature toggles
// from the sidebar. That's a web-specific escape hatch and lives
// in the web adapter, not here.
// ============================================================

/**
 * Pure 3-tier resolver. Returns boolean.
 *
 * @param {object} args
 * @param {string} args.role                               'master' | 'owner' | 'manager' | 'head_coach' | 'staff' | …
 * @param {{features?: object} | null | undefined} args.location  Used for tier 1.
 * @param {object | null | undefined} args.permissions    Per-user overrides (already namespaced — mobile callers pass `permissions.mobile`, web passes top-level).
 * @param {object} args.defaults                          Role → key → boolean map. Pass DEFAULT_WEB_… or DEFAULT_MOBILE_… as appropriate.
 * @param {string} args.key
 * @returns {boolean}
 */
export function resolvePermission({ role, location, permissions, defaults, key }) {
  // Tier 1: location gate. Applies to all roles including master.
  if (!isFeatureEnabledAtLocation(location, key)) return false
  // Master bypasses per-user permission tiers — once the location
  // says yes, master sees it without needing role-default or
  // per-user permission entries.
  if (role === 'master') return true
  // Tier 2: per-location user override (mig 058). Explicit
  // true/false in the bag wins over the role default.
  if (permissions && typeof permissions === 'object' && key in permissions) {
    return permissions[key] === true
  }
  // Tier 3: role default at the active-location role.
  return defaults?.[role]?.[key] === true
}

// Convenience exports — saves callers from doing array-to-set work.
export const WEB_PERMISSION_KEYS = Object.freeze(
  WEB_PERMISSIONS.map(p => p.key)
)
export const MOBILE_PERMISSION_KEYS = Object.freeze(
  MOBILE_PERMISSIONS.map(p => p.key)
)

// ============================================================
// Default landing-page preference
//
// Stored under profiles.permissions.landing_preference. Honoured by
// /dashboard/page.js (web) and the Home tab segmented control
// (mobile/app/(tabs)/index.jsx). When unset OR set to 'auto' the
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
  { value: 'studio',   label: 'Studio',           hint: 'Operational view for the active location', perm: 'dashboard_studio' },
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
