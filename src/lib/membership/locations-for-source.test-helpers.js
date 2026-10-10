// W1.M3b — answer the seam's `locations` reads from a row table, the way
// PostgREST would, so a test proves discovery goes through membership_source
// (and not through settings->'glofox'): a row whose slice says "connected" but
// whose column says 'none' must not be visited.
//
// Works with the recording fake in src/lib/time-off.test-helpers.js:
// `answerLocations(q, rows)` reads q.calls (eq / in / range) and q.terminal.

export function answerLocations(q, rows) {
  let list = rows
  for (const [op, a, b] of q.calls) {
    if (op === 'eq') list = list.filter((r) => r[a] === b)
    else if (op === 'in') list = list.filter((r) => (b || []).includes(r[a]))
    else if (op === 'range') list = list.slice(a, b + 1) // ['range', from, to]
  }
  if (q.terminal === 'maybeSingle' || q.terminal === 'single') return { data: list[0] ?? null, error: null }
  return { data: list, error: null }
}

/** A location row as the seam reads it. `settings` is what the OLD discovery sniffed. */
export function locationRow({ id, name = id, source = 'none', active = true, settings = null }) {
  return { id, name, active, membership_source: source, settings }
}

export const FULL_GLOFOX_SLICE = Object.freeze({ glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } })

// The live estate on 10 Oct 2026 (plan "Live facts"): only Stillorgan has a
// real Glofox branch id; Hatch Street and CCF Autos carry a settings.glofox
// slice with branch_id NULL (what the old discovery tried every tick).
export const STILLORGAN_ID = 'a0000000-0000-0000-0000-000000000001'
export const ESTATE_2026_10 = Object.freeze([
  locationRow({ id: STILLORGAN_ID, name: 'UN1T Stillorgan', source: 'glofox', settings: FULL_GLOFOX_SLICE }),
  locationRow({ id: '28c78d6b-0000-0000-0000-000000000002', name: 'UN1T Hatch Street', source: 'none', settings: { glofox: { branch_id: null, api_key: 'k', api_token: 't' } } }),
  locationRow({ id: '9e069256-0000-0000-0000-000000000003', name: 'Test Studio', source: 'none' }),
  locationRow({ id: '95be0b12-0000-0000-0000-000000000004', name: 'Pride Training Club', source: 'none' }),
  locationRow({ id: 'f45ef67e-0000-0000-0000-000000000005', name: 'CCF Autos', source: 'none', settings: { glofox: { branch_id: null } } }),
  locationRow({ id: '7010edf9-0000-0000-0000-000000000006', name: 'SourceIt', source: 'none' }),
])

/** The discovery rule the five crons used BEFORE W1.M3b: the legacy slice with all three credentials. */
export function legacyGlofoxDiscovery(rows) {
  return rows
    .filter((r) => { const g = r.settings?.glofox || {}; return g.branch_id && g.api_key && g.api_token })
    .map((r) => r.id)
}

// The two rows that tell the old rule from the new one.
export const SLICE_BUT_NONE = locationRow({ id: 'b0000000-0000-0000-0000-00000000000b', name: 'Slice says yes, column says none', source: 'none', settings: FULL_GLOFOX_SLICE })
export const REGISTRY_ONLY = locationRow({ id: 'c0000000-0000-0000-0000-00000000000c', name: 'Registry only', source: 'glofox', settings: null })

/** A `locations` resolver for fakeDb: rows, or a failed seam list read. */
export function locationsResolver(rows, { listError = null } = {}) {
  return (q) => {
    if (listError && q.eq.membership_source) return { data: null, error: listError }
    return answerLocations(q, rows)
  }
}
