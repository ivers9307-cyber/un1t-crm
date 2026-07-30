import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import { buildAudienceQuery } from './postmark'

// SEPARATION INVARIANT (HOST-GROWTH spec): host mailing-list signups live at
// the host's anchor location (locations.is_host_anchor=true). UN1T campaign
// audiences must therefore ALWAYS be pinned .eq('location_id', <location>) —
// if that filter is ever dropped, host leads leak into gym marketing.
//
// Proxy-based recorder: every property access returns a chaining function
// that logs the call and returns the same proxy, so any builder shape
// (.eq/.not/.is/.select/...) chains without needing to know the exact
// PostgREST surface. 'then' is excluded so the proxy is never accidentally
// treated as a thenable by an `await` in buildAudienceQuery/callers.
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
