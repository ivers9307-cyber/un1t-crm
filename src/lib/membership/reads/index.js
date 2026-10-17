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
import { noneReads } from './none'
import { READS_BY_SOURCE } from './registry'

export const READ_KEYS = Object.freeze([
  'membershipCounts', 'mrr', 'membershipFlows', 'growth', 'engagement', 'revenueMtd', 'arrears',
  'pastDue', 'paymentsFor', 'pipelineInputs', 'trialEligibility',
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
