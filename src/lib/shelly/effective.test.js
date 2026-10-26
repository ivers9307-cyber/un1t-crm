import { describe, it, expect } from 'vitest'
import { effectiveTarget, GROUP_COLUMNS } from './effective'
import { planDeviceAction } from './plan'

const NOW = Date.parse('2026-07-06T12:00:00+01:00')
const FUTURE = '2026-07-06T20:00:00.000Z'
const PAST = '2026-07-06T08:00:00.000Z'
const ov = (state, until, set_at) => ({ state, until, set_at, set_by: 'u1' })

const device = (o = {}) => ({
  id: 'd1', location_id: 'L1', group_id: 'g1',
  enabled: false, schedule_mode: 'none', fixed_windows: [], class_rule: {},
  override: null, last_applied: { key: 'w:1', action: 'on' }, ...o,
})
const group = (o = {}) => ({
  id: 'g1', location_id: 'L1', enabled: true, schedule_mode: 'class',
  fixed_windows: [{ days: [1], on: '07:00', off: '21:30' }], class_rule: { lead_min: 10 },
  override: null, last_applied: { key: 'ignored' }, ...o,
})

describe('effectiveTarget', () => {
  it('passes an ungrouped device through untouched', () => {
    const d = device({ group_id: null })
    expect(effectiveTarget(d, null, NOW)).toBe(d)
  })
  it('a grouped device inherits the group schedule fields', () => {
    const t = effectiveTarget(device(), group(), NOW)
    expect(t).toMatchObject({ enabled: true, schedule_mode: 'class', class_rule: { lead_min: 10 } })
    expect(t.fixed_windows).toEqual(group().fixed_windows)
    expect(t.id).toBe('d1')
  })
  it('keeps the device last_applied, not the group one', () => {
    expect(effectiveTarget(device(), group(), NOW).last_applied).toEqual({ key: 'w:1', action: 'on' })
  })
  it('a live device override beats a live group override', () => {
    const d = device({ override: ov('off', FUTURE, 'dev') })
    const t = effectiveTarget(d, group({ override: ov('on', FUTURE, 'grp') }), NOW)
    expect(t.override.set_at).toBe('dev')
  })
  it('an expired device override falls through to the group live one', () => {
    const d = device({ override: ov('off', PAST, 'dev') })
    const t = effectiveTarget(d, group({ override: ov('on', FUTURE, 'grp') }), NOW)
    expect(t.override.set_at).toBe('grp')
  })
  it('no live override anywhere yields null', () => {
    const d = device({ override: ov('off', PAST, 'dev') })
    expect(effectiveTarget(d, group({ override: ov('on', PAST, 'grp') }), NOW).override).toBe(null)
  })
  it('a group from another location is not applied', () => {
    const d = device()
    expect(effectiveTarget(d, group({ location_id: 'L2' }), NOW)).toBe(d)
  })
  it('a deleted group (group_id null, stale ov: stamp, mode none) sends nothing', () => {
    const d = device({ group_id: null, last_applied: { key: 'ov:2026-07-06T09:00:00.000Z', action: 'on' } })
    expect(planDeviceAction(effectiveTarget(d, null, NOW), NOW, '2026-07-06', [], 'Europe/Dublin')).toBe(null)
  })
  it('exports GROUP_COLUMNS', () => {
    expect(GROUP_COLUMNS).toBe('id, location_id, name, icon, sort_order, enabled, schedule_mode, fixed_windows, class_rule, override, last_applied, created_at, updated_at')
  })
})
