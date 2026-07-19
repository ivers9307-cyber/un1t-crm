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
function makeDb({ template, existingBlock, newBlockId = 'blk-new', assignment = { id: 'a1' }, profileLink = { profile_id: 'p1' } }) {
  const captured = { blockInsert: null, assignmentUpsert: null }
  const db = {
    captured,
    from(table) {
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
function makeBulkDb({ templates = [], existingBlocks = [], createdBlocks = [] } = {}) {
  const captured = { blockInsert: null, assignmentUpsert: null }
  const db = {
    captured,
    from(table) {
      if (table === 'shift_templates') {
        return { select: () => ({ in: () => Promise.resolve({ data: templates, error: null }) }) }
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

  it('errors when a referenced template is missing', async () => {
    const db = makeBulkDb({ templates: [] })
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(res.error?.message).toMatch(/shift_template not found/)
    expect(res.count).toBe(0)
  })
})
