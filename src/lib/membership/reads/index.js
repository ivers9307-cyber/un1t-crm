// UN1TREAD.1 — the membership READ seam.
//
// The Business page, Studio scorecard, briefing and the phone's business
// dashboard used to call the Glofox-shaped readers directly and gate on
// "is the source configured". They now ask this module which adapter serves
// the location, and a read the adapter lacks is "not available", never zeros:
//
//   const r = await membershipReadsFor(db, locationId)
//   if (supportsRead(r, 'mrr')) { const out = await r.reads.mrr(db, locationId) }
//
// An adapter is a frozen object of async functions keyed by READ_KEYS, each
// returning exactly the shape the Glofox function it replaces returns (so the
// renderers do not change). Same dispatcher shape as src/lib/payments/index.js.
//
// Server-side only (src/lib): shared/ cannot import this, so phones get these
// numbers through /api/* routes.
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { MEMBERSHIP_SOURCES, MEMBERSHIP_SOURCE_UNREADABLE } from '@/lib/membership/source'
import { noneReads } from './none'
import { READS_BY_SOURCE } from './registry'

export const READ_KEYS = Object.freeze([
  'membershipCounts', 'mrr', 'membershipFlows', 'growth', 'engagement', 'revenueMtd', 'arrears',
  'pastDue', 'paymentsFor', 'pipelineInputs', 'trialEligibility',
  // UN1TRADAR.1 — the radar row fetches (churn, win-back, lead, arrears fold)
  'radarMembers', 'winbackContacts', 'leadContacts', 'radarPastDue',
])

export { READS_BY_SOURCE }

/**
 * The adapter that serves a location's membership reads.
 *
 * `reads` is the adapter only when the source is `configured`; for none /
 * unconfigured / unknown / no_location it is null, and `state` / `label` /
 * `error` say why so the caller can draw the right copy. A source key nothing
 * registers resolves to noneReads (supports nothing).
 *
 * @param {object} db  service-role client
 * @param {string|null|undefined} locationId
 * @returns {Promise<{ source: string|null, label: string, state: string, reads: object|null, error: any, capabilities: object, missing?: string[] }>}
 */
export async function membershipReadsFor(db, locationId) {
  const s = await membershipStateForPage(db, locationId)
  const reads = s.state === 'configured' ? (Object.hasOwn(READS_BY_SOURCE, s.source) ? READS_BY_SOURCE[s.source] : noneReads) : null
  return {
    source: s.source ?? null,
    label: s.label,
    state: s.state,
    reads,
    error: s.readError ?? null,
    // UN1TREAD.4 — carried so a surface that already asked the seam does not
    // read the (cached, but separately resolved) state a second time for the
    // capability flags and the "missing credentials" copy.
    capabilities: s.capabilities ?? {},
    missing: Array.isArray(s.missing) ? s.missing : undefined,
  }
}

/** True when the resolved adapter implements `key`. */
export function supportsRead(r, key) {
  return typeof r?.reads?.[key] === 'function'
}

/**
 * UN1TRADAR.1 — the adapter that serves a location's RADAR reads, resolved by
 * SOURCE KEY in any state (configured, unconfigured, or unknown with a known
 * source), as membership-snapshot does. Not membershipReadsFor, whose `reads`
 * is null unless configured: the radar reads stored rows, so Stillorgan's must
 * survive a Glofox credential glitch.
 *
 * `providesMemberships` is the provider's STATIC capability
 * (MEMBERSHIP_SOURCES, as locationIdsWithoutCapability reads it), never the
 * state's. `pinArrears` is the adapter's own flag (un1t studios pin past-due
 * members above the At-risk list).
 *
 * An unreadable source key throws (code MEMBERSHIP_SOURCE_UNREADABLE): a route
 * answers 500, a cron records a per-location error. Never "no members".
 *
 * @returns {Promise<{ source: string, reads: object, providesMemberships: boolean, pinArrears: boolean }>}
 */
export async function radarReadsFor(db, locationId) {
  const s = await membershipStateForPage(db, locationId)
  const source = s?.source ?? null
  if (source == null) {
    const err = new Error('membership source unreadable')
    err.code = MEMBERSHIP_SOURCE_UNREADABLE
    throw err
  }
  const reads = Object.hasOwn(READS_BY_SOURCE, source) ? READS_BY_SOURCE[source] : noneReads
  const provider = Object.hasOwn(MEMBERSHIP_SOURCES, source) ? MEMBERSHIP_SOURCES[source] : null
  return {
    source,
    reads,
    providesMemberships: provider?.capabilities?.memberships === true,
    pinArrears: reads.pinArrears === true,
  }
}
