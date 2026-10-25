// BLOCKEDIT.1 review 4 — the "a coach cannot be in two places at once"
// advisory, shared by the assign route and the shift editor. Org-scoped
// (ORGSCOPE.1), never throws, never widens.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))

const { fakeDb, resolveLocations, scopedAssignments, locationScopeOf } = await import('./time-off.test-helpers')
const { findShiftOverlaps } = await import('./shift-overlaps')

const ORGS = { 'loc-1': 'org-1', 'loc-2': 'org-1', 'loc-x': 'org-x' }
const other = (location_id, name, start, end, over = {}) => ({
  profile_id: 'u1', status: 'scheduled', profiles: { full_name: 'Coach A' },
  shift_blocks: { location_id, block_date: '2026-09-30', start_time: start, end_time: end, shift_templates: { name }, locations: { name: `Studio ${location_id}` } },
  ...over,
})

function db(rows, { locationsErr = null, readErr = null } = {}) {
  return fakeDb((q) => {
    if (q.table === 'locations') return locationsErr ? { data: null, error: locationsErr } : resolveLocations(q, ORGS)
    if (readErr) return { data: null, error: readErr }
    return scopedAssignments(q, rows)
  })
}
const args = (windows) => ({ locationId: 'loc-1', blockId: 'b1', blockDate: '2026-09-30', windows })

describe('findShiftOverlaps', () => {
  it("judges each coach's OWN window against their other shifts that day, at this studio and its siblings only", async () => {
    const d = db([other('loc-1', 'Evening', '13:00:00', '15:00:00'), other('loc-2', 'Sibling', '10:00:00', '11:00:00'), other('loc-x', 'Foreign', '12:00:00', '14:00:00')])
    const { clashes } = await findShiftOverlaps(d, args([{ profileId: 'u1', start_time: '12:00:00', end_time: '14:00:00' }]))
    expect(clashes.map((c) => c.text)).toEqual(['Coach A is already on Evening 13:00–15:00 at Studio loc-1 that day — overlaps this shift.'])
    const read = d.queries.find((q) => q.table === 'shift_assignments')
    expect(locationScopeOf(read).sort()).toEqual(['loc-1', 'loc-2'])
    expect(read.calls).toContainEqual(['neq', 'block_id', 'b1'])
    expect(read.calls).toContainEqual(['eq', 'shift_blocks.block_date', '2026-09-30'])
  })

  it('a cancelled assignment is not a shift', async () => {
    const { clashes } = await findShiftOverlaps(db([other('loc-1', 'Evening', '13:00:00', '15:00:00', { status: 'cancelled' })]),
      args([{ profileId: 'u1', start_time: '12:00:00', end_time: '14:00:00' }]))
    expect(clashes).toEqual([])
  })

  it('no windows: reads nothing', async () => {
    const d = db([])
    expect((await findShiftOverlaps(d, args([]))).clashes).toEqual([])
    expect(d.queries).toEqual([])
  })

  it('never throws: an unreadable read is no warnings; unreadable siblings narrow to this studio', async () => {
    expect((await findShiftOverlaps(db([], { readErr: { message: 'down' } }), args([{ profileId: 'u1', start_time: '12:00', end_time: '14:00' }]))).clashes).toEqual([])
    const d = db([other('loc-2', 'Sibling', '12:00:00', '13:00:00')], { locationsErr: { message: 'down' } })
    const { clashes } = await findShiftOverlaps(d, args([{ profileId: 'u1', start_time: '12:00', end_time: '14:00' }]))
    expect(clashes).toEqual([])
    expect(locationScopeOf(d.queries.find((q) => q.table === 'shift_assignments'))).toEqual(['loc-1'])
  })
})
