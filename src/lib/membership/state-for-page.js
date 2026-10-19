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
// 'unconfigured' | 'unknown', or 'no_location' (no active studio to ask
// about), and `label` / `capabilities` come from the provider registered
// for `source` (the none provider for a failed read).
//
// CACHE. 60 s per location, per instance: the Studio board renders up to
// four columns and the Business page several blocks, each of which asks.
// An 'unknown' answer (a read failed) is NEVER cached — a reload must be a
// real retry, not the same failure served from memory. W1.M2's PUT can call
// resetMembershipStateCache(locationId) after a write.
import { logError } from '@/lib/log'
import { membershipSourceState, MEMBERSHIP_SOURCES } from './source'
import { READS_BY_SOURCE } from './reads/registry'

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
 * UN1TCAP.1 — may a page or loader read `capability` data for this state? A
 * source can be CONFIGURED and still not provide it (un1t.online supplies no
 * membership data yet), so a gate that checks `state === 'configured'` alone
 * renders Glofox-shaped zeros. Pages ask this; MembershipSourceGate renders the
 * "<label> does not provide …" copy when it is false.
 *
 * @param {{ state?: string, capabilities?: object }|null|undefined} membership  membershipStateForPage()'s value
 * @param {'memberships'|'bookings'|'credits'|'invoices'|'schedule'} capability
 */
export function providesCapability(membership, capability) {
  return membership?.state === 'configured' && membership?.capabilities?.[capability] !== false
}

/**
 * @param {object} db  service-role client
 * @param {string|null|undefined} locationId
 * @param {{ now?: () => number }} [opts]  test seam for the clock
 */
export async function membershipStateForPage(db, locationId, { now = Date.now } = {}) {
  // No active studio is not "no source": the gate says "Choose a location".
  if (!locationId) return withProvider({ source: null, state: 'no_location' })
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
 * constant, so a move is a one-line change. The gate links to it only for
 * a real location (the no_location state draws no link).
 */
export function membershipSettingsHref(locationId) {
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

/**
 * W1.M3c — the membership state as a phone route payload carries it
 * (`membership_source` on /api/dashboard/business and
 * /api/dashboard/studio-contacts). Server-judged: whether a source is
 * configured is the provider's answer, never the phone's guess from a
 * settings slice. Carries only what the phone draws: the state, the
 * provider's label, which credentials are missing (names, never values),
 * whether the source provides membership data, and whether THIS user may
 * change the setting (decides "Choose one in…" vs "Ask an owner…"). A
 * missing or malformed state is 'unknown', never 'none'; the read error's
 * detail stays in the server log.
 *
 * @param {{ source?: string|null, state?: string, missing?: string[], label?: string, capabilities?: object }|null|undefined} s
 *   membershipStateForPage()'s answer
 * @param {{ canManage?: boolean, countsRead?: boolean }} [opts]
 *   countsRead: the CALLER reads member counts through the seam (only
 *   /api/dashboard/business does). Studio-contacts does not, so it keeps the
 *   capability alone and the phone's funnel note still says a configured
 *   un1t.online "does not provide membership data".
 */
export function membershipStatePayload(s, { canManage = false, countsRead = false } = {}) {
  const state = s && typeof s.state === 'string' ? s.state : 'unknown'
  const out = {
    source: s?.source ?? null,
    state,
    // 'unknown' carries no label: the label a failed read falls back to is
    // the none provider's ("No membership source"), which would mix unknown
    // with a known none.
    label: state === 'unknown' ? null : (s?.label || null),
    // UN1TREAD.3 — DELIBERATE, OPT-IN OR. A configured source whose static
    // `capabilities.memberships` is false but whose adapter DOES read member
    // counts shows its numbers on the phone on a route that serves those
    // counts (`countsRead`). un1t.online was that source until UN1TRADAR.4
    // made its capability true; the OR is kept for the next such source. UN1TREAD.7: other
    // routes (studio-contacts, whose funnel stages come from Glofox) get the
    // capability alone, or the phone would drop the "does not provide
    // membership data" note for a funnel that cannot move.
    provides_memberships: s?.capabilities?.memberships !== false
      || (countsRead === true && state === 'configured'
        && typeof READS_BY_SOURCE[s?.source]?.membershipCounts === 'function'),
    can_manage: Boolean(canManage),
  }
  if (Array.isArray(s?.missing) && s.missing.length) out.missing = s.missing.map(String)
  return out
}
