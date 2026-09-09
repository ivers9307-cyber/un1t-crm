// RETIRE-SHIFTS-MIRROR.4 — tests for upsertShiftAssignment (find-or-create
// block + upsert assignment), the writer-side new-model entry point.
import { describe, it, expect } from 'vitest'
import { upsertShiftAssignment, bulkUpsertShiftAssignments } from './roster-write'

// Per-table mock of the supabase builder. `existingBlock` null → the helper
// must create one; captured.blockInsert / captured.assignmentUpsert record
// what was written. `template`/`profileLink` null stand in for the
// location-scoped lookups matching nothing (SAAS-1) — the route-level
// harness in assistant/chat/route.test.js is what actually applies the
// filters against a two-location fixture.
function makeDb({ template, existingBlock, newBlockId = 'blk-new', assignment = { id: 'a1' }, profileLink = { profile_id: 'p1' }, publishedRoster = null, publishedRosters = null }) {
  const captured = { blockInsert: null, assignmentUpsert: null }
  const db = {
    captured,
    from(table) {
      // ROSTER-FIX.4 — findPublishedRosterFor's probe. `publishedRoster` is
      // the one-row shorthand; `publishedRosters` hands the probe a real set
      // and RUNS its date filters, ordering and limit(1), which is the only
      // way to test which roster wins when two of them cover the date.
      if (table === 'rosters') {
        if (publishedRosters) {
          let rows = publishedRosters
          const orders = []
          let cap = rows.length
          const chain = {
            select: () => chain,
            eq: () => chain,
            lte: (col, val) => { rows = rows.filter((r) => r[col] <= val); return chain },
            gte: (col, val) => { rows = rows.filter((r) => r[col] >= val); return chain },
            order: (col, opts) => { orders.push([col, opts?.ascending !== false ? 1 : -1]); return chain },
            limit: (n) => { cap = n; return chain },
            maybeSingle: () => {
              const sorted = [...rows].sort((a, b) => {
                for (const [col, dir] of orders) {
                  if (a[col] < b[col]) return -1 * dir
                  if (a[col] > b[col]) return 1 * dir
                }
                return 0
              })
              return Promise.resolve({ data: sorted.slice(0, cap)[0] || null, error: null })
            },
          }
          return chain
        }
        const chain = {
          select: () => chain, eq: () => chain, lte: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: publishedRoster, error: null }),
        }
        return chain
      }
      if (table === 'shift_templates') {
        const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: template, error: null }) }
        return { select: () => chain }
      }
      if (table === 'profile_locations') {
        const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: profileLink, error: null }) }
        return { select: () => chain }
      }
      if (table === 'shift_blocks') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: existingBlock, error: null }) }) }) }) }),
          insert: (row) => { captured.blockInsert = row; return { select: () => ({ single: () => Promise.resolve({ data: { id: newBlockId }, error: null }) }) } },
        }
      }
      if (table === 'shift_assignments') {
        return { upsert: (row, opts) => { captured.assignmentUpsert = { row, opts }; return { select: () => ({ single: () => Promise.resolve({ data: assignment, error: null }) }) } } }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const template = { start_time: '09:30:00', end_time: '10:30:00', max_coaches: 12 }
const base = { locationId: 'loc1', profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', actorId: 'mgr1' }

describe('upsertShiftAssignment', () => {
  it('reuses an existing block and upserts the assignment (no block insert)', async () => {
    const db = makeDb({ template, existingBlock: { id: 'blk-existing' } })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error).toBeNull()
    expect(res.blockId).toBe('blk-existing')
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentUpsert.row).toMatchObject({ block_id: 'blk-existing', profile_id: 'p1', status: 'scheduled' })
    expect(db.captured.assignmentUpsert.opts).toEqual({ onConflict: 'block_id,profile_id' })
  })

  it('creates the block from template defaults when none exists', async () => {
    const db = makeDb({ template, existingBlock: null })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error).toBeNull()
    expect(res.blockId).toBe('blk-new')
    expect(db.captured.blockInsert).toMatchObject({
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-08',
      start_time: '09:30:00', end_time: '10:30:00', max_coaches: 12, created_by: 'mgr1',
    })
    expect(db.captured.assignmentUpsert.row.block_id).toBe('blk-new')
  })

  it('defaults max_coaches to 15 when the template has none', async () => {
    const db = makeDb({ template: { start_time: '09:00:00', end_time: '10:00:00', max_coaches: null }, existingBlock: null })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.max_coaches).toBe(15)
  })

  it('puts time overrides on the assignment, not the block', async () => {
    const db = makeDb({ template, existingBlock: null })
    await upsertShiftAssignment(db, { ...base, startTimeOverride: '08:00:00', endTimeOverride: '09:00:00' })
    // block keeps template defaults...
    expect(db.captured.blockInsert.start_time).toBe('09:30:00')
    // ...overrides ride on the assignment (mig 100)
    expect(db.captured.assignmentUpsert.row).toMatchObject({ start_time_override: '08:00:00', end_time_override: '09:00:00' })
  })

  it('errors on missing required input', async () => {
    const res = await upsertShiftAssignment(makeDb({ template }), { ...base, shiftDate: null })
    expect(res.error?.message).toMatch(/required/)
  })

  it('errors when the template is not found', async () => {
    const res = await upsertShiftAssignment(makeDb({ template: null, existingBlock: null }), base)
    expect(res.error?.message).toMatch(/template not found/)
  })

  it('errors when the profile is not linked to the location, with no writes (SAAS-1)', async () => {
    const db = makeDb({ template, existingBlock: null, profileLink: null })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error?.message).toMatch(/not linked/)
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentUpsert).toBeNull()
  })

  // ROSTER-FIX.4 — a block created for a date inside an already-published
  // period must JOIN that roster. Left untagged it reads as unpublished to
  // every reader, so the coach just assigned to it never sees the shift.
  it('stamps roster_id on a block created inside an already-published period', async () => {
    const db = makeDb({ template, existingBlock: null, publishedRoster: { id: 'r-live' } })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.roster_id).toBe('r-live')
  })

  it('leaves roster_id null when no published roster covers the date', async () => {
    const db = makeDb({ template, existingBlock: null, publishedRoster: null })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.roster_id).toBeNull()
  })

  // ROSTER-FIX.4 — after a week→month superset publish BOTH rosters still
  // cover the date (the publish guard allows a containing period, and the
  // swallowed week's row stays). The month is the one that owns the day's
  // blocks, so a block created afterwards must join the MONTH — and must do
  // so every time, not per whatever order the rows come back in.
  it('joins the MONTH, not the swallowed week, after a superset publish', async () => {
    const rosters = [
      { id: 'r-week', period_start: '2026-06-01', period_end: '2026-06-07', created_at: '2026-05-20T09:00:00Z' },
      { id: 'r-month', period_start: '2026-06-01', period_end: '2026-06-30', created_at: '2026-05-28T09:00:00Z' },
    ]
    const db = makeDb({ template, existingBlock: null, publishedRosters: rosters })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.roster_id).toBe('r-month')

    const flipped = makeDb({ template, existingBlock: null, publishedRosters: [...rosters].reverse() })
    await upsertShiftAssignment(flipped, base)
    expect(flipped.captured.blockInsert.roster_id).toBe('r-month')
  })

  it('returns the validated template row so callers can reuse its name', async () => {
    const db = makeDb({ template: { ...template, name: 'AM Shift' }, existingBlock: { id: 'blk-existing' } })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error).toBeNull()
    expect(res.template?.name).toBe('AM Shift')
  })
})

// Per-table mock for the batch writer. shift_blocks is queried twice —
// a select-chain (existing-block lookup) and an insert-chain (create) —
// so the builder supports both.
function makeBulkDb({ templates = [], existingBlocks = [], createdBlocks = [], publishedRosters = [], rosterError = null } = {}) {
  const captured = { blockInsert: null, assignmentUpsert: null, rosterQueries: [] }
  const db = {
    captured,
    from(table) {
      // ROSTER-FIX.4 — ONE range query for the whole span, not a probe per
      // date. The mock RUNS its overlap filters and ordering against
      // `publishedRosters` so the per-date match is really being tested, and
      // records each query so "one, not one per date" is assertable.
      if (table === 'rosters') {
        const q = { filters: [], orders: [] }
        captured.rosterQueries.push(q)
        let rows = publishedRosters
        const chain = {
          select: () => chain,
          eq: (col, val) => { q.filters.push(['eq', col, val]); return chain },
          lte: (col, val) => { q.filters.push(['lte', col, val]); rows = rows.filter((r) => r[col] <= val); return chain },
          gte: (col, val) => { q.filters.push(['gte', col, val]); rows = rows.filter((r) => r[col] >= val); return chain },
          order: (col, opts) => { q.orders.push([col, opts]); return chain },
          then: (onF, onR) => {
            if (rosterError) return Promise.resolve({ data: null, error: rosterError }).then(onF, onR)
            const sorted = [...rows].sort((a, b) => {
              for (const [col] of q.orders) {
                // Every order on this query is descending; a null sorts last.
                const av = a[col] ?? ''
                const bv = b[col] ?? ''
                if (av < bv) return 1
                if (av > bv) return -1
              }
              return 0
            })
            return Promise.resolve({ data: sorted, error: null }).then(onF, onR)
          },
        }
        return chain
      }
      if (table === 'shift_templates') {
        // ROSTER-FIX.4 — the bulk path scopes templates to the location too.
        return { select: () => ({ in: () => ({ eq: (col, val) => { captured.templateScope = { col, val }; return Promise.resolve({ data: templates, error: null }) } }) }) }
      }
      if (table === 'shift_blocks') {
        return {
          select: () => ({ eq: () => ({ in: () => ({ gte: () => ({ lte: () => Promise.resolve({ data: existingBlocks, error: null }) }) }) }) }),
          insert: (rows) => { captured.blockInsert = rows; return { select: () => Promise.resolve({ data: createdBlocks, error: null }) } },
        }
      }
      if (table === 'shift_assignments') {
        return { upsert: (rows, opts) => { captured.assignmentUpsert = { rows, opts }; return Promise.resolve({ error: null }) } }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const tpl1 = { id: 't1', start_time: '09:00:00', end_time: '10:00:00', max_coaches: 12 }

describe('bulkUpsertShiftAssignments', () => {
  it('returns 0 with no error for an empty row set', async () => {
    const res = await bulkUpsertShiftAssignments(makeBulkDb(), { locationId: 'loc1', rows: [] })
    expect(res).toEqual({ count: 0, error: null })
  })

  it('reuses existing blocks (no insert) and upserts assignments', async () => {
    const db = makeBulkDb({ templates: [tpl1], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', actorId: 'mgr1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTimeOverride: '08:00:00', endTimeOverride: null, notes: 'n' }],
    })
    expect(res).toEqual({ count: 1, error: null })
    expect(db.captured.blockInsert).toBeNull()
    // ROSTER-FIX.4 (SAAS-1) — templates are read at the caller's location only
    expect(db.captured.templateScope).toEqual({ col: 'location_id', val: 'loc1' })
    expect(db.captured.assignmentUpsert.rows[0]).toMatchObject({
      block_id: 'blk-x', profile_id: 'p1', status: 'scheduled',
      start_time_override: '08:00:00', end_time_override: null, notes: 'n', assigned_by: 'mgr1',
    })
    expect(db.captured.assignmentUpsert.opts).toEqual({ onConflict: 'block_id,profile_id' })
  })

  it('creates missing blocks from template defaults then references them', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [{ id: 'blk-new', template_id: 't1', block_date: '2026-06-08' }],
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', actorId: 'mgr1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }],
    })
    expect(res.count).toBe(1)
    expect(db.captured.blockInsert).toHaveLength(1)
    expect(db.captured.blockInsert[0]).toMatchObject({
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-08',
      start_time: '09:00:00', end_time: '10:00:00', max_coaches: 12, created_by: 'mgr1',
    })
    expect(db.captured.assignmentUpsert.rows[0].block_id).toBe('blk-new')
  })

  it('dedups two rows that map to the same (block, profile)', async () => {
    const db = makeBulkDb({ templates: [tpl1], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', notes: 'first' },
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', notes: 'second' },
      ],
    })
    expect(res.count).toBe(1)
    expect(db.captured.assignmentUpsert.rows).toHaveLength(1)
    expect(db.captured.assignmentUpsert.rows[0].notes).toBe('second') // last wins
  })

  it('defaults max_coaches to 15 when the template has none', async () => {
    const db = makeBulkDb({
      templates: [{ id: 't1', start_time: '09:00:00', end_time: '10:00:00', max_coaches: null }],
      existingBlocks: [], createdBlocks: [{ id: 'blk-new', template_id: 't1', block_date: '2026-06-08' }],
    })
    await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(db.captured.blockInsert[0].max_coaches).toBe(15)
  })

  // ROSTER-FIX.4 — same rule for the copy-week / copy-month batch writer, but
  // resolved for the whole span in ONE query. It used to probe once per
  // distinct date, which is up to 31 round trips for a copy-month.
  it('stamps roster_id per date from a single range query', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [
        { id: 'blk-a', template_id: 't1', block_date: '2026-06-08' },
        { id: 'blk-b', template_id: 't1', block_date: '2026-06-15' },
      ],
      publishedRosters: [
        { id: 'r-live', period_start: '2026-06-01', period_end: '2026-06-10', published_at: '2026-05-30T09:00:00Z', created_at: '2026-05-30T09:00:00Z' },
      ],
    })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-15' },
      ],
    })
    const byDate = Object.fromEntries(db.captured.blockInsert.map((b) => [b.block_date, b.roster_id]))
    expect(byDate['2026-06-08']).toBe('r-live')
    // Outside the published period — the query returned the row, the per-date
    // match is what rules it out.
    expect(byDate['2026-06-15']).toBeNull()
    // ONE query for two dates.
    expect(db.captured.rosterQueries).toHaveLength(1)
    const q = db.captured.rosterQueries[0]
    expect(q.filters).toContainEqual(['eq', 'location_id', 'loc1'])
    expect(q.filters).toContainEqual(['eq', 'status', 'published'])
    // Overlap against the SPAN, not one date: starts on or before the last
    // date, ends on or after the first.
    expect(q.filters).toContainEqual(['lte', 'period_start', '2026-06-15'])
    expect(q.filters).toContainEqual(['gte', 'period_end', '2026-06-08'])
    expect(q.orders).toEqual([
      ['published_at', { ascending: false, nullsFirst: false }],
      ['created_at', { ascending: false }],
    ])
  })

  // The publish guard allows a period that CONTAINS a published one, and the
  // swallowed week's row stays behind — so two rosters can cover one date.
  // The one published most recently owns the day's blocks.
  it('joins the most recently published roster when two cover the date', async () => {
    const rosters = [
      { id: 'r-week', period_start: '2026-06-01', period_end: '2026-06-07', published_at: '2026-05-20T09:00:00Z', created_at: '2026-05-20T09:00:00Z' },
      { id: 'r-month', period_start: '2026-06-01', period_end: '2026-06-30', published_at: '2026-05-28T09:00:00Z', created_at: '2026-05-28T09:00:00Z' },
    ]
    for (const set of [rosters, [...rosters].reverse()]) {
      const db = makeBulkDb({
        templates: [tpl1], existingBlocks: [],
        createdBlocks: [{ id: 'blk-a', template_id: 't1', block_date: '2026-06-03' }],
        publishedRosters: set,
      })
      await bulkUpsertShiftAssignments(db, {
        locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-03' }],
      })
      expect(db.captured.blockInsert[0].roster_id).toBe('r-month')
    }
  })

  it('a never-published row (published_at null) loses to one that has been', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [{ id: 'blk-a', template_id: 't1', block_date: '2026-06-03' }],
      publishedRosters: [
        { id: 'r-old', period_start: '2026-06-01', period_end: '2026-06-30', published_at: null, created_at: '2026-05-29T09:00:00Z' },
        { id: 'r-new', period_start: '2026-06-01', period_end: '2026-06-07', published_at: '2026-05-20T09:00:00Z', created_at: '2026-05-20T09:00:00Z' },
      ],
    })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-03' }],
    })
    expect(db.captured.blockInsert[0].roster_id).toBe('r-new')
  })

  it('a failed roster lookup leaves the blocks unattached rather than losing the copy', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [{ id: 'blk-a', template_id: 't1', block_date: '2026-06-08' }],
      rosterError: { message: 'statement timeout' },
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }],
    })
    // Fails soft, exactly as findPublishedRosterFor does: the operator's
    // copy-week survives, the blocks just aren't on a roster yet.
    expect(res).toEqual({ count: 1, error: null })
    expect(db.captured.blockInsert[0].roster_id).toBeNull()
  })

  it('does not query for a roster when every block already exists', async () => {
    const db = makeBulkDb({ templates: [tpl1], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }] })
    await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(db.captured.rosterQueries).toHaveLength(0)
  })

  it('errors when a referenced template is missing', async () => {
    const db = makeBulkDb({ templates: [] })
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(res.error?.message).toMatch(/shift_template not found/)
    expect(res.count).toBe(0)
  })
})
