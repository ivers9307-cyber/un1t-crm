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
import { searchContacts, crossoverIdsFor, _resetCrossoverCache } from './contacts-api'

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

describe('searchContacts — crossovers (UN1THARD.8)', () => {
  it('lists own contacts OR the crossover ids, at the studio the ids were asked for', async () => {
    api.mockResolvedValue({ success: true, data: { ids: [C1, C2] } })
    const r = await searchContacts({ locationId: HATCH })
    expect(r).toEqual({ success: true, data: [{ id: C1 }] })
    expect(api).toHaveBeenCalledWith('/api/mobile/contacts/crossover-ids', { locationId: HATCH })
    expect(calls).toContainEqual(['or', `location_id.eq.${HATCH},id.in.(${C1},${C2})`])
    expect(calls).toContainEqual(['eq', 'is_primary_contact', true])
    expect(calls.find((c) => c[0] === 'eq' && c[1] === 'location_id')).toBeUndefined()
  })

  it('keeps the search term as its own filter alongside the crossover one', async () => {
    api.mockResolvedValue({ success: true, data: { ids: [C1] } })
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
      api.mockResolvedValue(answer)
      const r = await searchContacts({ locationId: HATCH })
      expect(r.success).toBe(true)
      expect(calls).toContainEqual(['eq', 'location_id', HATCH])
      expect(calls.find((c) => c[0] === 'or')).toBeUndefined()
    }
  })

  it('drops anything that is not an id before it reaches the filter', async () => {
    api.mockResolvedValue({ success: true, data: { ids: [C1, 'x),location_id.neq.(y', 42, null] } })
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
