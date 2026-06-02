// RETIRE-SHIFTS-MIRROR.4 — tests for upsertShiftAssignment (find-or-create
// block + upsert assignment), the writer-side new-model entry point.
import { describe, it, expect } from 'vitest'
import { upsertShiftAssignment } from './roster-write'

// Per-table mock of the supabase builder. `existingBlock` null → the helper
// must create one; captured.blockInsert / captured.assignmentUpsert record
// what was written.
function makeDb({ template, existingBlock, newBlockId = 'blk-new', assignment = { id: 'a1' } }) {
  const captured = { blockInsert: null, assignmentUpsert: null }
  const db = {
    captured,
    from(table) {
      if (table === 'shift_templates') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: template, error: null }) }) }) }
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
})
