// NOTIF.3 — read + validate per-location notification_config (mig 170).
//
// `locations.notification_config` is a JSONB blob; every field is
// optional. This module knows the defaults and exposes
// `getEffectiveConfig(location)` for the cron and the UI.
//
// Keep this file PURE — it's imported by both the Next.js route
// handlers AND any future mobile-side use. No Supabase calls; the
// caller passes the location row in.

import { NOTIFICATION_REGISTRY, getNotificationCategory } from './notifications-registry.js'

// Tightest sensible bounds: lead times are stored as integer minutes,
// 5 min minimum (anything shorter would race the 5-min cron tick),
// 7 days maximum (after that we should call it a calendar event,
// not a reminder).
export const LEAD_TIME_MIN_MINUTES = 5
export const LEAD_TIME_MAX_MINUTES = 7 * 24 * 60

// Roles that are valid recipients of role-based pushes. Mirrors the
// MANAGER_ROLES list in shared/permissions.js plus 'staff' for
// locations that want everyone on duty to see booking reminders.
export const VALID_NOTIFY_ROLES = Object.freeze([
  'owner', 'manager', 'head_coach', 'staff',
])

/**
 * Default config — assembled from the registry's per-category
 * defaults so the registry stays the single source of truth.
 */
export const DEFAULT_NOTIFICATION_CONFIG = Object.freeze({
  categories: Object.freeze(
    NOTIFICATION_REGISTRY
      .filter(n => n.configurable.leadTimes || n.configurable.roles)
      .reduce((acc, n) => {
        const slice = {}
        if (n.configurable.leadTimes) {
          slice.lead_times_minutes = [...(n.defaults?.leadTimesMinutes || [])]
        }
        if (n.configurable.roles) {
          slice.notify_roles = [...(n.defaults?.notifyRoles || [])]
        }
        acc[n.category] = Object.freeze(slice)
        return acc
      }, {})
  ),
})

/**
 * Merge a location's stored config with the defaults so callers
 * never have to deal with missing keys. Returns a new object every
 * call — safe to mutate.
 *
 * @param {object|null} stored  locations.notification_config row
 * @returns {{categories: {tasks: {lead_times_minutes:number[]},
 *                        bookings: {lead_times_minutes:number[], notify_roles:string[]}}}}
 */
export function getEffectiveConfig(stored) {
  const out = { categories: {} }
  const cats = DEFAULT_NOTIFICATION_CONFIG.categories
  for (const [cat, def] of Object.entries(cats)) {
    const slice = stored?.categories?.[cat] || {}
    out.categories[cat] = {
      ...(def.lead_times_minutes !== undefined && {
        lead_times_minutes:
          Array.isArray(slice.lead_times_minutes) && slice.lead_times_minutes.length > 0
            ? [...slice.lead_times_minutes].sort((a, b) => a - b)
            : [...def.lead_times_minutes],
      }),
      ...(def.notify_roles !== undefined && {
        notify_roles:
          Array.isArray(slice.notify_roles) && slice.notify_roles.length > 0
            ? slice.notify_roles.filter(r => VALID_NOTIFY_ROLES.includes(r))
            : [...def.notify_roles],
      }),
    }
  }
  return out
}

/**
 * Lead times (in minutes) for a category at a location. Convenience
 * wrapper around getEffectiveConfig for callers that only care about
 * one category.
 */
export function getLeadTimes(stored, category) {
  return getEffectiveConfig(stored).categories?.[category]?.lead_times_minutes || []
}

/**
 * NOTIF.7 — per-user override resolution.
 *
 * Resolution order, most-specific first:
 *   1. The user's own `permissions.mobile.lead_time_overrides[category]`
 *      (set in StaffForm) — only used if it's a non-empty array.
 *   2. The location's `notification_config.categories[category]`
 *      (set in /settings/locations/<id>).
 *   3. The built-in default ([60, 1440]).
 *
 * The lead times must be valid per validateLeadTimes() — out-of-range
 * or non-integer values fall back to the next tier. This is
 * defensive: a user override written by an older client (or by hand
 * via SQL) won't crash the cron, it'll just be ignored.
 *
 * @param {object|null} locationConfig — locations.notification_config
 * @param {object|null} userMobilePerms — profiles.permissions.mobile
 * @param {'tasks'|'bookings'} category
 * @returns {number[]} sorted lead times in minutes
 */
export function getEffectiveLeadTimesForUser(locationConfig, userMobilePerms, category) {
  // Tier 1: user override
  const userOverride = userMobilePerms?.lead_time_overrides?.[category]?.lead_times_minutes
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    const cleaned = []
    for (const n of userOverride) {
      const num = Number(n)
      if (Number.isInteger(num)
          && num >= LEAD_TIME_MIN_MINUTES
          && num <= LEAD_TIME_MAX_MINUTES
          && !cleaned.includes(num)) {
        cleaned.push(num)
      }
    }
    if (cleaned.length > 0) return cleaned.sort((a, b) => a - b)
    // fall through to location default if user override was malformed
  }

  // Tier 2 + 3: location, then built-in default (getLeadTimes handles both)
  return getLeadTimes(locationConfig, category)
}

/**
 * Validate a per-user lead_time_overrides slice (the inner shape
 * stored under permissions.mobile.lead_time_overrides). Same rules
 * as validateConfig's category-level slice — keeps the two tiers
 * consistent for the operator.
 *
 * Input shape:
 *   { tasks?: { lead_times_minutes: [...] }, bookings?: { lead_times_minutes: [...] } }
 *
 * Returns { ok: true, value: <cleaned> | null } | { ok: false, errors }.
 * Empty / null value = "no override, use location default".
 */
export function validateUserLeadTimeOverrides(input) {
  if (input == null) return { ok: true, value: null }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { _root: 'Must be an object' } }
  }
  const errors = {}
  const out = {}
  for (const cat of ['tasks', 'bookings']) {
    const slice = input[cat]
    if (slice == null) continue
    if (typeof slice !== 'object' || Array.isArray(slice)) {
      errors[cat] = 'Must be an object'
      continue
    }
    if (slice.lead_times_minutes === undefined) continue
    const lt = slice.lead_times_minutes
    if (!Array.isArray(lt)) {
      errors[`${cat}.lead_times_minutes`] = 'Must be an array'
      continue
    }
    if (lt.length === 0) {
      // Empty array = "remove the override". Don't write it.
      continue
    }
    const cleaned = []
    let bad = null
    for (const n of lt) {
      const num = Number(n)
      if (!Number.isInteger(num) || num < LEAD_TIME_MIN_MINUTES || num > LEAD_TIME_MAX_MINUTES) {
        bad = num
        break
      }
      if (!cleaned.includes(num)) cleaned.push(num)
    }
    if (bad !== null) {
      errors[`${cat}.lead_times_minutes`] =
        `Each lead time must be an integer between ${LEAD_TIME_MIN_MINUTES} and ${LEAD_TIME_MAX_MINUTES} minutes (got ${bad})`
    } else {
      out[cat] = { lead_times_minutes: cleaned.sort((a, b) => a - b) }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (Object.keys(out).length === 0) return { ok: true, value: null }
  return { ok: true, value: out }
}

/**
 * Booking notify roles at a location.
 */
export function getBookingNotifyRoles(stored) {
  return getEffectiveConfig(stored).categories?.bookings?.notify_roles || []
}

/**
 * Validate a candidate config (from the PUT /api/locations/[id]/
 * notification-config endpoint). Returns { ok: true, value }
 * normalised, or { ok: false, errors: { 'categories.tasks.lead_times_minutes': '...' } }.
 *
 * - Unknown categories are dropped silently (forward-compat).
 * - Lead times outside [MIN, MAX] → error.
 * - Duplicate lead times → de-duped.
 * - Unknown roles → error.
 * - At least one lead time required (empty array = "no reminders"
 *   would silently disable; if you want that, turn the user's
 *   notify_<category> off instead).
 */
export function validateConfig(input) {
  const errors = {}
  const out = { categories: {} }

  if (input == null) return { ok: true, value: null }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { _root: 'Must be an object' } }
  }
  const cats = input.categories
  if (cats != null && (typeof cats !== 'object' || Array.isArray(cats))) {
    return { ok: false, errors: { categories: 'Must be an object' } }
  }
  if (!cats) return { ok: true, value: null }

  for (const [catKey, slice] of Object.entries(cats)) {
    const meta = getNotificationCategory(catKey)
    if (!meta) continue // forward-compat: unknown categories silently ignored
    if (slice == null) continue
    if (typeof slice !== 'object' || Array.isArray(slice)) {
      errors[`categories.${catKey}`] = 'Must be an object'
      continue
    }

    const catOut = {}

    if (meta.configurable.leadTimes && slice.lead_times_minutes !== undefined) {
      const lt = slice.lead_times_minutes
      if (!Array.isArray(lt)) {
        errors[`categories.${catKey}.lead_times_minutes`] = 'Must be an array'
      } else if (lt.length === 0) {
        errors[`categories.${catKey}.lead_times_minutes`] =
          'At least one lead time required (set notify toggle off to silence the category instead)'
      } else {
        const cleaned = []
        let bad = null
        for (const n of lt) {
          const num = Number(n)
          if (!Number.isInteger(num) || num < LEAD_TIME_MIN_MINUTES || num > LEAD_TIME_MAX_MINUTES) {
            bad = num
            break
          }
          if (!cleaned.includes(num)) cleaned.push(num)
        }
        if (bad !== null) {
          errors[`categories.${catKey}.lead_times_minutes`] =
            `Each lead time must be an integer between ${LEAD_TIME_MIN_MINUTES} and ${LEAD_TIME_MAX_MINUTES} minutes (got ${bad})`
        } else {
          catOut.lead_times_minutes = cleaned.sort((a, b) => a - b)
        }
      }
    }

    if (meta.configurable.roles && slice.notify_roles !== undefined) {
      const r = slice.notify_roles
      if (!Array.isArray(r)) {
        errors[`categories.${catKey}.notify_roles`] = 'Must be an array'
      } else if (r.length === 0) {
        errors[`categories.${catKey}.notify_roles`] =
          'At least one role required (no role = nobody receives the push)'
      } else {
        const cleaned = []
        let bad = null
        for (const role of r) {
          if (!VALID_NOTIFY_ROLES.includes(role)) { bad = role; break }
          if (!cleaned.includes(role)) cleaned.push(role)
        }
        if (bad !== null) {
          errors[`categories.${catKey}.notify_roles`] =
            `Unknown role: ${bad}. Valid: ${VALID_NOTIFY_ROLES.join(', ')}`
        } else {
          catOut.notify_roles = cleaned
        }
      }
    }

    if (Object.keys(catOut).length > 0) {
      out.categories[catKey] = catOut
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }
  // Empty after normalisation = treat as "default" (null).
  if (Object.keys(out.categories).length === 0) {
    return { ok: true, value: null }
  }
  return { ok: true, value: out }
}

/**
 * Pretty-print a lead-time list for the UI: [60, 1440] → "1h, 24h".
 */
export function formatLeadTimes(minutesList) {
  if (!Array.isArray(minutesList) || !minutesList.length) return '—'
  return minutesList
    .slice()
    .sort((a, b) => a - b)
    .map(formatLeadTime)
    .join(', ')
}

export function formatLeadTime(min) {
  if (!Number.isFinite(min)) return ''
  if (min < 60) return `${min}m`
  if (min % 1440 === 0) {
    const d = min / 1440
    return d === 1 ? '1d' : `${d}d`
  }
  if (min % 60 === 0) {
    const h = min / 60
    return `${h}h`
  }
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${h}h${m}m`
}
