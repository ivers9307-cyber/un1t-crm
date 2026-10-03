// src/lib/roster-grid-data.test.js
// GRID.1 — the grid's one server read. Pinned: who gets a row, the
// organisation boundary, that no pay column is ever selected, what degrades
// and what fails, and paging. The arithmetic is roster-grid-model.test.js's.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { siblingLocationIds } = await import('./sibling-locations')
const { logWarn } = await import('./log')
const { loadRosterGrid } = await import('./roster-grid-data')

const HERE = 'loc-north'
const SOUTH = 'loc-south'
const FOREIGN = 'loc-other-org'
const WEEK = '2026-09-21'

const A = (id, profile_id, location_id, block_date, start_time, end_time, over = {}) => ({
  id,
  profile_id,
  status: over.status || 'scheduled',
  start_time_override: null,
  end_time_override: null,
  shift_blocks: {
    id: `b-${id}`,
    location_id,
    block_date,
    start_time,
    end_time,
    shift_templates: { name: over.name || 'Strength', start_time, end_time, kind: over.kind || 'class' },
    locations: { name: location_id === HERE ? 'Studio North' : 'Studio South' },
  },
})

const PROFILES = [
  { id: 'p-emp', full_name: 'Alex Example', active: true, deleted_at: null, employment_type: 'fte', contracted_hours_per_week: 39 },
  { id: 'p-con', full_name: 'Jordan Sample', active: true, deleted_at: null, employment_type: 'contractor', contracted_hours_per_week: 40 },
  { id: 'p-off', full_name: 'Sam Demo', active: false, deleted_at: null, employment_type: 'fte', contracted_hours_per_week: 20 },
  { id: 'p-visit', full_name: 'Max Beta', active: true, deleted_at: null, employment_type: 'fte', contracted_hours_per_week: '37.5' },
  { id: 'p-gone', full_name: 'Toby Beta', active: false, deleted_at: '2026-09-01T00:00:00Z', employment_type: 'fte', contracted_hours_per_week: 30 },
]
const LINKS = ['p-emp', 'p-con', 'p-off']
const HERE_ROWS = [
  A('h1', 'p-emp', HERE, '2026-09-21', '09:00:00', '12:00:00'),
  A('h2', 'p-visit', HERE, '2026-09-23', '10:00:00', '11:00:00'), // not on the team, holds a shift here
  A('h3', 'p-gone', HERE, '2026-09-24', '10:00:00', '11:00:00'), // a tombstone's history
  A('h4', 'p-off', HERE, '2026-09-20', '10:00:00', '11:00:00'), // inactive, the Sunday before only
  A('h5', 'p-emp', HERE, '2026-09-22', '09:00:00', '10:00:00', { status: 'cancelled' }),
]
const ELSEWHERE_ROWS = [
  A('s1', 'p-emp', SOUTH, '2026-09-22', '18:00:00', '20:00:00', { name: 'Evening' }),
  A('s2', 'p-emp', FOREIGN, '2026-09-22', '07:00:00', '08:00:00'), // another organisation: must be dropped
  A('s3', 'p-con', SOUTH, '2026-09-28', '09:00:00', '10:00:00'), // the Monday after: kept for rest gaps
]

function fakeDb({ links = LINKS, profiles = PROFILES, here = HERE_ROWS, elsewhere = ELSEWHERE_ROWS, fail = {} } = {}) {
  const calls = []
  const filter = (q, op, col) => q.filters.find(([o, c]) => o === op && c === col)?.[2]
  const answer = (q) => {
    if (fail[q.table]) return { data: null, error: { message: `${q.table} down` } }
    if (q.table === 'profile_locations') {
      const rows = links.map((profile_id) => ({ profile_id }))
      const [from, to] = q.range || [0, rows.length - 1]
      return { data: rows.slice(from, to + 1), error: null }
    }
    if (q.table === 'profiles') {
      const ids = filter(q, 'in', 'id')
      return { data: profiles.filter((p) => ids.includes(p.id)), error: null }
    }
    if (q.table === 'shift_assignments') {
      const isHere = filter(q, 'eq', 'shift_blocks.location_id') === HERE
      if (isHere && fail.here) return { data: null, error: { message: 'here down' } }
      if (!isHere && fail.elsewhere) return { data: null, error: { message: 'elsewhere down' } }
      const ids = filter(q, 'in', 'profile_id')
      const rows = isHere ? here : elsewhere.filter((a) => ids.includes(a.profile_id))
      const [from, to] = q.range || [0, rows.length - 1]
      return { data: rows.slice(from, to + 1), error: null }
    }
    throw new Error(`unexpected table ${q.table}`)
  }
  return {
    calls,
    from(table) {
      const q = { table, select: null, filters: [], range: null }
      calls.push(q)
      const chain = {
        select(cols) { q.select = cols; return chain },
        eq(col, v) { q.filters.push(['eq', col, v]); return chain },
        in(col, v) { q.filters.push(['in', col, v]); return chain },
        gte(col, v) { q.filters.push(['gte', col, v]); return chain },
        lte(col, v) { q.filters.push(['lte', col, v]); return chain },
        order() { return chain },
        range(a, b) { q.range = [a, b]; return chain },
        then(resolve, reject) { return Promise.resolve().then(() => answer(q)).then(resolve, reject) },
      }
      return chain
    },
  }
}

beforeEach(() => {
  siblingLocationIds.mockReset().mockResolvedValue({ ids: [SOUTH], error: null })
  logWarn.mockReset()
})

describe('loadRosterGrid', () => {
  it('the team, plus anyone holding a shift here that week; contracted hours for employees only', async () => {
    const { data, error } = await loadRosterGrid(fakeDb(), { locationId: HERE, weekStart: WEEK, showContract: true })
    expect(error).toBeNull()
    expect(data.contract_visible).toBe(true)
    expect(data.week_start).toBe(WEEK)
    expect(data.week_end).toBe('2026-09-27')
    expect(data.members).toEqual([
      { profile_id: 'p-emp', full_name: 'Alex Example', employment_type: 'fte', contracted_hours: 39, member: true },
      // A contractor's column holds 40 (mig 012's default): never sent.
      { profile_id: 'p-con', full_name: 'Jordan Sample', employment_type: 'contractor', contracted_hours: null, member: true },
      { profile_id: 'p-visit', full_name: 'Max Beta', employment_type: 'fte', contracted_hours: 37.5, member: false },
      { profile_id: 'p-gone', full_name: 'Toby Beta', employment_type: 'fte', contracted_hours: 30, member: false },
    ])
  })

  it("every live shift of those people, here and at the organisation's other studios, Sunday before to Monday after", async () => {
    const db = fakeDb()
    const { data } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(data.shifts.map((s) => s.assignment_id)).toEqual(['h1', 'h2', 'h3', 's1', 's3'])
    expect(data.shifts[0]).toEqual({
      assignment_id: 'h1', profile_id: 'p-emp', status: 'scheduled',
      block_id: 'b-h1', block_date: '2026-09-21', location_id: HERE, location_name: 'Studio North', here: true,
      kind: 'class', name: 'Strength', start_time: '09:00:00', end_time: '12:00:00',
      start_time_override: null, end_time_override: null,
      shift_templates: { start_time: '09:00:00', end_time: '12:00:00' },
    })
    expect(data.shifts[3]).toMatchObject({ assignment_id: 's1', location_id: SOUTH, location_name: 'Studio South', here: false, name: 'Evening' })
    const reads = db.calls.filter((q) => q.table === 'shift_assignments')
    for (const q of reads) {
      expect(q.filters).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-20'])
      expect(q.filters).toContainEqual(['lte', 'shift_blocks.block_date', '2026-09-28'])
    }
    const elsewhereRead = reads.find((q) => q.filters.some(([op, col]) => op === 'in' && col === 'shift_blocks.location_id'))
    expect(elsewhereRead.filters).toContainEqual(['in', 'shift_blocks.location_id', [SOUTH]])
    expect(elsewhereRead.filters).toContainEqual(['in', 'profile_id', ['p-emp', 'p-con', 'p-visit', 'p-gone']])
    expect(data.cross_studio_checked).toBe(true)
  })

  it('a row from a studio outside the organisation is dropped even if returned; so is a cancelled one', async () => {
    const { data } = await loadRosterGrid(fakeDb(), { locationId: HERE, weekStart: WEEK })
    expect(data.shifts.some((s) => s.location_id === FOREIGN)).toBe(false)
    expect(data.shifts.some((s) => s.assignment_id === 'h5')).toBe(false)
    // p-off is inactive and only had the Sunday before: no row, no shift.
    expect(data.members.some((m) => m.profile_id === 'p-off')).toBe(false)
    expect(data.shifts.some((s) => s.profile_id === 'p-off')).toBe(false)
  })

  it('names its columns: no pay column is ever selected, and profile_compensation is never read', async () => {
    const db = fakeDb()
    await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK, showContract: true })
    expect(db.calls.find((q) => q.table === 'profiles').select)
      .toBe('id, full_name, active, deleted_at, employment_type, contracted_hours_per_week')
    expect(db.calls.some((q) => q.table === 'profile_compensation')).toBe(false)
    for (const q of db.calls) {
      expect(q.select).not.toMatch(/\*|hourly_rate|annual_salary|overtime_rate|annual_leave/)
    }
  })

  it('unreadable sibling studios: this studio only, cross_studio_checked false, no other studio read', async () => {
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'locations down' } })
    const db = fakeDb()
    const { data, error } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(error).toBeNull()
    expect(data.cross_studio_checked).toBe(false)
    expect(data.shifts.every((s) => s.here)).toBe(true)
    expect(db.calls.filter((q) => q.table === 'shift_assignments')).toHaveLength(1)
    expect(logWarn).toHaveBeenCalled()
  })

  it("a failed read of the other studios' shifts narrows the grid, it does not fail it", async () => {
    const { data, error } = await loadRosterGrid(fakeDb({ fail: { elsewhere: true } }), { locationId: HERE, weekStart: WEEK })
    expect(error).toBeNull()
    expect(data.cross_studio_checked).toBe(false)
    expect(data.shifts.map((s) => s.assignment_id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('a failed team, profiles or this-studio read is an error with no grid, never an empty one', async () => {
    for (const fail of [{ profile_locations: true }, { profiles: true }, { here: true }]) {
      const res = await loadRosterGrid(fakeDb({ fail }), { locationId: HERE, weekStart: WEEK })
      expect(res.data).toBeNull()
      expect(res.error.message).toMatch(/down/)
    }
  })

  it('pages this studio past 1,000 rows', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => A(`h${String(i).padStart(4, '0')}`, 'p-emp', HERE, '2026-09-21', '09:00:00', '10:00:00'))
    const db = fakeDb({ here: many })
    const { data } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(data.shifts.filter((s) => s.here)).toHaveLength(1001)
    const hereReads = db.calls.filter((q) => q.table === 'shift_assignments' && q.filters.some(([op]) => op === 'eq'))
    expect(hereReads.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('pages the team read too, with an explicit order', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `p-team-${String(i).padStart(4, '0')}`)
    const db = fakeDb({ links: many, profiles: [] })
    const { error } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(error).toBeNull()
    expect(db.calls.filter((q) => q.table === 'profile_locations').map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
  })

  // GRID.1 review 1 — contracted hours go to owner, manager and master only
  // (CANDIDATES.1). A head coach keeps the grid, but the column is not even
  // read for them, and no member carries the key.
  it('contract hidden (the default): contracted hours are neither read nor returned', async () => {
    for (const opts of [{ showContract: false }, {}]) {
      const db = fakeDb()
      const { data, error } = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK, ...opts })
      expect(error).toBeNull()
      expect(data.contract_visible).toBe(false)
      expect(db.calls.find((q) => q.table === 'profiles').select)
        .toBe('id, full_name, active, deleted_at, employment_type')
      for (const m of data.members) expect(m).not.toHaveProperty('contracted_hours')
      expect(data.members.map((m) => m.profile_id)).toEqual(['p-emp', 'p-con', 'p-visit', 'p-gone'])
      expect(JSON.stringify(data)).not.toMatch(/contracted/)
    }
  })

  it('never throws', async () => {
    const db = { from() { throw new Error('client gone') } }
    const res = await loadRosterGrid(db, { locationId: HERE, weekStart: WEEK })
    expect(res).toEqual({ data: null, error: { message: 'client gone' } })
  })
})
