import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import { buildAudienceQuery, buildAudienceQueryAsync } from './postmark'

// LOCATION-PINNING INVARIANT: UN1T campaign audiences must ALWAYS be pinned
// .eq('audience_location_id', <location>) — dropping that filter would sweep
// every tenant's contacts into one gym's broadcast.
//
// LOCCOMMS.3 (2026-08-07): the pin moved from contacts.location_id to the
// contact_location_audience view's audience_location_id. Same invariant, new
// column — and it is now STRONGER, because the view inner-joins
// contact_location_preferences, so a contact with no row for that location
// cannot appear in the audience at all. Updated per this file's own
// instruction to re-point the assertion rather than delete the test.
//
// NOTE (HOST-MASTER.1, 2026-07-31): this test used to double as the
// "host leads can never reach UN1T marketing" guarantee, back when host
// signups lived at the host's hidden anchor location. That is NO LONGER the
// contract — host leads now live on the org's MASTER location (Stillorgan)
// and are deliberately reachable by UN1T sends (Richard's call). What still
// protects them is `contacts.automations_exempt` + the enrolContacts gate
// (src/lib/sequences/enrol.js): they are never AUTO-enrolled in sequences or
// automations, though a manual staff enrolment includes them. Don't read the
// pin below as host-lead isolation — it is plain multi-tenant scoping. Both
// the sync builder (used by preview/count paths) and its async sibling
// (the one the live send path — campaign-sender.js — actually calls) hand-
// write their own location pin, so both need this guard independently.
// The requirement is the SEMANTIC pin, not `.eq` specifically — if the
// builder mechanism ever changes (e.g. to `.match()`/`.filter()`), update
// the assertion to the new call shape rather than deleting this test.
//
// Proxy-based recorder: every property access returns a chaining function
// that logs the call and returns the same proxy, so any builder shape
// (.eq/.not/.is/.select/...) chains without needing to know the exact
// PostgREST surface. 'then' is excluded so the proxy is never accidentally
// treated as a thenable by an `await` in buildAudienceQuery(Async)/callers
// (buildAudienceQueryAsync's own internals `await resolveTagFilters(...)`
// on a `{ query }` object, not on the recorder itself, but the exclusion
// is kept as a defensive no-op in case that ever changes).
function chainRecorder() {
  const calls = []
  const chain = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'calls') return calls
      if (prop === 'then') return undefined
      return (...args) => { calls.push([prop, args]); return chain }
    },
  })
  return chain
}

describe('buildAudienceQuery location pinning', () => {
  it('always applies .eq(audience_location_id, <given location>) for an arbitrary (empty) filter', () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const q = buildAudienceQuery(db, { logic: 'and', filters: [] }, 'real-location-uuid')
    const eqCalls = q.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['audience_location_id', 'real-location-uuid']])
  })

  it('keeps the location pin when a real audience filter is applied', () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }
    const q = buildAudienceQuery(db, filter, 'real-location-uuid')
    const eqCalls = q.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['audience_location_id', 'real-location-uuid']])
    expect(eqCalls).toContainEqual(['eq', ['pipeline_stage_slug', 'member']])
  })
})

describe('buildAudienceQueryAsync location pinning', () => {
  it('always applies .eq(audience_location_id, <given location>) for an arbitrary (empty) filter', async () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const { query } = await buildAudienceQueryAsync(db, { logic: 'and', filters: [] }, 'real-location-uuid')
    const eqCalls = query.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['audience_location_id', 'real-location-uuid']])
  })

  it('keeps the location pin when a real audience filter is applied', async () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }
    const { query } = await buildAudienceQueryAsync(db, filter, 'real-location-uuid')
    const eqCalls = query.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['audience_location_id', 'real-location-uuid']])
    expect(eqCalls).toContainEqual(['eq', ['pipeline_stage_slug', 'member']])
  })
})

// LOCCOMMS.3 — the send path reads per-location consent, not the denormalised
// global column. Before this, a Hatch Street campaign reached only contacts
// whose ROW sat at Hatch: 58 of 81 on the founding-member list, with the other
// 23 silently unreachable since June.
describe('LOCCOMMS.3 — per-location consent gate', () => {
  it('reads the view and gates on the LOCATION consent column, not the global one', () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    buildAudienceQuery(db, null, 'loc-hatch')

    expect(db.from).toHaveBeenCalledWith('contact_location_audience')
    const eqCalls = recorder.calls.filter((c) => c[0] === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['audience_location_id', 'loc-hatch']])
    expect(eqCalls).toContainEqual(['eq', ['loc_email_marketing', true]])
    // the global denormalised column must NOT be the gate any more
    expect(eqCalls).not.toContainEqual(['eq', ['email_marketing', true]])
  })

  it('keeps email_administrative GLOBAL — transactional mail follows the transaction', () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    buildAudienceQuery(db, null, 'loc-hatch', { consentField: 'email_administrative' })

    const eqCalls = recorder.calls.filter((c) => c[0] === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['email_administrative', true]])
    expect(eqCalls).not.toContainEqual(['eq', ['loc_email_administrative', true]])
  })

  it('async sibling gates the same way', async () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    await buildAudienceQueryAsync(db, null, 'loc-hatch')

    expect(db.from).toHaveBeenCalledWith('contact_location_audience')
    const eqCalls = recorder.calls.filter((c) => c[0] === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['audience_location_id', 'loc-hatch']])
    expect(eqCalls).toContainEqual(['eq', ['loc_email_marketing', true]])
  })
})
