// EQUIP-MAINT.3 — unit tests for the inspection cron decision logic.
// Pure: no DB, no clock. Every function takes `today` explicitly.

import { describe, it, expect } from 'vitest'
import {
  isInspectionDay,
  selectOutstanding,
  buildReminderBody,
  buildOverdueBody,
} from './equipment-cron.js'

describe('isInspectionDay', () => {
  // 2026-08-04 is a Tuesday (dow 2).
  it('is true when today falls on the configured weekday', () => {
    expect(isInspectionDay({ inspection_day_of_week: 2, enabled: true }, '2026-08-04')).toBe(true)
  })

  it('is false on any other weekday', () => {
    expect(isInspectionDay({ inspection_day_of_week: 2, enabled: true }, '2026-08-05')).toBe(false)
  })

  it('is false when the location is disabled, even on the right weekday', () => {
    expect(isInspectionDay({ inspection_day_of_week: 2, enabled: false }, '2026-08-04')).toBe(false)
  })

  it('is false for a missing settings row', () => {
    expect(isInspectionDay(null, '2026-08-04')).toBe(false)
  })

  it('handles Sunday (dow 0) rather than treating it as falsy', () => {
    // 2026-08-02 is a Sunday.
    expect(isInspectionDay({ inspection_day_of_week: 0, enabled: true }, '2026-08-02')).toBe(true)
  })
})

describe('selectOutstanding', () => {
  const assets = [
    { id: 'a', name: 'Treadmill 1', next_due_on: '2026-08-04', status: 'in_service' },
    { id: 'b', name: 'Rower 2',     next_due_on: '2026-07-28', status: 'in_service' },
    { id: 'c', name: 'Bike 3',      next_due_on: '2026-09-01', status: 'in_service' },
  ]

  it('returns due assets with no submitted inspection for their cycle', () => {
    const out = selectOutstanding({ assets, submitted: [], today: '2026-08-04' })
    expect(out.map((a) => a.id)).toEqual(['b', 'a'])  // most overdue first
  })

  it('excludes an asset whose current cycle was submitted', () => {
    const submitted = [{ equipment_id: 'a', due_on: '2026-08-04' }]
    const out = selectOutstanding({ assets, submitted, today: '2026-08-04' })
    expect(out.map((a) => a.id)).toEqual(['b'])
  })

  it('does NOT count a submission for a DIFFERENT cycle as covering this one', () => {
    // Submitted last cycle, but the asset has rolled forward and is due again.
    const submitted = [{ equipment_id: 'b', due_on: '2026-06-30' }]
    const out = selectOutstanding({ assets, submitted, today: '2026-08-04' })
    expect(out.map((a) => a.id)).toEqual(['b', 'a'])
  })

  it('excludes assets not yet due', () => {
    const out = selectOutstanding({ assets, submitted: [], today: '2026-08-04' })
    expect(out.map((a) => a.id)).not.toContain('c')
  })

  it('returns [] when nothing is outstanding', () => {
    const submitted = [
      { equipment_id: 'a', due_on: '2026-08-04' },
      { equipment_id: 'b', due_on: '2026-07-28' },
    ]
    expect(selectOutstanding({ assets, submitted, today: '2026-08-04' })).toEqual([])
  })
})

describe('buildReminderBody', () => {
  it('names the single asset when there is exactly one', () => {
    expect(buildReminderBody([{ name: 'Treadmill 1' }])).toMatch(/Treadmill 1/)
  })

  it('counts without listing when there are several', () => {
    const body = buildReminderBody([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    expect(body).toMatch(/3/)
    expect(body).not.toMatch(/\ba\b.*\bb\b.*\bc\b/)
  })

  it('uses a singular noun for one and a plural for many', () => {
    expect(buildReminderBody([{ name: 'x' }])).not.toMatch(/pieces/)
    expect(buildReminderBody([{ name: 'x' }, { name: 'y' }])).toMatch(/pieces/)
  })
})

describe('buildOverdueBody', () => {
  it('states the count and that nothing was submitted', () => {
    const body = buildOverdueBody([{ name: 'a' }, { name: 'b' }])
    expect(body).toMatch(/2/)
    expect(body.length).toBeLessThanOrEqual(180)
  })

  it('stays within a push-sized string even with many assets', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `Asset ${i}` }))
    expect(buildOverdueBody(many).length).toBeLessThanOrEqual(180)
  })
})
