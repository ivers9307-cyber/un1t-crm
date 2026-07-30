import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import { buildAudienceQuery, buildAudienceQueryAsync } from './postmark'

// SEPARATION INVARIANT (HOST-GROWTH spec): host mailing-list signups live at
// the host's anchor location (locations.is_host_anchor=true). UN1T campaign
// audiences must therefore ALWAYS be pinned .eq('location_id', <location>) —
// if that filter is ever dropped, host leads leak into gym marketing. Both
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
  it('always applies .eq(location_id, <given location>) for an arbitrary (empty) filter', () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const q = buildAudienceQuery(db, { logic: 'and', filters: [] }, 'real-location-uuid')
    const eqCalls = q.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['location_id', 'real-location-uuid']])
  })

  it('keeps the location pin when a real audience filter is applied', () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }
    const q = buildAudienceQuery(db, filter, 'real-location-uuid')
    const eqCalls = q.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['location_id', 'real-location-uuid']])
    expect(eqCalls).toContainEqual(['eq', ['pipeline_stage_slug', 'member']])
  })
})

describe('buildAudienceQueryAsync location pinning', () => {
  it('always applies .eq(location_id, <given location>) for an arbitrary (empty) filter', async () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const { query } = await buildAudienceQueryAsync(db, { logic: 'and', filters: [] }, 'real-location-uuid')
    const eqCalls = query.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['location_id', 'real-location-uuid']])
  })

  it('keeps the location pin when a real audience filter is applied', async () => {
    const recorder = chainRecorder()
    const db = { from: vi.fn(() => recorder) }
    const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }
    const { query } = await buildAudienceQueryAsync(db, filter, 'real-location-uuid')
    const eqCalls = query.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['location_id', 'real-location-uuid']])
    expect(eqCalls).toContainEqual(['eq', ['pipeline_stage_slug', 'member']])
  })
})
