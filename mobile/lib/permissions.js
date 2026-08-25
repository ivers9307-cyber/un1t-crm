// Mobile permissions helper.
//
// On the web, permissions.<key> controls sidebar visibility. On mobile,
// permissions.mobile.<key> controls tab/screen visibility — separate
// namespace so disabling something on the web doesn't accidentally
// disable it on mobile (and vice versa).
//
// Thin mobile-specific adapter around the canonical 3-tier resolver
// in shared/permissions.js. The tier ordering + master semantics
// live there so web and mobile can't drift; this file only specifies
// what's mobile-shaped:
//
//   • canMobile reads the per-user override from
//     `activeLocation.permissions.mobile[key]` (the .mobile namespace
//     scopes the toggle to phone/tablet only).
//   • canDashboard reads from `activeLocation.permissions[key]` (top
//     level — these three keys are intentionally cross-platform and
//     fall back to the web defaults map so a single admin toggle
//     covers both web and mobile dashboards).
//   • No `settings` escape hatch — mobile has no feature-toggle UI,
//     so the web's special-case for master + 'settings' isn't
//     needed here.
//
// The list of valid keys + their default-by-role values lives in
// shared/permissions (repo-root shared/, the web/mobile seam package)
// and is also imported by the web admin UI (StaffForm.jsx). Adding a
// new feature in that one file auto-flows here and to the parity
// linter (npm run check:mobile-parity).

import {
  MOBILE_PERMISSION_KEYS,
  CROSS_PLATFORM_KEYS,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  resolvePermission,
} from 'shared/permissions'

// ── SECURITY BOUNDARY NOTE (MOBILE-AUDIT.5) ─────────────────────────
// This resolver controls UI ONLY — which tabs/screens the app renders.
// It is NOT a security control: the app talks to Supabase with the
// public anon key + the user's JWT, so anyone could call the database
// directly regardless of what this hides. The actual enforcement lives
// in Row-Level Security. As of mig 218-219 the direct-CRUD tables
// (deals, activities, notes, bookings, whatsapp_*) are RLS-scoped by the
// SAME permission keys this file reads (via private.auth_mobile_can),
// so the data layer now backs these gates. When adding a new
// direct-Supabase screen, gate it here for UX AND confirm the table's
// RLS policy enforces the permission — do not rely on this file alone.
// ────────────────────────────────────────────────────────────────────

// Re-export the shared definitions so screens that need labels/hints
// (e.g. a future in-app notification preferences page) can import
// them from `../lib/permissions` instead of crossing the shared/
// boundary directly.
export {
  MOBILE_PERMISSIONS,
  MOBILE_PERMISSION_KEYS,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
  CROSS_PLATFORM_DASHBOARD_KEYS,
} from 'shared/permissions'

/**
 * @param {object|null|undefined} profile     The safe profile from /api/mobile/me
 * @param {string} key                         e.g. 'schedule', 'pipeline', 'whatsapp', 'notify_swap'
 * @param {object|null|undefined} activeLocation  From /api/mobile/me — has .features and .permissions
 * @returns {boolean}
 */
export function canMobile(profile, key, activeLocation = null) {
  if (!profile) return false
  // Cross-platform keys (e.g. studio_management — mig 093) live at the
  // TOP LEVEL of the permissions blob with the WEB defaults: one toggle
  // governs both web and mobile. They have NO entry in the .mobile
  // namespace or the mobile defaults map, so resolving them here would
  // always return false for non-master roles (master short-circuits) —
  // which is why a head_coach with studio_management ON for the web
  // sidebar still didn't get the mobile Studio tab. Route them to the
  // canonical top-level resolver instead.
  if (CROSS_PLATFORM_KEYS.includes(key)) {
    return canDashboard(profile, key, activeLocation)
  }
  // Mobile-only keys live under .mobile in the assignment's permissions
  // blob. Hand the canonical resolver the namespaced bag. roleTemplate
  // (PERM-AUDIT.2) is the operator-edited role template shipped on the
  // location payload by /api/mobile/me — sparse, tier 2.5.
  return resolvePermission({
    role: profile.role,
    location: activeLocation,
    permissions: activeLocation?.permissions?.mobile || null,
    roleTemplate: activeLocation?.roleTemplate?.mobile || null,
    defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
    key,
  })
}

/**
 * Returns true if any mobile-visible feature is enabled at the
 * user's active location. Used to decide whether to show the
 * empty-state "ask an admin" nudge on Home.
 *
 * Walks two key spaces:
 *
 *   1. The mobile-namespaced keys (.mobile.<key> in the assignment
 *      blob) via canMobile — anything that controls a bottom-tab
 *      or sub-screen on the iOS app.
 *
 *   2. EVERY cross-platform key (top-level on the assignment blob —
 *      no .mobile namespace) via canDashboard. That is the three
 *      dashboard tiers (personal / studio / business) that render on
 *      the DASHBOARD tab since HOME-LOC.7 (they were on the Home tab
 *      when this walk was written; the nudge below stayed on Home),
 *      AND the top-level keys that open a tab or
 *      sub-screen: studio_management, class_timer, bookkeeper,
 *      email_inbox, device_control. A master at a partial-features
 *      location can have every .mobile.* key off but still be
 *      entitled to a dashboard tier; a head coach can hold nothing
 *      but studio_management and still have a Studio tab in the bar.
 *      In both cases Home must render, not show the "mobile features
 *      off" empty state.
 *
 *      MOBILEFEAT.1 — this walk used to cover only the dashboard
 *      tiers. Every other cross-platform key was invisible to it, so
 *      a staff member whose sole entitlement was one of them saw the
 *      "ask an admin" nudge with a working tab sitting beside it.
 *      CROSS_PLATFORM_KEYS already includes the dashboard keys.
 *
 * Any tier-2 (per-user override) or tier-3 (role default) result
 * is honoured by the underlying resolver, so this gate flips
 * exactly when at least one of the user's visible surfaces would
 * actually render.
 */
export function hasAnyMobileFeature(profile, activeLocation = null) {
  if (!profile) return false
  if (MOBILE_PERMISSION_KEYS.some(k => canMobile(profile, k, activeLocation))) {
    return true
  }
  return CROSS_PLATFORM_KEYS.some(k => canDashboard(profile, k, activeLocation))
}

/**
 * Cross-platform dashboard permission check. The dashboard sub-views
 * (`dashboard_personal`, `dashboard_studio`, `dashboard_business`)
 * live at the TOP LEVEL of the per-location permissions blob (not
 * under .mobile), so a single admin toggle controls visibility on
 * both web and mobile. Use this instead of canMobile() for any of
 * those keys.
 *
 * Honours the location gate too — a dashboard turned off at the
 * active location is hidden for every user there.
 *
 * @param {object|null|undefined} profile
 * @param {string} key  one of dashboard_personal | dashboard_studio | dashboard_business
 * @param {object|null|undefined} activeLocation
 * @returns {boolean}
 */
export function canDashboard(profile, key, activeLocation = null) {
  if (!profile) return false
  // Dashboard sub-views live at the TOP level of the permissions
  // bag (no .mobile namespace) and fall back to the WEB defaults
  // map — a single admin toggle controls visibility on both web
  // and mobile dashboards.
  return resolvePermission({
    role: profile.role,
    location: activeLocation,
    permissions: activeLocation?.permissions || null,
    roleTemplate: activeLocation?.roleTemplate || null,
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
    key,
  })
}
