// FILTER-A.3 — /api/segments is the tag vocabulary the audience builder reads.
//
// It used to return only the SIX behavioural TAG_RULES, while the platform
// itself writes 32 (PLATFORM_TAGS) and sequences write arbitrary operator
// strings with no whitelist at all. 26+ platform tags were untargetable from
// any UI, including the ones with real reach — glofox_first_booking (129),
// glofox_trial_credits_low (125), glofox_trial_engaged (59).
//
// It also scoped its counts to the OPERATOR'S ACTIVE location rather than the
// location the editor is composing for (finding #15), so the numbers next to
// each tag could describe a different gym than the send.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
let tagRows
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { TAG_RULES } from '@/lib/contact-events'
import { PLATFORM_TAGS } from '@/lib/sequences/tag-vocabulary'

// Minimal contact_tags fake: records the filters applied, returns the rows
// that match, and honours .range() so the route's pagination is exercised.
function makeDb() {
  const calls = []
  return {
    calls,
    from(table) {
      const state = { table, eq: {}, is: {}, from: 0, to: 999 }
      calls.push(state)
      const q = {
        select: () => q,
        eq: (col, val) => { state.eq[col] = val; return q },
        is: (col, val) => { state.is[col] = val; return q },
        order: () => q,
        range: (from, to) => { state.from = from; state.to = to; return q },
        then: (resolve) => {
          const rows = tagRows.filter(r =>
            Object.entries(state.eq).every(([c, v]) => r[c] === v)
            && Object.entries(state.is).every(([c, v]) => r[c] === v))
          return Promise.resolve(resolve({ data: rows.slice(state.from, state.to + 1), error: null }))
        },
      }
      return q
    },
  }
}

const manager = (activeId, ...locationIds) => ({
  role: 'manager',
  isMaster: false,
  activeLocation: activeId ? { id: activeId } : null,
  locations: locationIds.map(id => ({ id, organization_id: 'org-1' })),
})

const req = (qs = '') => new Request(`http://localhost/api/segments${qs}`)

beforeEach(() => {
  tagRows = [
    { tag: 'glofox_first_booking', location_id: 'loc-1', removed_at: null },
    { tag: 'glofox_first_booking', location_id: 'loc-1', removed_at: null },
    { tag: 'glofox_first_booking', location_id: 'loc-2', removed_at: null },
    { tag: 'race_completed', location_id: 'loc-1', removed_at: null },
    // A tag no registry knows about — a sequence's apply_tag node wrote it.
    { tag: 'summer_promo_2026', location_id: 'loc-1', removed_at: null },
  ]
  db = makeDb()
  getCurrentUser.mockResolvedValue(manager('loc-1', 'loc-1', 'loc-2'))
})

describe('GET /api/segments — the vocabulary is a union, not one registry', () => {
  it('returns every behavioural rule tag, every platform tag, and every tag actually in use', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(body.success).toBe(true)
    const tags = body.data.map(d => d.tag)
    for (const r of TAG_RULES) expect(tags, `TAG_RULES ${r.tag}`).toContain(r.tag)
    for (const t of PLATFORM_TAGS) expect(tags, `PLATFORM_TAGS ${t}`).toContain(t)
    expect(tags, 'operator-written tag in contact_tags').toContain('summer_promo_2026')
  })

  it('makes the previously untargetable high-reach platform tags available', async () => {
    const body = await (await GET(req())).json()
    const tags = body.data.map(d => d.tag)
    for (const t of ['glofox_first_booking', 'glofox_trial_credits_low', 'glofox_trial_engaged']) {
      expect(tags).toContain(t)
    }
  })

  it('lists each tag exactly once even when several registries claim it', async () => {
    const body = await (await GET(req())).json()
    const tags = body.data.map(d => d.tag)
    expect(new Set(tags).size).toBe(tags.length)
    // race_completed is in BOTH TAG_RULES and PLATFORM_TAGS.
    expect(tags.filter(t => t === 'race_completed')).toHaveLength(1)
  })

  it('carries a description for every tag — the builder has one to show', async () => {
    const body = await (await GET(req())).json()
    for (const row of body.data) {
      expect(row.description, row.tag).toBeTruthy()
    }
    const rule = body.data.find(d => d.tag === 'race_completed')
    expect(rule.description).toBe(TAG_RULES.find(r => r.tag === 'race_completed').description)
  })

  it('counts only live tags at the requested location', async () => {
    const body = await (await GET(req())).json()
    const byTag = Object.fromEntries(body.data.map(d => [d.tag, d.count]))
    expect(byTag.glofox_first_booking).toBe(2) // two at loc-1, one at loc-2
    expect(byTag.race_completed).toBe(1)
    expect(byTag.glofox_trial_engaged).toBe(0) // known but unused here
  })

  it('sorts used tags before unused ones so the reachable cohorts surface first', async () => {
    const body = await (await GET(req())).json()
    const firstZero = body.data.findIndex(d => d.count === 0)
    const lastNonZero = body.data.map(d => d.count).lastIndexOf(
      body.data.map(d => d.count).filter(c => c > 0).at(-1),
    )
    expect(firstZero).toBeGreaterThan(lastNonZero)
  })
})

describe('GET /api/segments — counts follow the EDITOR\'s location, not the operator\'s (finding #15)', () => {
  it('honours an explicit ?location_id the caller has access to', async () => {
    const body = await (await GET(req('?location_id=loc-2'))).json()
    const byTag = Object.fromEntries(body.data.map(d => [d.tag, d.count]))
    expect(byTag.glofox_first_booking).toBe(1)
    expect(byTag.race_completed).toBe(0)
    expect(db.calls.every(c => c.eq.location_id === 'loc-2')).toBe(true)
  })

  it('falls back to the active location when none is passed', async () => {
    await GET(req())
    expect(db.calls.every(c => c.eq.location_id === 'loc-1')).toBe(true)
  })

  it('refuses a location the caller cannot access rather than silently re-scoping', async () => {
    const res = await GET(req('?location_id=loc-99'))
    expect([403, 404]).toContain(res.status)
  })

  it('only ever counts live tags', async () => {
    await GET(req())
    expect(db.calls.every(c => c.is.removed_at === null)).toBe(true)
  })
})

describe('GET /api/segments — guards', () => {
  it('401s an unauthenticated caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('403s below manager', async () => {
    getCurrentUser.mockResolvedValue({ ...manager('loc-1', 'loc-1'), role: 'staff' })
    expect((await GET(req())).status).toBe(403)
  })

  it('still returns the vocabulary with zero counts when no location can be resolved', async () => {
    getCurrentUser.mockResolvedValue(manager(null))
    const body = await (await GET(req())).json()
    expect(body.success).toBe(true)
    expect(body.data.length).toBeGreaterThan(TAG_RULES.length)
    expect(body.data.every(d => d.count === 0)).toBe(true)
  })
})
