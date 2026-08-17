import { describe, it, expect } from 'vitest'
import {
  isUnseen,
  unseenCount,
  kudosRelativeTime,
  toKudosView,
  KUDOS_MESSAGE_MIN,
  KUDOS_MESSAGE_MAX,
} from './coach-kudos.js'

describe('isUnseen', () => {
  it('is true when seen_at is null', () => {
    expect(isUnseen({ seen_at: null })).toBe(true)
  })
  it('is true when seen_at is missing', () => {
    expect(isUnseen({})).toBe(true)
  })
  it('is false when seen_at is set', () => {
    expect(isUnseen({ seen_at: '2026-07-03T10:00:00Z' })).toBe(false)
  })
  it('is false for null/undefined input', () => {
    expect(isUnseen(null)).toBe(false)
    expect(isUnseen(undefined)).toBe(false)
  })
})

describe('unseenCount', () => {
  it('counts only unseen rows', () => {
    const list = [
      { seen_at: null },
      { seen_at: '2026-07-03T10:00:00Z' },
      {}, // no seen_at → unseen
      { seen_at: '2026-07-01T09:00:00Z' },
    ]
    expect(unseenCount(list)).toBe(2)
  })
  it('handles empty / nullish input', () => {
    expect(unseenCount([])).toBe(0)
    expect(unseenCount(null)).toBe(0)
    expect(unseenCount(undefined)).toBe(0)
  })
})

describe('kudosRelativeTime', () => {
  const now = Date.parse('2026-07-03T12:00:00Z')

  it('returns "just now" under 45s', () => {
    expect(kudosRelativeTime('2026-07-03T11:59:30Z', now)).toBe('just now')
  })
  it('formats minutes', () => {
    expect(kudosRelativeTime('2026-07-03T11:55:00Z', now)).toBe('5m ago')
  })
  it('formats hours', () => {
    expect(kudosRelativeTime('2026-07-03T09:00:00Z', now)).toBe('3h ago')
  })
  it('formats days', () => {
    expect(kudosRelativeTime('2026-07-01T12:00:00Z', now)).toBe('2d ago')
  })
  it('formats weeks', () => {
    expect(kudosRelativeTime('2026-06-19T12:00:00Z', now)).toBe('2w ago')
  })
  it('falls back to a plain date past ~a month', () => {
    // ~7 weeks earlier → beyond the 5-week cutoff → calendar date.
    const out = kudosRelativeTime('2026-05-10T12:00:00Z', now)
    expect(out).toMatch(/May/)
    expect(out).not.toMatch(/ago/)
  })
  it('treats future timestamps (clock skew) as just now', () => {
    expect(kudosRelativeTime('2026-07-03T12:05:00Z', now)).toBe('just now')
  })
  it('returns empty string for unparseable input', () => {
    expect(kudosRelativeTime('not-a-date', now)).toBe('')
  })
  it('accepts a Date and a ms epoch', () => {
    expect(kudosRelativeTime(new Date('2026-07-03T11:55:00Z'), now)).toBe('5m ago')
    expect(kudosRelativeTime(Date.parse('2026-07-03T11:55:00Z'), now)).toBe('5m ago')
  })
})

describe('toKudosView', () => {
  it('maps a full row and trims the message', () => {
    const v = toKudosView({
      id: 'k1',
      message: '  Great work today!  ',
      emoji: '💪',
      sender_name: 'Coach Amy',
      created_at: '2026-07-03T10:00:00Z',
      seen_at: null,
    })
    expect(v).toEqual({
      id: 'k1',
      message: 'Great work today!',
      emoji: '💪',
      senderName: 'Coach Amy',
      createdAt: '2026-07-03T10:00:00Z',
      seen: false,
    })
  })
  it('falls back to "Your coach" for blank/missing sender_name', () => {
    expect(toKudosView({ sender_name: '   ' }).senderName).toBe('Your coach')
    expect(toKudosView({}).senderName).toBe('Your coach')
  })
  it('marks seen=true when seen_at is set', () => {
    expect(toKudosView({ seen_at: '2026-07-03T11:00:00Z' }).seen).toBe(true)
  })
  it('normalises a null emoji', () => {
    expect(toKudosView({ emoji: undefined }).emoji).toBe(null)
  })
})

describe('message bounds', () => {
  it('matches the schema contract', () => {
    expect(KUDOS_MESSAGE_MIN).toBe(1)
    expect(KUDOS_MESSAGE_MAX).toBe(500)
  })
})
