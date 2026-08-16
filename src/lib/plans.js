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
import { BUNDLE_KEYS } from '@shared/permission-bundles'
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

// ============================================================
// BUNDLES.5 Task 3 — plan → locations.features bundle mirror.
//
// shared/plans.js FEATURE_KEYS now includes the 7 hub bundles +
// module_cars (BUNDLE_KEYS, shared/permission-bundles.js) alongside
// ai_agent/custom_email_domain, so a plan version can grant/withhold
// whole bundles. This is the write-side mirror: whenever a location's
// plan pin CHANGES (assign or unassign — see
// src/app/api/admin/tenants/[orgId]/plans/route.js), the plan's
// resolved bundle grants get copied onto locations.features using the
// SAME deny-by-explicit-false polarity the bundle layer already uses
// everywhere else (shared/permission-bundles.js bundlesDenyKey).
//
// getLocationPlan() is READ-ONLY and NOT itself in any permission
// path (see its own header comment) — the resolver
// (isFeatureEnabledAtLocation) only ever reads locations.features
// directly. This mirror is what makes a plan's bundle grants actually
// take effect: it is the ONE write path that turns "the location is
// pinned to a plan that includes bundle_sales" into
// "locations.features.bundle_sales is not explicitly false".
// ============================================================

/**
 * Pure polarity adapter: given a location's CURRENT features blob and
 * the bundle-relevant features a plan resolves to, return the next
 * features blob to write.
 *
 * - `planFeatures === null` means "no active plan pin" (getLocationPlan
 *   returned null — the documented "no plan constraints, behave
 *   exactly as before plans existed" contract, which is still exactly
 *   right for a location that was NEVER pinned). BUNDLES.5
 *   final-review fix 3: this does NOT mean "reopen every bundle".
 *   Unassigning a plan (or simply being unpinned) STOPS the plan
 *   mechanism from applying — it does not undo whatever bundle state
 *   the location is currently in. Every existing BUNDLE_KEYS entry is
 *   left exactly as it is (fail-closed: a denial a prior pin left
 *   behind survives the unpin); an operator who wants a bundle back on
 *   flips it by hand on Location Features. A never-pinned location's
 *   `{}` is likewise untouched, so back-compat is unaffected.
 * - Otherwise (a plan IS pinned), per BUNDLE_KEYS: `planFeatures[key]
 *   === true` (the plan GRANTS the bundle) → the key is REMOVED from
 *   locations.features (back to default-on, same as any other unset
 *   feature); anything else (absent, or explicitly false) → the plan
 *   does NOT grant it, so locations.features[key] is set to explicit
 *   `false` (denied).
 *
 * Every non-bundle key already on the location (fine-grained
 * WEB/MOBILE_PERMISSIONS overrides an operator set by hand) passes
 * through untouched either way — this function only ever touches
 * BUNDLE_KEYS, and only when a plan is actually pinned.
 *
 * @param {object|null|undefined} currentFeatures  location.features
 * @param {object|null} planFeatures  plan.resolved.features, or null for "unpinned"
 * @returns {object} the next locations.features blob
 */
export function mirrorBundleFeatures(currentFeatures, planFeatures) {
  const next = { ...(currentFeatures || {}) }
  if (planFeatures === null) {
    // Fail-closed: no plan pinned right now → don't touch bundle
    // overrides at all, in either direction. See the header comment.
    return next
  }
  for (const bundleKey of BUNDLE_KEYS) {
    if (planFeatures?.[bundleKey] === true) {
      delete next[bundleKey]
    } else {
      next[bundleKey] = false
    }
  }
  return next
}

/**
 * Orchestration: re-derive a location's bundle mirror from its CURRENT
 * plan pin state and write it. Call this after every write to
 * location_plans (assign or unassign) for the affected location — see
 * src/app/api/admin/tenants/[orgId]/plans/route.js.
 *
 * On ASSIGN, this applies the newly-pinned plan's bundle grants.
 * On UNASSIGN (no active tier left → getLocationPlan returns null),
 * this is a fail-closed no-op on the bundle keys themselves — see
 * mirrorBundleFeatures's header comment. The write still happens (it
 * writes the SAME features blob back), which is harmless; what matters
 * is that no bundle_x entry changes value.
 *
 * @param {object} db - service-role client
 * @param {string} locationId
 * @returns {Promise<object>} the features blob that was written
 */
export async function applyPlanBundlesToLocation(db, locationId) {
  const plan = await getLocationPlan(db, locationId)
  const planFeatures = plan ? plan.resolved.features : null

  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('features')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) throw new Error(`applyPlanBundlesToLocation: ${locErr.message}`)

  const nextFeatures = mirrorBundleFeatures(loc?.features, planFeatures)

  const { error: updErr } = await db
    .from('locations')
    .update({ features: nextFeatures, updated_at: new Date().toISOString() })
    .eq('id', locationId)
  if (updErr) throw new Error(`applyPlanBundlesToLocation: ${updErr.message}`)

  return nextFeatures
}
