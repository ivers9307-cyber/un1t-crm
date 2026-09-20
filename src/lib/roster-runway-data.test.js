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
      const [rows, error] = table === 'shift_templates' ? [templates, templatesError] : [blocks, blocksError]
      const b = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range']) {
        b[m] = (...args) => { call.filters.push([m, ...args]); return b }
      }
      // Like PostgREST: a read is CAPPED at 1,000 rows whatever you ask for,
      // and only .range() moves the window.
      b.then = (resolve, reject) => {
        const range = call.filters.find(([m]) => m === 'range')
        const [lo, hi] = range ? [range[1], Math.min(range[2], range[1] + 999)] : [0, 999]
        return Promise.resolve({ data: error ? null : rows.slice(lo, hi + 1), error }).then(resolve, reject)
      }
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
    expect(await fetchRosterRunways(db, [], { todayIso: TODAY })).toEqual({ success: true, data: { byLocation: {}, weeksByLocation: {} } })
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

  it('templates are read paged and ordered: the 1,001st active template still counts', async () => {
    // 1,000 templates elsewhere come first; NORTH's only one is row 1,001. An
    // un-paged read stops at 1,000 and NORTH silently reads as "nothing to roster".
    const many = [...Array.from({ length: 1000 }, () => tpl(SOUTH, [])), tpl(NORTH)]
    const db = makeDb({ templates: many, blocks: [block(NORTH, '2026-09-28')] })
    const { data } = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(data.byLocation[NORTH]).toMatchObject({ weekStart: '2026-09-28', severity: 'amber' })
    const tplCalls = db.calls.filter((c) => c.table === 'shift_templates')
    expect(tplCalls).toHaveLength(2)
    expect(tplCalls[0].filters).toContainEqual(['order', 'id', { ascending: true }])
    expect(tplCalls[0].filters).toContainEqual(['range', 0, 999])
    expect(tplCalls[1].filters).toContainEqual(['range', 1000, 1999])
  })

  it('reads NEXT Monday to the Sunday of the week after (never the current week), ordered and ranged (the 1,000-row cap)', async () => {
    const db = makeDb({ templates: [tpl(NORTH)] })
    await fetchRosterRunways(db, [NORTH], { todayIso: TODAY })
    const f = db.calls.find((c) => c.table === 'shift_blocks').filters
    expect(f).toContainEqual(['gte', 'block_date', '2026-09-21'])
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

  it('weeksByLocation carries EVERY unready week (the push must not be masked); byLocation is its head', async () => {
    const db = makeDb({
      templates: [tpl(NORTH)],
      blocks: [
        block(NORTH, '2026-09-22', { coaches: 1, roster: 'published' }),
        block(NORTH, '2026-09-23', { coaches: 0, roster: 'published' }), // one shift next week nobody can fill
        block(NORTH, '2026-09-28'),                                      // the week after is unbuilt
      ],
    })
    const { data } = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(data.weeksByLocation[NORTH].map((r) => [r.weekStart, r.severity])).toEqual([['2026-09-21', 'red'], ['2026-09-28', 'amber']])
    expect(data.byLocation[NORTH]).toEqual(data.weeksByLocation[NORTH][0])
    expect(data.weeksByLocation[SOUTH]).toEqual([]) // no active template: nothing, not undefined
  })

  it('a gap in the CURRENT week is not the runway\'s business, even if a row for it turns up', async () => {
    const db = makeDb({
      templates: [tpl(NORTH)],
      blocks: [block(NORTH, '2026-09-20', { coaches: 0, roster: 'published' }), block(NORTH, '2026-09-28')],
    })
    const { data } = await fetchRosterRunways(db, [NORTH], { todayIso: TODAY })
    expect(data.weeksByLocation[NORTH].map((r) => r.weekStart)).toEqual(['2026-09-28'])
    expect(data.byLocation[NORTH]).toMatchObject({ weekStart: '2026-09-28', severity: 'amber' })
  })

  it('a failed read is a failure, never "every week is ready"', async () => {
    expect(await fetchRosterRunways(makeDb({ templatesError: { message: 'tpl down' } }), [NORTH], { todayIso: TODAY }))
      .toEqual({ success: false, error: 'tpl down' })
    expect(await fetchRosterRunways(makeDb({ templates: [tpl(NORTH)], blocksError: { message: 'blocks down' } }), [NORTH], { todayIso: TODAY }))
      .toEqual({ success: false, error: 'blocks down' })
  })
})
