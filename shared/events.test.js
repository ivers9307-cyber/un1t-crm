import { describe, it, expect } from 'vitest'
import { EVENT_KINDS, eventKindLabel, eventKindTone, isRaceKind, orderEventsForBrowse } from './events'

describe('event kind presentation', () => {
  it('exposes the multi-kind list (mig 122)', () => {
    expect(EVENT_KINDS).toEqual(['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen'])
  })

  it('labels each kind', () => {
    expect(eventKindLabel('race')).toBe('Race')
    expect(eventKindLabel('workshop')).toBe('Workshop')
    expect(eventKindLabel('seminar')).toBe('Seminar')
    expect(eventKindLabel('open_day')).toBe('Open day')
    expect(eventKindLabel('masterclass')).toBe('Masterclass')
    expect(eventKindLabel('lead_gen')).toBe('Lead Gen')
  })

  it('maps each kind to a semantic tone', () => {
    expect(eventKindTone('race')).toBe('emerald')
    expect(eventKindTone('workshop')).toBe('sky')
    expect(eventKindTone('seminar')).toBe('indigo')
    expect(eventKindTone('open_day')).toBe('amber')
    expect(eventKindTone('masterclass')).toBe('pink')
    expect(eventKindTone('lead_gen')).toBe('teal')
  })

  it('falls back to race for null/unknown kinds (matches the web default)', () => {
    expect(eventKindLabel(null)).toBe('Race')
    expect(eventKindLabel('mystery')).toBe('Race')
    expect(eventKindTone(undefined)).toBe('emerald')
  })

  it('isRaceKind treats null/undefined as race', () => {
    expect(isRaceKind('race')).toBe(true)
    expect(isRaceKind(null)).toBe(true)
    expect(isRaceKind(undefined)).toBe(true)
    expect(isRaceKind('workshop')).toBe(false)
  })
})

describe('orderEventsForBrowse', () => {
  const today = '2026-06-16'

  it('splits on the Dublin-today boundary (today counts as upcoming)', () => {
    const events = [
      { id: 'past', race_date: '2026-06-10' },
      { id: 'today', race_date: '2026-06-16' },
      { id: 'future', race_date: '2026-06-20' },
    ]
    const { upcoming, past } = orderEventsForBrowse(events, today)
    expect(upcoming.map((e) => e.id)).toEqual(['today', 'future'])
    expect(past.map((e) => e.id)).toEqual(['past'])
  })

  it('sorts upcoming ascending (nearest first) and past descending (most recent first)', () => {
    const events = [
      { id: 'p1', race_date: '2026-06-01' },
      { id: 'p2', race_date: '2026-06-14' },
      { id: 'u1', race_date: '2026-06-25' },
      { id: 'u2', race_date: '2026-06-17' },
    ]
    const { upcoming, past } = orderEventsForBrowse(events, today)
    expect(upcoming.map((e) => e.id)).toEqual(['u2', 'u1'])
    expect(past.map((e) => e.id)).toEqual(['p2', 'p1'])
  })

  it('treats a missing race_date as upcoming so half-created events are not hidden', () => {
    const events = [{ id: 'nodate', race_date: null }]
    const { upcoming, past } = orderEventsForBrowse(events, today)
    expect(upcoming.map((e) => e.id)).toEqual(['nodate'])
    expect(past).toEqual([])
  })

  it('tolerates non-array input', () => {
    expect(orderEventsForBrowse(null, today)).toEqual({ upcoming: [], past: [] })
  })
})
