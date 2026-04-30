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
export const WEB_PERMISSIONS = Object.freeze([
  { key: 'dashboard_personal', label: 'Dashboard · Today',     hint: 'Personal home view — your shifts, swaps, inbox' },
  { key: 'dashboard_studio',   label: 'Dashboard · Studio',    hint: 'Operational view — leads, members, approvals' },
  { key: 'dashboard_business', label: 'Dashboard · Business',  hint: 'Owner-level — pipeline, won deals, payroll' },
  { key: 'pipeline',   label: 'Pipeline & Deals' },
  { key: 'contacts',   label: 'Contacts' },
  { key: 'events',     label: 'Events' },
  { key: 'bookings',   label: 'Bookings' },
  { key: 'activities', label: 'Activities' },
  { key: 'email',      label: 'Email Marketing' },
  { key: 'whatsapp',   label: 'WhatsApp' },
  { key: 'schedule',   label: 'Schedule' },
  { key: 'assistant',  label: 'AI Assistant' },
  { key: 'settings',   label: 'Settings & Staff Management' },
])

export const DEFAULT_WEB_PERMISSIONS_BY_ROLE = Object.freeze({
  staff: {
    dashboard_personal: true, dashboard_studio: false, dashboard_business: false,
    pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: false, whatsapp: false, schedule: true, assistant: false, settings: false,
  },
  head_coach: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false,
    pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: true, whatsapp: true, schedule: true, assistant: true, settings: false,
  },
  manager: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: false,
    pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: true, whatsapp: true, schedule: true, assistant: true, settings: true,
  },
  owner: {
    dashboard_personal: true, dashboard_studio: true, dashboard_business: true,
    pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: true, whatsapp: true, schedule: true, assistant: true, settings: true,
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
  { key: 'door_unlock',        label: 'Door Unlock',              hint: 'Unlock UniFi-controlled doors from the phone',                  mobileOnly: true },
  { key: 'push_notifications', label: 'Push Notifications',       hint: 'Master switch — turn off to silence everything',                mobileOnly: true },
  { key: 'notify_time_off',    label: '… Time-off decisions',     hint: 'Notify on approval/decline of own requests',                    mobileOnly: true, isNotify: true },
  { key: 'notify_schedule',    label: '… Schedule published',     hint: 'Notify when a new week is published',                           mobileOnly: true, isNotify: true },
  { key: 'notify_swap',        label: '… Swap requests',          hint: 'Notify on inbound swap requests and responses',                 mobileOnly: true, isNotify: true },
  { key: 'notify_lead',        label: '… New leads assigned',     hint: 'Notify when a new contact is created at your location',         mobileOnly: true, isNotify: true },
  { key: 'notify_whatsapp',    label: '… WhatsApp messages',      hint: 'Notify on inbound WhatsApp (subject to inbox permission)',      mobileOnly: true, isNotify: true },
])

export const DEFAULT_MOBILE_PERMISSIONS_BY_ROLE = Object.freeze({
  staff: {
    schedule: true, pipeline: false, whatsapp: false,
    time_off: true, assistant: false, door_unlock: false,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: false, notify_whatsapp: false,
  },
  head_coach: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true, door_unlock: false,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
  },
  manager: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true, door_unlock: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
  },
  owner: {
    schedule: true, pipeline: true, whatsapp: true,
    time_off: true, assistant: true, door_unlock: true,
    push_notifications: true,
    notify_time_off: true, notify_schedule: true, notify_swap: true,
    notify_lead: true, notify_whatsapp: true,
  },
})

// Cross-platform dashboard keys — top-level on profiles.permissions,
// not nested under mobile.* . Listed here so the parity linter knows
// they're shared by design (no webEquivalent needed since they ARE
// the web equivalent of themselves).
export const CROSS_PLATFORM_DASHBOARD_KEYS = Object.freeze([
  'dashboard_personal',
  'dashboard_studio',
  'dashboard_business',
])

// Convenience exports — saves callers from doing array-to-set work.
export const WEB_PERMISSION_KEYS = Object.freeze(
  WEB_PERMISSIONS.map(p => p.key)
)
export const MOBILE_PERMISSION_KEYS = Object.freeze(
  MOBILE_PERMISSIONS.map(p => p.key)
)
