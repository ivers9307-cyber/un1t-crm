// RUNWAY.1 — the runway reader: which locations are read, what window, and
// that a failed read is a failure (never "ready").

import { describe, it, expect } from 'vitest'
import { fetchRosterRunways } from './roster-runway-data'

const TODAY = '2026-09-19'
const NORTH = 'loc-north'
const SOUTH = 'loc-south' // no active templates: the Hatch Street case

function makeDb({ templates = [], templatesError = null, blocks = [], blocksError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, filters: [] }
      calls.push(call)
      const result = table === 'shift_templates'
        ? { data: templates, error: templatesError }
        : { data: blocks, error: blocksError }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range']) {
        b[m] = (...args) => { call.filters.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return b
    },
  }
}

const tpl = (location_id, days_of_week = ['mon']) => ({ location_id, days_of_week })
const block = (location_id, block_date, { coaches = 0, roster = null } = {}) => ({
  id: `${location_id}-${block_date}`, location_id, block_date, min_coaches: 1,
  rosters: roster ? { status: roster } : null,
  shift_assignments: Array.from({ length: coaches }, () => ({ profile_id: 'p', status: 'scheduled' })),
})

describe('fetchRosterRunways', () => {
  it('no locations -> no queries', async () => {
    const db = makeDb()
    expect(await fetchRosterRunways(db, [], { todayIso: TODAY })).toEqual({ success: true, data: { byLocation: {} } })
    expect(db.calls).toEqual([])
  })

  it('a location with no active template is null and its blocks are never read', async () => {
    const db = makeDb({ templates: [tpl(NORTH)], blocks: [block(NORTH, '2026-09-28')] })
    const res = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(res.success).toBe(true)
    expect(res.data.byLocation[SOUTH]).toBeNull()
    expect(res.data.byLocation[NORTH]).toMatchObject({ weekStart: '2026-09-28', severity: 'amber', unstaffed: 1, unpublished: 1 })
    const blockCall = db.calls.find((c) => c.table === 'shift_blocks')
    expect(blockCall.filters).toContainEqual(['in', 'location_id', [NORTH]])
  })

  it('a template with no weekdays generates nothing, so it does not count as active', async () => {
    const db = makeDb({ templates: [tpl(NORTH, [])] })
    const res = await fetchRosterRunways(db, [NORTH], { todayIso: TODAY })
    expect(res.data.byLocation).toEqual({ [NORTH]: null })
    expect(db.calls.map((c) => c.table)).toEqual(['shift_templates'])
  })

  it('reads today to the Sunday of the third week, ordered and ranged (the 1,000-row cap)', async () => {
    const db = makeDb({ templates: [tpl(NORTH)] })
    await fetchRosterRunways(db, [NORTH], { todayIso: TODAY })
    const f = db.calls.find((c) => c.table === 'shift_blocks').filters
    expect(f).toContainEqual(['gte', 'block_date', '2026-09-19'])
    expect(f).toContainEqual(['lte', 'block_date', '2026-10-04'])
    expect(f).toContainEqual(['order', 'id', { ascending: true }])
    expect(f).toContainEqual(['range', 0, 999])
  })

  it("keeps each location's blocks apart", async () => {
    const db = makeDb({
      templates: [tpl(NORTH), tpl(SOUTH)],
      blocks: [block(NORTH, '2026-09-28', { coaches: 1, roster: 'published' }), block(SOUTH, '2026-09-28')],
    })
    const { data } = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(data.byLocation[NORTH]).toBeNull()
    expect(data.byLocation[SOUTH]).toMatchObject({ weekStart: '2026-09-28' })
  })

  it('a failed read is a failure, never "every week is ready"', async () => {
    expect(await fetchRosterRunways(makeDb({ templatesError: { message: 'tpl down' } }), [NORTH], { todayIso: TODAY }))
      .toEqual({ success: false, error: 'tpl down' })
    expect(await fetchRosterRunways(makeDb({ templates: [tpl(NORTH)], blocksError: { message: 'blocks down' } }), [NORTH], { todayIso: TODAY }))
      .toEqual({ success: false, error: 'blocks down' })
  })
})
