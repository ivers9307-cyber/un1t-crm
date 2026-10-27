import { describe, it, expect } from 'vitest'
import { actingStudioOptions, pickActingStudio, resolveRouteStudio } from './contact-acting-studio.js'

const STILL = 'a0000000-0000-4000-8000-00000000000a'
const HATCH = 'b0000000-0000-4000-8000-00000000000b'
const CCF = 'c0000000-0000-4000-8000-00000000000c'
const CONTACT = { id: 'd0000000-0000-4000-8000-00000000000d', location_id: STILL }

const row = (id, name, source, extra = {}) => ({ location_id: id, status: 'active', location: { id, name, active: true, is_host_anchor: false, membership_source: source, ...extra } })
const ROWS = [row(STILL, 'UN1T Stillorgan', 'glofox'), row(HATCH, 'UN1T Hatch Street', 'un1t_online')]
const userAt = (...ids) => ({ id: 'u1', isMaster: false, locations: ids.map((id) => ({ id, name: `L-${id}` })), activeLocation: { id: ids[0] } })
const MASTER = { id: 'm', isMaster: true, locations: [{ id: STILL }, { id: HATCH }, { id: CCF }], activeLocation: { id: CCF } }

describe('actingStudioOptions (CARDLENS.4)', () => {
  it('lists the studios the viewer belongs to where the person has a row, primary first', () => {
    expect(actingStudioOptions({ user: userAt(HATCH, STILL), contact: CONTACT, studioRows: ROWS })).toEqual([
      { locationId: STILL, name: 'UN1T Stillorgan', source: 'glofox', primary: true },
      { locationId: HATCH, name: 'UN1T Hatch Street', source: 'un1t_online', primary: false },
    ])
  })

  it('a Hatch-only coach gets Hatch only', () => {
    expect(actingStudioOptions({ user: userAt(HATCH), contact: CONTACT, studioRows: ROWS }).map((o) => o.locationId)).toEqual([HATCH])
  })

  it('a master gets every studio the person has a row at, never one they do not', () => {
    expect(actingStudioOptions({ user: MASTER, contact: CONTACT, studioRows: ROWS }).map((o) => o.locationId)).toEqual([STILL, HATCH])
  })

  it('skips a closed studio and a host anchor', () => {
    const rows = [...ROWS, row(CCF, 'CCF Autos', 'none', { active: false })]
    expect(actingStudioOptions({ user: MASTER, contact: CONTACT, studioRows: rows }).map((o) => o.locationId)).toEqual([STILL, HATCH])
    const anchor = [...ROWS, row(CCF, 'Host', 'none', { is_host_anchor: true })]
    expect(actingStudioOptions({ user: MASTER, contact: CONTACT, studioRows: anchor }).map((o) => o.locationId)).toEqual([STILL, HATCH])
  })

  it('an ended relationship still counts (decision 1: any status)', () => {
    const rows = [ROWS[0], { ...ROWS[1], status: 'ended' }]
    expect(actingStudioOptions({ user: userAt(HATCH), contact: CONTACT, studioRows: rows }).map((o) => o.locationId)).toEqual([HATCH])
  })

  it('the primary counts even when its row is missing (a failed read included)', () => {
    expect(actingStudioOptions({ user: userAt(STILL), contact: CONTACT, studioRows: [] })).toEqual([
      { locationId: STILL, name: `L-${STILL}`, source: null, primary: true },
    ])
  })
})

describe('pickActingStudio (CARDLENS.4)', () => {
  const options = [{ locationId: STILL }, { locationId: HATCH }]
  it('takes the requested studio when it is an option', () => {
    expect(pickActingStudio({ options, requested: HATCH, activeLocationId: STILL, primaryLocationId: STILL })).toBe(HATCH)
  })
  it('falls back from a studio that is not an option, or garbage', () => {
    expect(pickActingStudio({ options, requested: CCF, activeLocationId: HATCH, primaryLocationId: STILL })).toBe(HATCH)
    expect(pickActingStudio({ options, requested: 'not-a-uuid', activeLocationId: null, primaryLocationId: STILL })).toBe(STILL)
  })
  it('prefers the active studio, then the primary, then the first option', () => {
    expect(pickActingStudio({ options, requested: null, activeLocationId: HATCH, primaryLocationId: STILL })).toBe(HATCH)
    expect(pickActingStudio({ options, requested: null, activeLocationId: CCF, primaryLocationId: STILL })).toBe(STILL)
    expect(pickActingStudio({ options: [{ locationId: HATCH }], requested: null, activeLocationId: CCF, primaryLocationId: STILL })).toBe(HATCH)
  })
  it('null when the viewer shares no studio (a crossover viewer)', () => {
    expect(pickActingStudio({ options: [], requested: HATCH, activeLocationId: HATCH, primaryLocationId: STILL })).toBeNull()
  })
})

function dbWithRows(rows, error = null) {
  const calls = []
  return {
    calls,
    from(table) {
      const chain = { select: () => chain, eq: () => chain, in: async (_c, ids) => { calls.push({ table, ids }); return { data: error ? null : rows.filter((r) => ids.includes(r.location_id)), error } } }
      return chain
    },
  }
}

describe('resolveRouteStudio (CARDLENS.4)', () => {
  it('no location_id: the primary, unchecked here (the route keeps its own checks)', async () => {
    const db = dbWithRows([])
    expect(await resolveRouteStudio(db, userAt(HATCH), CONTACT, undefined)).toEqual({ locationId: STILL })
    expect(db.calls).toEqual([])
  })

  it('the primary named explicitly: the primary, no read', async () => {
    const db = dbWithRows([])
    expect(await resolveRouteStudio(db, userAt(STILL), CONTACT, STILL)).toEqual({ locationId: STILL })
    expect(db.calls).toEqual([])
  })

  it('a studio the person has a row at and the caller belongs to', async () => {
    const db = dbWithRows([{ location_id: HATCH, status: 'ended' }])
    expect(await resolveRouteStudio(db, userAt(HATCH), CONTACT, HATCH)).toEqual({ locationId: HATCH })
  })

  it('404 when the caller does not belong to that studio, without reading', async () => {
    const db = dbWithRows([{ location_id: HATCH, status: 'active' }])
    const r = await resolveRouteStudio(db, userAt(STILL), CONTACT, HATCH)
    expect(r.response.status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('404 when the person has no row at that studio', async () => {
    const r = await resolveRouteStudio(dbWithRows([]), userAt(CCF), CONTACT, CCF)
    expect(r.response.status).toBe(404)
  })

  it('503 when the relationship read fails, never an admit', async () => {
    const r = await resolveRouteStudio(dbWithRows([], { message: 'boom' }), userAt(HATCH), CONTACT, HATCH)
    expect(r.response.status).toBe(503)
  })
})
