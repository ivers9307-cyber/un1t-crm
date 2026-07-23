import { describe, it, expect } from 'vitest'
import { weeksToExpand, slotsForWeek, blockRowFrom, sessionRowFrom } from './plan-block'

const arc = { weeks: 12, dial: 'mixed', plan: [
  { week_no: 1, phase: 'base', stimulus: 'Aerobic base', is_benchmark: true, progression: 'RPE 6-7' },
  { week_no: 2, phase: 'base', stimulus: 'Volume', is_benchmark: false, progression: 'add a round' },
  { week_no: 3, phase: 'build', stimulus: 'Threshold', is_benchmark: false, progression: 'heavier sled' },
] }

describe('plan-block builders', () => {
  it('weeksToExpand returns the first N week plans, clamped', () => {
    expect(weeksToExpand(arc, 2).map(w => w.week_no)).toEqual([1, 2])
    expect(weeksToExpand(arc, 99).map(w => w.week_no)).toEqual([1, 2, 3])
  })
  it('slotsForWeek returns 1..sessions_per_week', () => {
    expect(slotsForWeek(2)).toEqual([1, 2])
  })
  it('blockRowFrom builds a persistable block', () => {
    const row = blockRowFrom({ location_id: 'loc1', starts_on: '2026-08-03', weeks: 12, sessions_per_week: 2, session_weekdays: [3, 7], difficulty_dial: 'mixed', auto_tune_enabled: false, title: 'Autumn' }, arc, 'user1', 'claude-x')
    expect(row).toMatchObject({ location_id: 'loc1', starts_on: '2026-08-03', session_weekdays: [3, 7], difficulty_dial: 'mixed', auto_tune_enabled: false, status: 'active', generated_by: 'claude-x' })
    expect(row.arc).toEqual(arc)
  })
  it('sessionRowFrom maps an expanded session into a draft row', () => {
    const expanded = { week_no: 1, slot: 1, phase: 'base', focus: 'Engine', is_benchmark: true, full_session: { warmup: 'w', main: 'm', cues: [], why: 'y' }, board: { location_label: 'X', week_label: 'W1', focus: 'ENGINE', format: '4 RFT', cap_minutes: 45, stations: [{ name: 'Run', performance: '400m', elite: '500m' }], target: 'sub-32' } }
    const row = sessionRowFrom('block1', 'loc1', expanded)
    expect(row).toMatchObject({ block_id: 'block1', location_id: 'loc1', week_no: 1, slot: 1, phase: 'base', focus: 'Engine', is_benchmark: true, status: 'draft' })
    expect(row.full_session).toEqual(expanded.full_session)
    expect(row.board).toEqual(expanded.board)
  })
})
