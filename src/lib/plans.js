// INTEG-C1 — plan/pricing read helpers (plans / plan_versions /
// location_plans, mig 413).
//
// READ-ONLY resolution layer. Nothing in a live request path calls
// this yet — enforcement, billing and location assignment ship with
// later Integrations & Monetisation items. Every UN1T location is
// unpinned today, so getLocationPlan() returning null is the normal
// case and callers MUST treat null as "no plan constraints — behave
// exactly as before plans existed".
//
// Pure parts (pickActiveVersion, resolveAllowances) are exported for
// unit tests; DB access goes through an injected service client so
// route handlers stay the only place that constructs one.

import { METER_KEYS } from '@shared/plans'
import { dublinTodayStr } from '@/lib/dublin-time'

/**
 * Pure: pick the version of a plan active on a given date — the row
 * with the latest effective_from that is <= onDate. Versions with a
 * FUTURE effective_from are scheduled, not active.
 *
 * @param {Array<{ effective_from: string }>} versions - any order
 * @param {string} onDate - 'YYYY-MM-DD' (Dublin business date — use
 *   dublinTodayStr() for "today", never a UTC-derived date string)
 * @returns {object|null} the active version row, or null if none is
 *   effective yet (all future, or empty list)
 */
export function pickActiveVersion(versions, onDate) {
  if (!Array.isArray(versions) || versions.length === 0) return null
  const cutoff = String(onDate)
  let best = null
  for (const v of versions) {
    if (!v?.effective_from || v.effective_from > cutoff) continue
    if (!best || v.effective_from > best.effective_from) best = v
  }
  return best
}

/**
 * Pure: resolve the effective allowances / feature set for a pinned
 * tier version plus zero or more pinned add-on versions.
 *
 * - allowances: numeric per-meter sums (tier + every add-on), keyed by
 *   the shared/plans.js METER_KEYS. Unknown keys in DB jsonb are
 *   ignored (structure lives in code).
 * - features: boolean OR across tier + add-ons (an add-on can only
 *   grant, never revoke).
 * - unitRatesCents: taken from the TIER version only — overage rates
 *   are a property of the tier a location is on, not of add-ons.
 *
 * @param {{ allowances?: object, unit_rates_cents?: object, features?: object }|null} version - the pinned tier version
 * @param {Array<{ allowances?: object, features?: object }>} [addons] - pinned add-on versions
 * @returns {{ allowances: object, features: object, unitRatesCents: object }|null}
 *   null when version is null (unpinned location — no constraints)
 */
export function resolveAllowances(version, addons = []) {
  if (!version) return null
  const allowances = {}
  for (const key of METER_KEYS) {
    let total = toNonNegativeNumber(version.allowances?.[key])
    for (const addon of addons) {
      total += toNonNegativeNumber(addon?.allowances?.[key])
    }
    allowances[key] = total
  }
  const features = {}
  for (const source of [version, ...addons]) {
    for (const [key, value] of Object.entries(source?.features || {})) {
      features[key] = Boolean(features[key] || value === true)
    }
  }
  return {
    allowances,
    features,
    unitRatesCents: { ...(version.unit_rates_cents || {}) },
  }
}

function toNonNegativeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * The version of a plan active on a date (defaults to today).
 * Plans have few versions, so fetch-and-pick keeps the date logic in
 * one tested place instead of duplicating it in SQL.
 *
 * @param {object} db - service-role client
 * @param {string} planId
 * @param {string} [onDate] - 'YYYY-MM-DD'; defaults to the Dublin
 *   business today (repo TZ convention — see CLAUDE.md)
 * @returns {Promise<object|null>}
 */
export async function getActivePlanVersion(db, planId, onDate = dublinTodayStr()) {
  const { data, error } = await db
    .from('plan_versions')
    .select('*')
    .eq('plan_id', planId)
    .order('effective_from', { ascending: false })
  if (error) throw new Error(`getActivePlanVersion: ${error.message}`)
  return pickActiveVersion(data || [], onDate)
}

/**
 * Resolve a location's pinned plan: its tier version, add-on versions
 * and the merged allowance/feature set.
 *
 * Returns null when the location has no ACTIVE tier pin — the normal
 * state for every existing UN1T location. Callers must treat null as
 * "no plan constraints" (zero behaviour change vs before mig 413).
 *
 * @param {object} db - service-role client
 * @param {string} locationId
 * @returns {Promise<{
 *   tier: { plan: object, version: object },
 *   addons: Array<{ plan: object, version: object }>,
 *   resolved: { allowances: object, features: object, unitRatesCents: object },
 * }|null>}
 */
export async function getLocationPlan(db, locationId) {
  const { data, error } = await db
    .from('location_plans')
    .select(
      'plan_version_id, assigned_at, assigned_by, active, ' +
      'version:plan_versions!plan_version_id(*, plan:plans!plan_id(*))'
    )
    .eq('location_id', locationId)
    .eq('active', true)
  if (error) throw new Error(`getLocationPlan: ${error.message}`)

  const rows = (data || []).filter((r) => r.version?.plan)
  const tierRow = rows.find((r) => r.version.plan.kind === 'tier')
  if (!tierRow) return null

  const addonRows = rows.filter((r) => r.version.plan.kind === 'addon')
  const stripPlan = ({ plan: _plan, ...version }) => version
  const tierVersion = stripPlan(tierRow.version)
  const addonVersions = addonRows.map((r) => stripPlan(r.version))

  return {
    tier: { plan: tierRow.version.plan, version: tierVersion },
    addons: addonRows.map((r, i) => ({
      plan: r.version.plan,
      version: addonVersions[i],
    })),
    resolved: resolveAllowances(tierVersion, addonVersions),
  }
}
