// Audience-match check used by every status-change / tag-added /
// race-* trigger before enrolling a contact, and (SEQEXIT.1) by the
// scheduler before every step to decide whether the contact still
// belongs in the sequence.
//
// Implemented as a 1-row reachability check: we apply the
// audience_filter to a query that's already filtered to a single
// contact_id, then ask Postgres `count(*)`. If 1, the contact
// matches. If 0, they don't. We don't need to run the filter
// across the whole contacts table — single-row evaluation is
// dramatically cheaper for the cron path which calls this
// hundreds-to-thousands of times per tick.
//
// Sequences with no filter (the common case — `filter` is null,
// undefined, or has no `filters` array) match everyone.
//
// SEQEXIT.1 — why there are THREE states, not two.
// The audience is now a CONTINUING condition: a contact who stops
// matching is EXITED from the sequence. That exit is irreversible
// (no manual re-entry), so "definitely does not match" and "we could
// not tell" must not collapse into the same answer. A boolean forces
// them together, and the false-ish direction — right for enrolment,
// where "nobody enrolled" beats "everybody enrolled by accident" —
// would terminate every in-flight enrolment on one malformed filter
// or one transient DB error, silently. So:
//
//   'match'    — the contact satisfies the filter (or there is none)
//   'no_match' — the count query ran and definitively returned 0
//   'unknown'  — we could not evaluate: bad filter, failed query, or
//                any unexpected throw. Callers must FAIL OPEN on it.
//
// `contactMatchesSequenceAudience` stays the enrolment-side API and
// keeps its exact old semantics (including rethrowing an unexpected
// error so the cron logs the real failure rather than masking it as
// no-match) — it is a wrapper over the evaluator, nothing more.

import { applyAudienceFilterAsync, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { logWarn } from '@/lib/log'

/**
 * Shared core. Returns the three-state result plus, when the failure
 * was an unexpected throw, the original error so the enrolment-side
 * wrapper can preserve its rethrow contract.
 *
 * @returns {Promise<{ state: 'match'|'no_match'|'unknown', unexpectedError?: Error }>}
 */
async function evaluateAudience(db, contactId, filter) {
  if (!filter?.filters?.length) return { state: 'match' }

  try {
    // Look up the contact's location so tag-filter resolution can be
    // location-scoped (cheaper than scanning contact_tags org-wide
    // when a sequence has a `tag` filter — see mig 085).
    const { data: contact } = await db
      .from('contacts')
      .select('location_id')
      .eq('id', contactId)
      .maybeSingle()

    let query = db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('id', contactId)

    try {
      // Destructure the wrapped { query } return — see resolveTagFilters
      // header in audience-filter.js for the thenable-unwrap reason.
      ;({ query } = await applyAudienceFilterAsync({
        db,
        query,
        filter,
        locationId: contact?.location_id || null,
      }))
    } catch (e) {
      if (e instanceof InvalidAudienceFilterError) {
        // A bad filter shouldn't crash the cron, and it must never be
        // read as "does not match" — that would exit live enrolments.
        logWarn('sequences', 'sequence has invalid audience_filter, cannot evaluate audience', { err: e })
        return { state: 'unknown' }
      }
      throw e
    }

    // supabase-js resolves a FAILED query to { error }, it does not
    // throw — the old `(count ?? 0) > 0` therefore read a timeout as
    // a definitive no-match. Check `error` before trusting `count`.
    const { count, error } = await query
    if (error) {
      logWarn('sequences', 'audience count query failed, cannot evaluate audience', { err: error, contactId })
      return { state: 'unknown' }
    }
    return { state: (count ?? 0) > 0 ? 'match' : 'no_match' }
  } catch (e) {
    // Anything else (transient client error, a throwing mock db, …).
    // Never let it escape from the evaluator: an escaping throw kills
    // the whole cron tick, and a `false` would exit the enrolment.
    logWarn('sequences', 'audience evaluation threw, cannot evaluate audience', { err: e, contactId })
    return { state: 'unknown', unexpectedError: e }
  }
}

/**
 * Three-state audience evaluation. Use this on any path where
 * "we could not tell" must be distinguishable from "no" — above all
 * the scheduler's per-step exit check, which FAILS OPEN on 'unknown'.
 *
 * @param {object} db                                 Service-role Supabase client.
 * @param {string} contactId                          The contact whose match we're testing.
 * @param {object | null | undefined} filter          { logic, filters: [{ field, op, value }] }
 * @returns {Promise<'match' | 'no_match' | 'unknown'>}
 */
export async function evaluateSequenceAudience(db, contactId, filter) {
  const { state } = await evaluateAudience(db, contactId, filter)
  return state
}

/**
 * Enrolment-side boolean. Semantics are unchanged from before
 * SEQEXIT.1: only a positive 'match' enrols, an invalid filter or a
 * failed query means "don't enrol", and an unexpected error still
 * bubbles up to the caller.
 *
 * @param {object} db                                 Service-role Supabase client.
 * @param {string} contactId                          The contact whose match we're testing.
 * @param {object | null | undefined} filter          { logic, filters: [{ field, op, value }] }
 * @returns {Promise<boolean>}
 */
export async function contactMatchesSequenceAudience(db, contactId, filter) {
  const { state, unexpectedError } = await evaluateAudience(db, contactId, filter)
  if (unexpectedError) throw unexpectedError
  return state === 'match'
}
