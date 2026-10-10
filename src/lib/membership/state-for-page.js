// W1.M3a — the ONE server helper a gated web surface calls.
//
// Every Glofox-only page (the radars, the membership trend, the studio
// scorecard, the class automations, the pipeline note) used to infer
// "connected" from its own data — an empty radar, a zero MRR, a settings
// slice — and so a gym with no membership source saw empty Glofox-shaped
// data. They now ask this once per render and hand the answer to
// <MembershipSourceGate>, which draws the copy.
//
//   { source, state, missing?, readError?, label, capabilities }
//
// where `state` is membershipSourceState()'s 'none' | 'configured' |
// 'unconfigured' | 'unknown' and `label` / `capabilities` come from the
// provider registered for `source` (the none provider for a failed read).
//
// CACHE. 60 s per location, per instance: the Studio board renders up to
// four columns and the Business page several blocks, each of which asks.
// An 'unknown' answer (a read failed) is NEVER cached — a reload must be a
// real retry, not the same failure served from memory. W1.M2's PUT can call
// resetMembershipStateCache(locationId) after a write.
import { logError } from '@/lib/log'
import { membershipSourceState, MEMBERSHIP_SOURCES } from './source'

export const MEMBERSHIP_STATE_TTL_MS = 60_000

/** A thrown resolver (not a reported read error) — still 'unknown', never 'none'. */
export const MEMBERSHIP_STATE_THREW = 'MEMBERSHIP_STATE_THREW'

const cache = new Map() // locationId → { at, value }

function withProvider(s) {
  const provider = MEMBERSHIP_SOURCES[s.source] || MEMBERSHIP_SOURCES.none
  // A value the CHECK admits but no module serves yet ('un1t' before its
  // provider lands) keeps its own name, so the copy says "un1t", not "No
  // membership source".
  const label = MEMBERSHIP_SOURCES[s.source] ? provider.label : (s.source || provider.label)
  return { ...s, label, capabilities: provider.capabilities }
}

/**
 * @param {object} db  service-role client
 * @param {string|null|undefined} locationId
 * @param {{ now?: () => number }} [opts]  test seam for the clock
 */
export async function membershipStateForPage(db, locationId, { now = Date.now } = {}) {
  if (!locationId) return withProvider({ source: 'none', state: 'none' })
  const hit = cache.get(locationId)
  const t = now()
  if (hit && t - hit.at < MEMBERSHIP_STATE_TTL_MS) return hit.value
  let value
  try {
    value = withProvider(await membershipSourceState(db, locationId))
  } catch (e) {
    logError('membership-state', 'membershipSourceState threw; reporting unknown (not none)', { locationId, err: e?.message || String(e) })
    value = withProvider({ source: null, state: 'unknown', readError: MEMBERSHIP_STATE_THREW })
  }
  if (value.state !== 'unknown') cache.set(locationId, { at: t, value })
  return value
}

/** Drop one location's cached state (after a write), or every location's (tests). */
export function resetMembershipStateCache(locationId) {
  if (locationId) cache.delete(locationId)
  else cache.clear()
}

/**
 * Where the per-location "Membership source" setting lives (W1.M2 puts its
 * card on the location's Integrations tab, above the Glofox tab). One
 * constant, so a move is a one-line change. With no location there is only
 * the hub.
 */
export function membershipSettingsHref(locationId) {
  if (!locationId) return '/settings/integrations-hub'
  return `/settings/locations/${locationId}?section=integrations&tab=glofox`
}

/**
 * May this user change the location's membership source? Mirrors
 * guardMasterOrOwner (W1.M2's route gate): master anywhere, owner AT the
 * location. Decides only which copy the gate shows ("Choose one in…" vs
 * "Ask an owner…"); the route enforces.
 */
export function canManageMembershipSource(user, locationId) {
  if (!user || !locationId) return false
  if (user.profileRole === 'master') return true
  return user.rolesByLocation?.[locationId] === 'owner'
}
