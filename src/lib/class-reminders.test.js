import { describe, it, expect } from 'vitest'
import {
  resolveClassReminderLeadTimes,
  selectDueClassReminders,
  classTimeLabel,
} from './class-reminders'

describe('resolveClassReminderLeadTimes', () => {
  it('defaults to [30] when no / empty config', () => {
    expect(resolveClassReminderLeadTimes(null)).toEqual([30])
    expect(resolveClassReminderLeadTimes({})).toEqual([30])
    expect(resolveClassReminderLeadTimes({ categories: {} })).toEqual([30])
    expect(resolveClassReminderLeadTimes({ categories: { class_reminder: {} } })).toEqual([30])
  })

  it('reads a per-location override (order preserved)', () => {
    const cfg = { categories: { class_reminder: { lead_times_minutes: [1440, 30] } } }
    expect(resolveClassReminderLeadTimes(cfg)).toEqual([1440, 30])
  })

  it('drops invalid / out-of-range / duplicate values', () => {
    const cfg = { categories: { class_reminder: { lead_times_minutes: [30, 30, -5, 0, 'x', 99999] } } }
    expect(resolveClassReminderLeadTimes(cfg)).toEqual([30])
  })

  it('falls back to the default when nothing valid remains', () => {
    const cfg = { categories: { class_reminder: { lead_times_minutes: [-1, 0, 20000] } } }
    expect(resolveClassReminderLeadTimes(cfg)).toEqual([30])
  })
})

describe('selectDueClassReminders', () => {
  const now = Date.UTC(2026, 6, 1, 18, 0, 0) // 2026-07-01T18:00:00Z
  const iso = (ms) => new Date(ms).toISOString()

  it('fires when the class starts ≈ now + lead (inside the window)', () => {
    const b = { id: 'b1', contact_id: 'c1', location_id: 'l1', class_name: 'HIIT', starts_at: iso(now + 30 * 60000) }
    const due = selectDueClassReminders([b], now, [30], 5)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      bookingId: 'b1', contactId: 'c1', locationId: 'l1', className: 'HIIT', leadMinutes: 30,
    })
  })

  it('does not fire outside the ±window', () => {
    const b = { id: 'b1', contact_id: 'c1', starts_at: iso(now + 50 * 60000) }
    expect(selectDueClassReminders([b], now, [30], 5)).toHaveLength(0)
  })

  it('handles multiple lead times independently', () => {
    const b = { id: 'b1', contact_id: 'c1', starts_at: iso(now + 1440 * 60000) }
    const due = selectDueClassReminders([b], now, [1440, 30], 5)
    expect(due).toHaveLength(1)
    expect(due[0].leadMinutes).toBe(1440)
  })

  it('skips rows missing id / contact_id / starts_at', () => {
    const noContact = { id: 'b', starts_at: iso(now + 30 * 60000) }
    const noStart = { id: 'b', contact_id: 'c' }
    expect(selectDueClassReminders([noContact, noStart], now, [30], 5)).toHaveLength(0)
  })
})

describe('classTimeLabel', () => {
  it('renders a UTC instant in the location tz (Dublin summer = UTC+1)', () => {
    expect(classTimeLabel('2026-07-01T18:30:00Z', 'Europe/Dublin')).toBe('7:30pm')
  })

  it('renders correctly in Dublin winter (UTC+0)', () => {
    expect(classTimeLabel('2026-12-15T09:00:00Z', 'Europe/Dublin')).toBe('9:00am')
  })

  it('is independent of process TZ — the tz param fixes it', () => {
    // New York is UTC-4 in July.
    expect(classTimeLabel('2026-07-01T18:30:00Z', 'America/New_York')).toBe('2:30pm')
  })

  it('returns empty for an unparseable date', () => {
    expect(classTimeLabel('not-a-date', 'Europe/Dublin')).toBe('')
  })
})
