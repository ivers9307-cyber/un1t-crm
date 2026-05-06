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
  { key: 'assistant',         label: 'AI Assistant',            hint: 'In-app chat assistant with CRM tool use.' },
  // Mig 093 (Nov 2026): renamed from `door_unlock` (mobile-only)
  // to `studio_management` (cross-platform, top-level on
  // permissions). Both web sidebar AND mobile read this single
  // key. Surface today is remote door unlock via UniFi Access;
  // future studio-ops actions (alarm arm/disarm, camera live view,
  // etc.) will land under the same gate.
  { key: 'studio_management', label: 'Studio Management',       hint: 'Remote door unlock + future on-site operations. Requires UniFi Access configured for the location.' },
  // — Revenue —
  // Mig 092 split: orders used to inherit `events|car_processing`
  // OR via the sidebar. Standalone key lets a location hide /orders
  // even if they have race events or car processing on.
  { key: 'orders',     label: 'Orders',                          hint: 'Unified revenue view across race signups + car deposits (mig 085). Refund + retry-recovery flows live here.' },
  { key: 'car_processing', label: 'Car Processing',             hint: 'Tesla import tracker (CCF Autos). Off by default at user level — enable per user.' },
  // — Infra —
  { key: 'settings',   label: 'Settings & Staff Management',    hint: 'Location settings, staff management, integrations, branding.' },
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
    schedule: true, assistant: true, studio_management: true,
    orders: true, car_processing: true,
    settings: true,
  },
  staff: {
    dashboard_personal: true, dashboard_studio: false, dashboard_business: false,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,    // race-day starts/finishes are a front-of-house duty
    email: false, whatsapp: false, sms: false,
    schedule: true, assistant: false, studio_management: false,
    orders: false, car_processing: false,         // financial views off by default
    settings: false,
  },
  head_coach: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, assistant: true, studio_management: false, // explicit opt-in
    orders: false, car_processing: false,         // head coach doesn't need orders by default
    settings: false,
  },
  manager: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, assistant: true, studio_management: true,
    orders: true, car_processing: false,          // managers run revenue ops; CCF Autos is per-user opt-in
    settings: true,
  },
  owner: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: true,
    pipeline: true, contacts: true, activities: true,
    events: true, bookings: true, races: true,
    email: true, whatsapp: true, sms: true,
    schedule: true, assistant: true, studio_management: true,
    orders: true, car_processing: false,          // OFF for owner too — explicit opt-in per profile
    settings: true,
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
])

export const DEFAULT_MOBILE_PERMISSIONS_BY_ROLE = Object.freeze({
  // Platform super-admin (mig 033) — every mobile feature on. canMobile
  // also short-circuits true for master regardless of these values.
  master: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
  },
  staff: {
    schedule: true, pipeline: false, whatsapp: false,
    time_off: true, assistant: false,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: false, notify_whatsapp: false,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
  },
  head_coach: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
  },
  manager: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
  },
  owner: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
    notify_invoice_approved: true, notify_invoice_declined: true,
    notify_shift_adjusted: true,
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
