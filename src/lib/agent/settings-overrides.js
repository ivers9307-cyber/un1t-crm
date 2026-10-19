// MIAORG.1 Task 3 — which of a studio's Mia settings the STUDIO sets (its
// "overrides"), as opposed to inheriting them from the organisation layer or
// the code defaults (resolveAgentSettings, settings-resolve.js).
//
// Pure and zod-free on purpose: the studio editor (a client component) uses
// these helpers, and importing settings-contract.js there would ship zod to
// the browser. settings-contract.js re-exports the key lists from here, so
// there is still exactly one definition of each; settings-contract.test.js
// pins this catalogue against DEFAULTS and SettingsSchema so they cannot
// drift.
//
// An override PATH is one of:
//   * a top-level key, as-is:                 'tone'
//   * one field of an object key, dotted:     'followups.daily_cap'
//   * a whole object key (shorthand for every one of its fields): 'followups'
//   * a studio-only key: accepted, and changes nothing (those are always saved)

// Keys that belong to ONE studio and are never read from the organisation
// layer (resolveAgentSettings / mergeAgentSettings). An org-level
// `enabled: true` must never switch a studio on (enabled+test_mode is live
// for everyone), and the booking/membership/consultation links point at one
// studio's own systems. monthly_points_target (final review) is per studio
// too: a value in the org layer would start CRM tier pushes at every studio
// (live-class.js reads the resolved value), while champ-app reads the raw
// studio blob and would not see it, so the two would disagree.
export const STUDIO_ONLY_KEYS = new Set([
  'enabled',
  'test_mode',
  'test_phones',
  'consultation_event_type_id',
  'booking_mode',
  'cancellation_form',
  'booking_url',
  'booking_cta_label',
  'membership_signup_url',
  'membership_cta_label',
  'monthly_points_target',
])

// Object-valued keys that merge PER FIELD (org fields under studio fields)
// rather than the studio's object replacing the org's wholesale.
export const INHERITABLE_OBJECT_KEYS = ['limits', 'followups', 'first_class_checkin', 'inline_suggestion', 'quiet_hours']

// The fields of each object key (SettingsSchema's own; pinned by
// settings-contract.test.js).
export const INHERITABLE_OBJECT_FIELDS = Object.freeze({
  limits: Object.freeze(['max_replies_per_conversation_per_hour', 'max_replies_per_location_per_day']),
  followups: Object.freeze(['enabled', 'nudge_after_hours', 'template_name', 'daily_cap']),
  first_class_checkin: Object.freeze(['enabled', 'delay_hours', 'template_name', 'daily_cap']),
  inline_suggestion: Object.freeze(['enabled']),
  // MIAORG.1 Task 4 (T4-A) — `off` is studio-only IN EFFECT: a studio sets
  // `quiet_hours.off: true` to run with NO quiet hours whatever the
  // organisation says (null cannot say "none" once an org value exists). The
  // resolver ignores it at the org layer and the org editor refuses it.
  quiet_hours: Object.freeze(['start', 'end', 'tz', 'off']),
})

// Every other DEFAULTS key: a plain value the org may supply (pinned against
// DEFAULTS by settings-contract.test.js).
export const INHERITABLE_SCALAR_KEYS = Object.freeze([
  'tone',
  'extra_rules',
  'holding_message',
  'booking_confirmation_text',
  'cancellation_confirmation_text',
  'event_move_confirmation_text',
  'event_move_failed_text',
  'booking_issue_handoff_text',
  'no_credits_handoff_text',
  'account_conflict_handoff_text',
  'chat_booking_unavailable_text',
  'flow_booking_ack_text',
  'flow_booking_holding_text',
  'flow_booking_duplicate_text',
  'approval_decline_text',
  'welcome_greeting',
  'link_button_text',
  'agent_name',
  'handoff_cooldown_hours',
  'auto_resolve_after_reply_hours',
  'auto_resolve_stale_hours',
  'effort',
  'handoff_after_verify_failures',
  'handoff_sla_minutes',
])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isSet = (v) => v !== null && v !== undefined
const isObjectKey = (k) => INHERITABLE_OBJECT_KEYS.includes(k)

/** True when `path` is an override path the PUT accepts (see the header). */
export function isKnownOverridePath(path) {
  if (typeof path !== 'string' || !path) return false
  if (STUDIO_ONLY_KEYS.has(path) || INHERITABLE_SCALAR_KEYS.includes(path) || isObjectKey(path)) return true
  const dot = path.indexOf('.')
  if (dot < 0) return false
  const key = path.slice(0, dot)
  const field = path.slice(dot + 1)
  return isObjectKey(key) && INHERITABLE_OBJECT_FIELDS[key].includes(field)
}

/**
 * Normalise a validated `overridden` list into what the save keeps.
 * Studio-only keys are dropped (they are always saved anyway); a whole object
 * key expands to all of its fields.
 * @param {string[]} list
 * @returns {{ scalars: Set<string>, fields: Map<string, Set<string>> }}
 */
export function expandOverridden(list = []) {
  const scalars = new Set()
  const fields = new Map()
  const addField = (key, field) => {
    if (!fields.has(key)) fields.set(key, new Set())
    fields.get(key).add(field)
  }
  for (const path of list) {
    if (!isKnownOverridePath(path) || STUDIO_ONLY_KEYS.has(path)) continue
    if (INHERITABLE_SCALAR_KEYS.includes(path)) { scalars.add(path); continue }
    if (isObjectKey(path)) { for (const f of INHERITABLE_OBJECT_FIELDS[path]) addField(path, f); continue }
    const dot = path.indexOf('.')
    addField(path.slice(0, dot), path.slice(dot + 1))
  }
  return { scalars, fields }
}

/**
 * The override set a stored studio blob implies: every inheritable key, and
 * every object field, present and non-null in it (T3-D). The editor starts
 * from this, so the first save of a legacy FULL blob (Stillorgan's) keeps
 * every value it holds instead of dropping them to the defaults. Keys the
 * contract no longer knows are left out (the PUT would refuse them).
 * @param {object|null} studio  the raw locations.settings.customer_agent
 * @returns {string[]} sorted dotted paths
 */
export function initialOverridden(studio) {
  if (!isPlainObject(studio)) return []
  const out = []
  for (const key of INHERITABLE_SCALAR_KEYS) if (isSet(studio[key])) out.push(key)
  for (const key of INHERITABLE_OBJECT_KEYS) {
    const obj = studio[key]
    if (!isPlainObject(obj)) continue
    for (const f of INHERITABLE_OBJECT_FIELDS[key]) if (isSet(obj[f])) out.push(`${key}.${f}`)
  }
  return out.sort()
}

// The dotted paths one path stands for (a whole object key = all its fields).
function leafPaths(path) {
  return isObjectKey(path) ? INHERITABLE_OBJECT_FIELDS[path].map((f) => `${path}.${f}`) : [path]
}

const isInheritable = (path) => isKnownOverridePath(path) && !STUDIO_ONLY_KEYS.has(path)

/** Is this path (or every field of a whole object key) overridden? */
export function isOverridden(list, path) {
  const have = new Set(expandToLeaves(list))
  return leafPaths(path).some((p) => have.has(p))
}

function expandToLeaves(list = []) {
  return list.filter(isInheritable).flatMap(leafPaths)
}

/** `list` with `paths` marked overridden (studio-only / unknown paths ignored). */
export function withOverride(list, ...paths) {
  const next = new Set(expandToLeaves(list))
  for (const p of paths) if (isInheritable(p)) for (const leaf of leafPaths(p)) next.add(leaf)
  return [...next].sort()
}

/** `list` with `paths` no longer overridden ("Use organisation default"). */
export function withoutOverride(list, ...paths) {
  const drop = new Set(paths.flatMap(leafPaths))
  return expandToLeaves(list).filter((p) => !drop.has(p)).sort()
}

/** The value at a path in a settings-shaped object (`inherited`, `org`). */
export function valueAt(obj, path) {
  if (!isPlainObject(obj)) return undefined
  const dot = path.indexOf('.')
  if (dot < 0) return obj[path]
  const inner = obj[path.slice(0, dot)]
  return isPlainObject(inner) ? inner[path.slice(dot + 1)] : undefined
}

/**
 * Where an inheritable field's value comes from, as the editor shows it:
 * 'studio' when the studio overrides it, else 'org' when the org layer sets
 * it (mirrors mergeAgentSettings: null at a layer means "not set"), else
 * 'default'. Studio-only keys are always 'studio'.
 * @param {string[]} paths  the field's paths (one, or a pair like quiet hours)
 * @param {{ overridden: string[], org: object|null }} ctx
 */
export function fieldSource(paths, { overridden = [], org = null } = {}) {
  if (paths.some((p) => STUDIO_ONLY_KEYS.has(p))) return 'studio'
  if (paths.some((p) => isOverridden(overridden, p))) return 'studio'
  return orgSetsAny(paths, org) ? 'org' : 'default'
}

/**
 * Does the org layer hold a value for any of these paths? A whole object key
 * counts only when one of its FIELDS is set (an org `quiet_hours` of all-null
 * fields sets nothing).
 */
export function orgSetsAny(paths, org) {
  return paths.some((p) => leafPaths(p).some((leaf) => isSet(valueAt(org, leaf))))
}

/**
 * MIAORG.1 Task 4 — a quiet-hours window with only one end filled in (and not
 * switched off). Neither editor can save one (the payload would silently drop
 * it), so both show "Set both times" and hold Save until it is fixed.
 */
export function isHalfQuietWindow(q) {
  if (!isPlainObject(q) || q.off === true) return false
  const has = (v) => typeof v === 'string' ? v.trim() !== '' : isSet(v)
  return has(q.start) !== has(q.end)
}

/** Staff-facing tag text for a source (T3-F). Null for 'studio'. */
export function sourceTagLabel(source) {
  if (source === 'org') return 'Organisation default'
  if (source === 'default') return 'Default'
  return null
}
