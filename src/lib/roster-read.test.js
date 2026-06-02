// RETIRE-SHIFTS-MIRROR.5b — tests for the copy-route source reader:
// effectiveOverride (collapse block + assignment override vs template)
// and fetchSourceShiftRows (new-model read, normalised rows).
import { describe, it, expect } from 'vitest'
import { effectiveOverride, fetchSourceShiftRows, swapShiftShape } from './roster-read'

describe('effectiveOverride', () => {
  it('prefers the per-assignment override when set', () => {
    expect(effectiveOverride('08:00:00', '09:30:00', '09:00:00')).toBe('08:00:00')
  })

  it('falls back to the block time when it differs from the template', () => {
    expect(effectiveOverride(null, '09:30:00', '09:00:00')).toBe('09:30:00')
  })

  it('returns null when block matches template and no assignment override', () => {
    expect(effectiveOverride(null, '09:00:00', '09:00:00')).toBeNull()
  })

  it('returns null when nothing is set', () => {
    expect(effectiveOverride(null, null, null)).toBeNull()
  })
})

// Minimal builder mock: the chained filters all return `this`, and the
// builder is awaited (thenable) to yield { data, error }.
function makeDb(result) {
  const builder = {
    select() { return this },
    eq() { return this },
    gte() { return this },
    lte() { return this },
    then(resolve) { return Promise.resolve(result).then(resolve) },
  }
  return { from() { return builder } }
}

describe('fetchSourceShiftRows', () => {
  it('normalises assignments + blocks into copy rows with effective overrides', async () => {
    const db = makeDb({
      data: [
        {
          profile_id: 'p1',
          notes: 'hi',
          start_time_override: '08:00:00',
          end_time_override: null,
          shift_blocks: {
            location_id: 'loc1', template_id: 't1', block_date: '2026-06-01',
            start_time: '09:00:00', end_time: '10:00:00',
            shift_templates: { start_time: '09:00:00', end_time: '10:00:00' },
          },
        },
        {
          // no assignment override, but block time deviates from template
          profile_id: 'p2',
          notes: null,
          start_time_override: null,
          end_time_override: null,
          shift_blocks: {
            location_id: 'loc1', template_id: 't2', block_date: '2026-06-02',
            start_time: '07:30:00', end_time: '08:30:00',
            shift_templates: { start_time: '08:00:00', end_time: '09:00:00' },
          },
        },
      ],
      error: null,
    })
    const { rows, error } = await fetchSourceShiftRows(db, { locationId: 'loc1', startDate: '2026-06-01', endDate: '2026-06-07' })
    expect(error).toBeNull()
    expect(rows).toHaveLength(2)
    // p1: assignment override wins, end inherits template (null)
    expect(rows[0]).toMatchObject({
      profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-01',
      startTimeOverride: '08:00:00', endTimeOverride: null, notes: 'hi',
    })
    // p2: block-vs-template deviation collapses onto the override
    expect(rows[1]).toMatchObject({
      profileId: 'p2', shiftTemplateId: 't2', shiftDate: '2026-06-02',
      startTimeOverride: '07:30:00', endTimeOverride: '08:30:00', notes: null,
    })
  })

  it('skips rows with no joined block and surfaces query errors', async () => {
    const ok = makeDb({ data: [{ profile_id: 'p1', shift_blocks: null }], error: null })
    expect((await fetchSourceShiftRows(ok, { locationId: 'l', startDate: 'a', endDate: 'b' })).rows).toHaveLength(0)

    const bad = makeDb({ data: null, error: { message: 'boom' } })
    const res = await fetchSourceShiftRows(bad, { locationId: 'l', startDate: 'a', endDate: 'b' })
    expect(res.error?.message).toBe('boom')
    expect(res.rows).toEqual([])
  })
})

describe('swapShiftShape', () => {
  it('returns null for a null assignment (drop request has no target)', () => {
    expect(swapShiftShape(null)).toBeNull()
  })

  it('flattens an embedded assignment into the legacy swap-shift shape', () => {
    const shaped = swapShiftShape({
      id: 'a1',
      profile_id: 'p1',
      status: 'scheduled',
      notes: 'n',
      start_time_override: null,
      end_time_override: '11:00:00',
      shift_blocks: {
        block_date: '2026-06-08',
        start_time: '09:00:00',
        end_time: '10:00:00',
        shift_templates: { name: 'AM HIIT', start_time: '09:00:00', end_time: '10:00:00', role_label: 'Coach' },
      },
      profiles: { id: 'p1', full_name: 'Dana' },
    })
    expect(shaped).toMatchObject({
      id: 'a1',
      profile_id: 'p1',
      status: 'scheduled',
      shift_date: '2026-06-08',
      // block matches template → no start override; assignment carries the end override
      start_time_override: null,
      end_time_override: '11:00:00',
      role_label: 'Coach',
    })
    expect(shaped.shift_templates.name).toBe('AM HIIT')
    expect(shaped.profiles.full_name).toBe('Dana')
  })

  it('collapses a block-vs-template deviation onto the override', () => {
    const shaped = swapShiftShape({
      id: 'a2', profile_id: 'p2', status: 'scheduled', notes: null,
      start_time_override: null, end_time_override: null,
      shift_blocks: {
        block_date: '2026-06-09', start_time: '07:30:00', end_time: '08:30:00',
        shift_templates: { name: 'Early', start_time: '08:00:00', end_time: '09:00:00' },
      },
      profiles: null,
    })
    expect(shaped.start_time_override).toBe('07:30:00')
    expect(shaped.end_time_override).toBe('08:30:00')
  })
})
