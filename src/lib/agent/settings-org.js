// MIAORG.1 Task 4 — the organisation-defaults editor's pure rules, shared by
// the org route (src/app/api/settings/customer-agent/org/route.js) and its
// client (OrgDefaultsClient.jsx). Zod-free on purpose, like
// settings-overrides.js, so the client never ships zod.
//
// The org layer (org_settings.customer_agent) holds only INHERITABLE values:
// never a studio-only key, never `quiet_hours.off` (a studio's opt-out) and
// never `quiet_hours.tz` (each studio reads org quiet hours on its own clock,
// locations.timezone; T4-B).

import {
  INHERITABLE_OBJECT_KEYS, INHERITABLE_OBJECT_FIELDS, isOverridden, initialOverridden, valueAt,
  STUDIO_ONLY_KEYS,
} from './settings-overrides'

// Object fields the organisation can never hold.
export const ORG_EXCLUDED_FIELDS = new Set(['quiet_hours.off', 'quiet_hours.tz'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Does this override list set any leaf of these paths? */
const setsAny = (list, paths) => paths.some((p) => isOverridden(list || [], p))

/**
 * T4-A "who inherits": for one org field, the studios that will USE the org
 * value (they set none of its paths themselves) and the studios that set
 * their own. A studio with Mia off still uses it (`mia_on` false; the label
 * says so). For quiet hours pass ['quiet_hours'], so a studio's opt-out
 * (`quiet_hours.off`) counts as its own setting.
 * @param {string[]} paths
 * @param {Array<{ id: string, name: string, sets: string[], mia_on?: boolean }>} studios
 * @returns {{ using: object[], own: object[] }}
 */
export function studiosForField(paths, studios = []) {
  const using = []
  const own = []
  for (const s of studios || []) (setsAny(s.sets, paths) ? own : using).push(s)
  return { using, own }
}

const studioLabel = (s) => `${s.name || 'Unnamed studio'}${s.mia_on === false ? ' (Mia off)' : ''}`

function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The staff line under an org field, e.g. "Used by Hatch Street (Mia off).
 * Stillorgan sets its own." No em-dashes (T4-F).
 */
export function describeInheritance(paths, studios = []) {
  if (!studios || studios.length === 0) return 'No active studios in this organisation yet.'
  const { using, own } = studiosForField(paths, studios)
  const parts = []
  if (using.length) parts.push(`Used by ${joinNames(using.map(studioLabel))}.`)
  else parts.push('No studio uses this value.')
  if (own.length) parts.push(`${joinNames(own.map((s) => s.name || 'Unnamed studio'))} ${own.length === 1 ? 'sets its' : 'set their'} own.`)
  return parts.join(' ')
}

/**
 * T4-A — the fields an org save would START applying: the organisation had
 * no value for them (`before`) and now has one (`after`), each with the
 * studios that will start using it (those that do not set their own). Fields
 * nobody would start using are left out.
 * @param {Array<{ id: string, label: string, paths: string[] }>} fields
 * @param {string[]} before  the paths the org set when the editor loaded
 * @param {string[]} after   the paths it sets now
 * @param {object[]} studios
 * @returns {Array<{ field: object, studios: object[] }>}
 */
export function newlyAppliedFields(fields, before, after, studios = []) {
  const out = []
  for (const field of fields) {
    if (setsAny(before, field.paths) || !setsAny(after, field.paths)) continue
    const { using } = studiosForField(field.paths, studios)
    if (using.length) out.push({ field, studios: using })
  }
  return out
}

/**
 * The paths the organisation sets that actually hold a value in the editor:
 * a path marked set but left blank (or a half quiet-hours window) stores
 * nothing, so it must not appear in the pre-save notice.
 * @param {string[]} set
 * @param {object} values  the editor's state
 * @returns {string[]}
 */
export function nonBlankSetPaths(set = [], values = {}) {
  const filled = (v) => (typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined)
  const quietWhole = filled(valueAt(values, 'quiet_hours.start')) && filled(valueAt(values, 'quiet_hours.end'))
  return (set || []).filter((p) => {
    if (p === 'quiet_hours.start' || p === 'quiet_hours.end') return quietWhole
    if (ORG_EXCLUDED_FIELDS.has(p)) return false
    return filled(valueAt(values, p))
  })
}

/** The notice text for one newly applied field (staff copy, no em-dashes). */
export function describeNewlyApplied({ field, studios }) {
  return `${field.label}: ${joinNames(studios.map(studioLabel))} will start using this.`
}

/**
 * T4-C — which of a studio's own paths ("sets", initialOverridden of its blob)
 * a copy carries into the org layer: inheritable only, never `quiet_hours.off`
 * or `.tz`, and quiet hours only as a complete start/end pair that is in
 * effect (a studio that switched quiet hours off has none to copy).
 * @param {string[]} sets
 * @returns {string[]} sorted
 */
export function copyablePaths(sets = []) {
  const list = (sets || []).filter((p) => !ORG_EXCLUDED_FIELDS.has(p) && !STUDIO_ONLY_KEYS.has(p))
  const hasQuiet = (sets || []).includes('quiet_hours.start') && (sets || []).includes('quiet_hours.end')
    && !(sets || []).includes('quiet_hours.off')
  return list.filter((p) => !p.startsWith('quiet_hours.') || hasQuiet).sort()
}

/**
 * T4-C "Start from a studio's settings": the studio blob's inheritable values
 * that are present and non-null, copied over the org layer (per field for
 * object keys). Org fields the studio does not set are kept; a studio-only
 * key, `quiet_hours.off` and `quiet_hours.tz` are never copied, and the
 * studio blob is not touched (the result is a fresh object).
 * @param {object|null} org     the current org layer
 * @param {object|null} studio  the studio's raw locations.settings.customer_agent
 * @returns {{ layer: object, copied: string[] }}
 */
export function copyStudioIntoOrg(org, studio) {
  const layer = {}
  if (isPlainObject(org)) {
    for (const [k, v] of Object.entries(org)) {
      if (STUDIO_ONLY_KEYS.has(k)) continue
      layer[k] = structuredClone(v)
    }
  }
  if (isPlainObject(layer.quiet_hours)) {
    delete layer.quiet_hours.off
    delete layer.quiet_hours.tz
  }
  const copied = copyablePaths(initialOverridden(isPlainObject(studio) ? studio : null))
  for (const path of copied) {
    const value = structuredClone(valueAt(studio, path))
    const dot = path.indexOf('.')
    if (dot < 0) { layer[path] = value; continue }
    const key = path.slice(0, dot)
    if (!INHERITABLE_OBJECT_KEYS.includes(key) || !INHERITABLE_OBJECT_FIELDS[key].includes(path.slice(dot + 1))) continue
    layer[key] = { ...(isPlainObject(layer[key]) ? layer[key] : {}), [path.slice(dot + 1)]: value }
  }
  return { layer, copied }
}
