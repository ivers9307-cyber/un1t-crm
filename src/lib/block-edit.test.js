// src/lib/block-edit.test.js
// BLOCKEDIT.1 — what editing ONE shift block means. Pure; table-driven.
import { describe, it, expect } from 'vitest'
import { planBlockEdit, toHms, sameWindow, blockEditNoticeText } from './block-edit'

const coach = (id, name, over = {}) => ({
  id: `a-${id}`, profile_id: id, status: 'scheduled',
  start_time_override: null, end_time_override: null, profiles: { full_name: name }, ...over,
})
const block = (over = {}) => ({
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-30',
  start_time: '09:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3, briefing: null,
  shift_templates: { name: 'Morning', kind: 'class' },
  shift_assignments: [coach('u1', 'Coach A')],
  ...over,
})

describe('toHms / sameWindow', () => {
  it('reads HH:MM and HH:MM:SS as the same time, anything else as null', () => {
    expect(toHms('09:00')).toBe('09:00:00')
    expect(toHms('09:00:00')).toBe('09:00:00')
    expect(toHms(null)).toBeNull()
    expect(toHms('9am')).toBeNull()
    expect(sameWindow({ start_time: '09:00', end_time: '12:00:00' }, { start_time: '09:00:00', end_time: '12:00' })).toBe(true)
  })
})

describe('planBlockEdit — refusals', () => {
  it('nothing editable in the body is a 400', () => {
    const p = planBlockEdit({ block: block(), body: { allow_below_assigned: true } })
    expect(p).toMatchObject({ ok: false, status: 400, body: { error: 'nothing_to_change' } })
  })

  it('an end at or before the start is a 400 (mirrors shift_blocks_time_order)', () => {
    expect(planBlockEdit({ block: block(), body: { end_time: '09:00' } }).body.error).toBe('end_not_after_start')
    expect(planBlockEdit({ block: block(), body: { start_time: '13:00' } }).body.error).toBe('end_not_after_start')
  })

  it('a minimum above the maximum is a 400', () => {
    expect(planBlockEdit({ block: block(), body: { min_coaches: 4 } }).body.error).toBe('min_above_max')
    expect(planBlockEdit({ block: block(), body: { max_coaches: 1, min_coaches: 2 } }).body.error).toBe('min_above_max')
  })

  it("an admin shift's minimum above 0 is SHIFTTYPE's 400; 0 and omitted are fine", () => {
    const admin = block({ min_coaches: 0, shift_templates: { name: 'Stock take', kind: 'admin' } })
    expect(planBlockEdit({ block: admin, body: { min_coaches: 1 } })).toMatchObject({ ok: false, status: 400, body: { error: 'admin_has_no_minimum' } })
    expect(planBlockEdit({ block: admin, body: { min_coaches: 0, max_coaches: 2 } }).ok).toBe(true)
    expect(planBlockEdit({ block: admin, body: { start_time: '08:00' } }).ok).toBe(true)
  })

  it('a maximum below the coaches on the shift is a 409 unless allowed, and then a warning', () => {
    const two = block({ shift_assignments: [coach('u1', 'Coach A'), coach('u2', 'Coach B')] })
    const refused = planBlockEdit({ block: two, body: { max_coaches: 1, min_coaches: 1 } })
    expect(refused).toMatchObject({ ok: false, status: 409, body: { error: 'below_assigned', assigned: 2 } })
    const allowed = planBlockEdit({ block: two, body: { max_coaches: 1, min_coaches: 1, allow_below_assigned: true } })
    expect(allowed.ok).toBe(true)
    expect(allowed.warnings.join(' ')).toMatch(/2 coaches are on this shift/)
  })

  it('cancelled rows are not on the shift, so they never count against the maximum', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A'), coach('u2', 'Coach B', { status: 'cancelled' })] })
    expect(planBlockEdit({ block: b, body: { max_coaches: 1 } }).ok).toBe(true)
  })

  it('a shift already over its maximum can still have its TIMES edited', () => {
    const over = block({ max_coaches: 1, shift_assignments: [coach('u1', 'Coach A'), coach('u2', 'Coach B')] })
    expect(planBlockEdit({ block: over, body: { start_time: '08:00' } }).ok).toBe(true)
  })
})

describe('planBlockEdit — the patch', () => {
  it('equal values are a no-op: nothing to write, log or tell', () => {
    expect(planBlockEdit({ block: block(), body: { start_time: '09:00', max_coaches: 3, briefing: '  ' } }))
      .toEqual({ ok: true, unchanged: true })
  })

  it('writes only what changed, times in HH:MM:SS, the briefing trimmed', () => {
    const p = planBlockEdit({ block: block(), body: { start_time: '09:30', end_time: '12:00', briefing: ' Fire drill at 10 ' } })
    expect(p.patch).toEqual({ start_time: '09:30:00', briefing: 'Fire drill at 10' })
  })

  it('blank clears a briefing', () => {
    const p = planBlockEdit({ block: block({ briefing: 'Old' }), body: { briefing: '' } })
    expect(p.patch).toEqual({ briefing: null })
    expect(p.blockDetails).toEqual({ source: 'block_edit', briefing: 'removed' })
  })

  it('the block_edited details record what changed, never the briefing text', () => {
    const p = planBlockEdit({ block: block(), body: { start_time: '10:00', end_time: '13:00', min_coaches: 2, briefing: 'Secret-ish' } })
    expect(p.blockDetails).toEqual({
      source: 'block_edit',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      min_coaches: { from: 1, to: 2 },
      briefing: 'added',
    })
    expect(JSON.stringify(p.blockDetails)).not.toMatch(/Secret/)
  })
})

describe('planBlockEdit — coaches and their own hours (D3)', () => {
  it('a coach with no override moves with the shift', () => {
    const p = planBlockEdit({ block: block(), body: { start_time: '10:00', end_time: '13:00' } })
    expect(p.followUpdates).toEqual([])
    expect(p.affected).toEqual([{
      assignmentId: 'a-u1', coachId: 'u1',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      toIfStuck: { start_time: '10:00:00', end_time: '13:00:00' },
    }])
    expect(p.kept).toEqual([])
  })

  it('an override EQUAL to the old block time follows: it is cleared, guarded on its old value', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A', { start_time_override: '09:00' })] })
    const p = planBlockEdit({ block: b, body: { start_time: '10:00' } })
    expect(p.followUpdates).toEqual([{
      assignmentId: 'a-u1', coachId: 'u1',
      patch: { start_time_override: null },
      expect: { start_time_override: '09:00' },
    }])
    expect(p.affected[0].to).toEqual({ start_time: '10:00:00', end_time: '12:00:00' })
    // If that write fails the coach still has 09:00, which is what they get told.
    expect(p.affected[0].toIfStuck).toEqual({ start_time: '09:00:00', end_time: '12:00:00' })
  })

  it('a DIFFERENT override stays, the coach is not affected, and the manager is told who kept their hours', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A', { start_time_override: '10:30:00' })] })
    const p = planBlockEdit({ block: b, body: { start_time: '10:00' } })
    expect(p.followUpdates).toEqual([])
    expect(p.affected).toEqual([])
    expect(p.kept).toEqual([{ assignmentId: 'a-u1', coachId: 'u1', name: 'Coach A', window: { start_time: '10:30:00', end_time: '12:00:00' } }])
    expect(p.warnings.join(' ')).toMatch(/Coach A keeps their own hours \(10:30am–12pm\)/)
  })

  it('per field: a kept start override does not stop the END moving the coach', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A', { start_time_override: '10:30:00' })] })
    const p = planBlockEdit({ block: b, body: { end_time: '13:00' } })
    expect(p.affected[0]).toMatchObject({ from: { start_time: '10:30:00', end_time: '12:00:00' }, to: { start_time: '10:30:00', end_time: '13:00:00' } })
    // The END changed and the coach has no end override: nothing kept.
    expect(p.kept).toEqual([])
  })

  it('a minimum, maximum or briefing edit moves nobody', () => {
    const p = planBlockEdit({ block: block(), body: { max_coaches: 4, briefing: 'x' } })
    expect(p.affected).toEqual([])
    expect(p.followUpdates).toEqual([])
  })
})

describe('blockEditNoticeText', () => {
  it('says when the coaches will be told, or nothing', () => {
    expect(blockEditNoticeText(null)).toBe('')
    expect(blockEditNoticeText({ coaches: 0, when: 'shortly' })).toBe('')
    expect(blockEditNoticeText({ coaches: 1, when: 'shortly' })).toBe('Saved. The coach on this shift will be told in the next few minutes.')
    expect(blockEditNoticeText({ coaches: 2, when: 'morning' })).toBe('Saved. The 2 coaches on this shift will be told after 7am (no notifications overnight).')
  })
})
