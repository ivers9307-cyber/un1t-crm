// OPENWEEK.7 — when an open week class reminder goes, and what it says.
import { describe, it, expect } from 'vitest'
import { reminderPlan, isReminderDue, reminderParams, MAX_LATE_MS } from './open-week-reminders'

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'

describe('reminderPlan', () => {
  it('a morning class (before 12:00) is reminded at 18:00 the evening before', () => {
    const p = reminderPlan('2026-11-24T07:00:00Z', DUB)
    expect(p).toEqual({ sendAtMs: Date.parse('2026-11-23T18:00:00Z'), dayWord: 'tomorrow' })
  })

  it('an 11:59 class is still morning', () => {
    expect(reminderPlan('2026-11-24T11:59:00Z', DUB).dayWord).toBe('tomorrow')
  })

  it('a class at 12:00 or later is reminded at 09:00 the same day', () => {
    expect(reminderPlan('2026-11-24T12:30:00Z', DUB)).toEqual({ sendAtMs: Date.parse('2026-11-24T09:00:00Z'), dayWord: 'today' })
    expect(reminderPlan('2026-11-24T18:00:00Z', DUB)).toEqual({ sendAtMs: Date.parse('2026-11-24T09:00:00Z'), dayWord: 'today' })
  })

  it('judges morning and the send time on the studio clock', () => {
    // 15:00Z is 10:00 in New York: a morning class there.
    expect(reminderPlan('2026-11-24T15:00:00Z', NY)).toEqual({ sendAtMs: Date.parse('2026-11-23T23:00:00Z'), dayWord: 'tomorrow' })
  })

  it('a Monday morning class is reminded on Sunday evening', () => {
    expect(reminderPlan('2026-11-23T06:00:00Z', DUB).sendAtMs).toBe(Date.parse('2026-11-22T18:00:00Z'))
  })
})

describe('isReminderDue', () => {
  const plan = reminderPlan('2026-11-24T07:00:00Z', DUB)
  const startMs = Date.parse('2026-11-24T07:00:00Z')
  it('not before the send time', () => {
    expect(isReminderDue(plan, startMs, Date.parse('2026-11-23T17:59:00Z'))).toBe(false)
  })
  it('from the send time', () => {
    expect(isReminderDue(plan, startMs, Date.parse('2026-11-23T18:00:00Z'))).toBe(true)
  })
  it('a late signup still gets it within the late window, never after', () => {
    expect(isReminderDue(plan, startMs, plan.sendAtMs + MAX_LATE_MS)).toBe(true)
    expect(isReminderDue(plan, startMs, plan.sendAtMs + MAX_LATE_MS + 1)).toBe(false)
  })
  it('never within the hour before the class', () => {
    const p = reminderPlan('2026-11-24T12:30:00Z', DUB)
    const s = Date.parse('2026-11-24T12:30:00Z')
    expect(isReminderDue(p, s, s - 61 * 60_000)).toBe(true)
    expect(isReminderDue(p, s, s - 59 * 60_000)).toBe(false)
  })
})

describe('reminderParams', () => {
  it('first name, day word, time on the studio clock, class, studio', () => {
    expect(reminderParams({ contact: { first_name: 'Aoife', name: 'Aoife Byrne' }, startsAt: '2026-11-24T07:00:00Z', className: 'FORCE', studioName: 'UN1T Hatch Street', zone: DUB, dayWord: 'tomorrow' }))
      .toEqual(['Aoife', 'tomorrow', '07:00', 'FORCE', 'UN1T Hatch Street'])
  })
  it('falls back to the first word of the name, then "there", and "your class"', () => {
    expect(reminderParams({ contact: { first_name: null, name: 'Sam Lee' }, startsAt: '2026-11-24T13:00:00Z', className: '', studioName: 'S', zone: DUB, dayWord: 'today' }))
      .toEqual(['Sam', 'today', '13:00', 'your class', 'S'])
    expect(reminderParams({ contact: {}, startsAt: '2026-11-24T13:00:00Z', className: 'X', studioName: 'S', zone: DUB, dayWord: 'today' })[0]).toBe('there')
  })
})
