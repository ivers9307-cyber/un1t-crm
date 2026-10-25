// UN1THARD.8 — the phone directory lists the studio's crossovers (a member of
// another studio with a membership or un1t.online client row here), as the
// web contacts list does. The ids come from a route; the rows from RLS.
//
// `./api` and `./supabase` are mocked BEFORE import: they pull the
// React-Native runtime, which must never load under vitest's Node environment.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('./pipeline-api', () => ({ listActivitiesForContact: vi.fn(), listNotesForContact: vi.fn() }))

import { api } from './api'
import { supabase } from './supabase'
import { searchContacts, crossoverIdsFor, _resetCrossoverCache, MOBILE_CONTACT_SEARCH_PATH } from './contacts-api'

const HATCH = 'a0000000-0000-0000-0000-000000000002'
const C1 = '11111111-1111-1111-1111-111111111111'
const C2 = '22222222-2222-2222-2222-222222222222'

let calls
function queryDouble(result = { data: [{ id: C1 }], error: null }) {
  calls = []
  const q = {}
  for (const m of ['select', 'eq', 'or', 'order', 'limit']) {
    q[m] = (...args) => { calls.push([m, ...args]); return m === 'limit' ? Promise.resolve(result) : q }
  }
  return q
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetCrossoverCache()
  supabase.from.mockImplementation(() => queryDouble())
})

// ORGCONTACTS.5 (final review I4) — the directory search is served by
// GET /api/mobile/contacts/search (public.studio_contacts at the studio, no
// id cap); the RLS read with the capped crossover ids is the fallback when the
// route fails or refuses.
describe('searchContacts — the server search (ORGCONTACTS.5)', () => {
  it('returns the route\'s rows and reads nothing itself; the term and limit travel in the query, the studio in the header', async () => {
    api.mockResolvedValue({ success: true, data: { contacts: [{ id: C1 }, { id: C2 }] } })
    const r = await searchContacts({ locationId: HATCH, query: 'ann o', limit: 25 })
    expect(r).toEqual({ success: true, data: [{ id: C1 }, { id: C2 }] })
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith(`${MOBILE_CONTACT_SEARCH_PATH}?q=ann%20o&limit=25`, { locationId: HATCH })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('falls back to its own RLS read (own contacts + the capped crossover ids) when the route fails or refuses', async () => {
    for (const answer of [{ success: false, transport: true, error: 'Network error' }, { success: false, error: 'Forbidden' }, { success: true, data: {} }]) {
      _resetCrossoverCache()
      api.mockImplementation(async (path) => (path.startsWith(MOBILE_CONTACT_SEARCH_PATH) ? answer : { success: true, data: { ids: [C2] } }))
      const r = await searchContacts({ locationId: HATCH, query: 'ann' })
      expect(r).toEqual({ success: true, data: [{ id: C1 }] })
      expect(calls).toContainEqual(['or', `location_id.eq.${HATCH},id.in.(${C2})`])
    }
  })
})

describe('searchContacts — the RLS fallback and its crossover ids (UN1THARD.8)', () => {
  beforeEach(() => {
    // the server search refuses in every case below; `api` answers the ids route
    api.mockImplementation(async (path) => (path.startsWith(MOBILE_CONTACT_SEARCH_PATH) ? { success: false, error: 'Forbidden' } : apiIds()))
  })
  let apiIds = () => ({ success: true, data: { ids: [] } })
  const idsAnswer = (v) => { apiIds = () => v }

  it('lists own contacts OR the crossover ids, at the studio the ids were asked for', async () => {
    idsAnswer({ success: true, data: { ids: [C1, C2] } })
    const r = await searchContacts({ locationId: HATCH })
    expect(r).toEqual({ success: true, data: [{ id: C1 }] })
    expect(api).toHaveBeenCalledWith('/api/mobile/contacts/crossover-ids', { locationId: HATCH })
    expect(calls).toContainEqual(['or', `location_id.eq.${HATCH},id.in.(${C1},${C2})`])
    expect(calls).toContainEqual(['eq', 'is_primary_contact', true])
    expect(calls.find((c) => c[0] === 'eq' && c[1] === 'location_id')).toBeUndefined()
  })

  it('keeps the search term as its own filter alongside the crossover one', async () => {
    idsAnswer({ success: true, data: { ids: [C1] } })
    await searchContacts({ locationId: HATCH, query: 'ann' })
    const ors = calls.filter((c) => c[0] === 'or').map((c) => c[1])
    expect(ors).toEqual([`location_id.eq.${HATCH},id.in.(${C1})`, expect.stringContaining('name.ilike.%ann%')])
  })

  it('lists own contacts only when there are no crossovers, or the route fails or refuses', async () => {
    for (const answer of [
      { success: true, data: { ids: [] } },
      { success: false, transport: true, error: 'Network error' },
      { success: false, error: 'Forbidden' },
    ]) {
      _resetCrossoverCache()
      idsAnswer(answer)
      const r = await searchContacts({ locationId: HATCH })
      expect(r.success).toBe(true)
      expect(calls).toContainEqual(['eq', 'location_id', HATCH])
      expect(calls.find((c) => c[0] === 'or')).toBeUndefined()
    }
  })

  it('drops anything that is not an id before it reaches the filter', async () => {
    idsAnswer({ success: true, data: { ids: [C1, 'x),location_id.neq.(y', 42, null] } })
    expect(await crossoverIdsFor(HATCH)).toEqual([C1])
  })

  it('asks once a minute per studio, and retries at once after a failed ask', async () => {
    api.mockResolvedValueOnce({ success: false, transport: true })
    expect(await crossoverIdsFor(HATCH, 1_000)).toEqual([])
    api.mockResolvedValue({ success: true, data: { ids: [C1] } })
    expect(await crossoverIdsFor(HATCH, 2_000)).toEqual([C1])
    expect(await crossoverIdsFor(HATCH, 50_000)).toEqual([C1])
    expect(api).toHaveBeenCalledTimes(2)
    expect(await crossoverIdsFor(HATCH, 63_000)).toEqual([C1])
    expect(api).toHaveBeenCalledTimes(3)
  })
})
