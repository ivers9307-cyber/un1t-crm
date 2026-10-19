// PIPEEXCL.1 — who is an active member at ANOTHER studio of the board's
// organisation, and the pure rule that keeps them off the board.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./membership/reads/index.js', () => ({ radarReadsFor: vi.fn() }))
vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { radarReadsFor } from './membership/reads/index.js'
import {
  loadActiveElsewhere, leavesBoard, OWN_STUDIO_MEMBER_SLUGS,
} from './pipeline-other-studio-members.js'

const ORG = 'org-1'
const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const TEST = 'loc-test'

// A recording supabase fake: select/eq/neq/in/order/range, per-table failure.
function makeDb(seed = {}, { fail = [] } = {}) {
  const log = []
  const builder = (table) => {
    const s = { filters: [], range: null, cols: null }
    const run = () => {
      log.push({ table, cols: s.cols, filters: s.filters })
      if (fail.includes(table)) return { data: null, error: { message: `${table} boom` } }
      let rows = (seed[table] || []).filter((r) => s.filters.every(([k, c, v]) => {
        if (k === 'eq') return r[c] === v
        if (k === 'neq') return r[c] !== v
        if (k === 'in') return v.includes(r[c])
        return true
      }))
      if (s.range) rows = rows.slice(s.range[0], s.range[1] + 1)
      return { data: rows.map((r) => ({ ...r })), error: null }
    }
    const api = {
      select(cols) { s.cols = cols; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      neq(c, v) { s.filters.push(['neq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      order() { return api },
      range(a, b) { s.range = [a, b]; return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: (t) => builder(t) }, log }
}

const LOCATIONS = [
  { id: HATCH, name: 'UN1T Hatch Street', organization_id: ORG },
  { id: STILL, name: 'UN1T Stillorgan', organization_id: ORG },
  { id: TEST, name: 'Test Studio', organization_id: ORG },
  { id: 'loc-ccf', name: 'CCF Autos', organization_id: 'org-2' },
]

// The seam: Stillorgan is Glofox, Test Studio has no membership source.
function seam({ stillorgan, hatch } = {}) {
  vi.mocked(radarReadsFor).mockImplementation(async (_db, id) => {
    if (id === STILL) {
      return { source: 'glofox', providesMemberships: true, reads: stillorgan === undefined ? { activeMemberContactIds: vi.fn().mockResolvedValue({ success: true, data: { contactIds: [] } }) } : stillorgan }
    }
    if (id === HATCH) {
      return { source: 'un1t_online', providesMemberships: true, reads: hatch === undefined ? { activeMemberContactIds: vi.fn().mockResolvedValue({ success: true, data: { contactIds: [] } }) } : hatch }
    }
    return { source: 'none', providesMemberships: false, reads: {} }
  })
}
const answers = (contactIds) => ({ activeMemberContactIds: vi.fn().mockResolvedValue({ success: true, data: { contactIds } }) })

beforeEach(() => { vi.mocked(radarReadsFor).mockReset() })

describe('leavesBoard (pure)', () => {
  it('an active member elsewhere leaves a prospect stage', () => {
    for (const slug of ['new_lead', 'first_class', 'second_class', 'trial_done', 'dormant', 'cold_lead', 'classpass', 'gympass']) {
      expect(leavesBoard(slug, true)).toBe(true)
    }
  })

  it('a member of the board\'s own studio too keeps today\'s placement', () => {
    expect(OWN_STUDIO_MEMBER_SLUGS).toEqual(['converted', 'member', 'pack_member'])
    for (const slug of OWN_STUDIO_MEMBER_SLUGS) expect(leavesBoard(slug, true)).toBe(false)
  })

  it('nobody leaves who is not active elsewhere', () => {
    expect(leavesBoard('new_lead', false)).toBe(false)
    expect(leavesBoard('new_lead', undefined)).toBe(false)
  })
})

describe('loadActiveElsewhere', () => {
  it('Hatch board: reads every OTHER studio of the org (not itself, not another org) and returns their active members', async () => {
    const still = answers(['c-still-1', 'c-still-2'])
    seam({ stillorgan: still })
    const { db } = makeDb({ locations: LOCATIONS, person_group_members: [] })

    const out = await loadActiveElsewhere(db, HATCH)

    expect(out.ok).toBe(true)
    expect([...out.contactIds].sort()).toEqual(['c-still-1', 'c-still-2'])
    expect(vi.mocked(radarReadsFor).mock.calls.map((c) => c[1]).sort()).toEqual([STILL, TEST])
    expect(still.activeMemberContactIds).toHaveBeenCalledWith(db, STILL)
    expect(out.studios).toEqual([{ locationId: STILL, members: 2 }])
  })

  it('Stillorgan board: reads Hatch (un1t.online) the same way', async () => {
    const hatch = answers(['c-h'])
    seam({ hatch })
    const { db } = makeDb({ locations: LOCATIONS, person_group_members: [] })

    const out = await loadActiveElsewhere(db, STILL)

    expect(out.ok).toBe(true)
    expect([...out.contactIds]).toEqual(['c-h'])
    expect(hatch.activeMemberContactIds).toHaveBeenCalledWith(db, HATCH)
  })

  it('a person-group sibling of an active member is active elsewhere too (identity is per person, contacts are per studio)', async () => {
    seam({ stillorgan: answers(['c-still']) })
    const { db } = makeDb({
      locations: LOCATIONS,
      person_group_members: [
        { id: 'm1', group_id: 'g1', contact_id: 'c-still' },
        { id: 'm2', group_id: 'g1', contact_id: 'c-hatch-twin' },
        { id: 'm3', group_id: 'g2', contact_id: 'c-unrelated' },
      ],
    })

    const out = await loadActiveElsewhere(db, HATCH)

    expect([...out.contactIds].sort()).toEqual(['c-hatch-twin', 'c-still'])
  })

  it('a studio with no membership source (Test Studio, source none) is skipped, not read', async () => {
    seam()
    const { db } = makeDb({ locations: LOCATIONS, person_group_members: [] })
    const out = await loadActiveElsewhere(db, HATCH)
    expect(out.ok).toBe(true)
    expect(out.contactIds.size).toBe(0)
    expect(out.studios.map((s) => s.locationId)).toEqual([STILL])
  })

  it('a location with no organisation has no other studios: ok, nobody', async () => {
    const { db } = makeDb({ locations: [{ id: 'loc-solo', name: 'Solo', organization_id: null }] })
    const out = await loadActiveElsewhere(db, 'loc-solo')
    expect(out).toMatchObject({ ok: true, studios: [] })
    expect(out.contactIds.size).toBe(0)
    expect(radarReadsFor).not.toHaveBeenCalled()
  })

  describe('a failed read is never "nobody is a member there"', () => {
    it('the board\'s own location row unreadable', async () => {
      const { db } = makeDb({}, { fail: ['locations'] })
      const out = await loadActiveElsewhere(db, HATCH)
      expect(out).toMatchObject({ ok: false, reason: 'location_unreadable' })
    })

    it('a studio whose membership source cannot be read', async () => {
      vi.mocked(radarReadsFor).mockRejectedValue(Object.assign(new Error('membership source unreadable'), { code: 'MEMBERSHIP_SOURCE_UNREADABLE' }))
      const { db } = makeDb({ locations: LOCATIONS })
      const out = await loadActiveElsewhere(db, HATCH)
      expect(out).toMatchObject({ ok: false, reason: 'source_unreadable' })
    })

    it('a membership studio whose adapter lacks the read', async () => {
      seam({ stillorgan: {} })
      const { db } = makeDb({ locations: LOCATIONS })
      const out = await loadActiveElsewhere(db, HATCH)
      expect(out).toMatchObject({ ok: false, reason: 'read_unsupported', studioId: STILL })
    })

    it('the read answers success:false', async () => {
      seam({ stillorgan: { activeMemberContactIds: vi.fn().mockResolvedValue({ success: false, error: 'contacts boom' }) } })
      const { db } = makeDb({ locations: LOCATIONS })
      const out = await loadActiveElsewhere(db, HATCH)
      expect(out).toMatchObject({ ok: false, reason: 'read_failed', studioId: STILL, err: 'contacts boom' })
    })

    it('the read throws', async () => {
      seam({ stillorgan: { activeMemberContactIds: vi.fn().mockRejectedValue(new Error('kaboom')) } })
      const { db } = makeDb({ locations: LOCATIONS })
      const out = await loadActiveElsewhere(db, HATCH)
      expect(out).toMatchObject({ ok: false, reason: 'read_failed', studioId: STILL, err: 'kaboom' })
    })

    it('the person groups cannot be read', async () => {
      seam({ stillorgan: answers(['c-still']) })
      const { db } = makeDb({ locations: LOCATIONS }, { fail: ['person_group_members'] })
      const out = await loadActiveElsewhere(db, HATCH)
      expect(out).toMatchObject({ ok: false, reason: 'groups_unreadable' })
    })
  })
})
