import { describe, it, expect } from 'vitest'
import { pickSessionForOccurrence, resolveHyroxDisplayIds } from './publish'

const block = { starts_on: '2026-08-03', weeks: 12, session_weekdays: [3, 7] } // Mon start; Wed=slot1, Sun=slot2
const sessions = [
  { id: 's1', week_no: 1, slot: 1, status: 'approved' },
  { id: 's2', week_no: 1, slot: 2, status: 'draft' },
  { id: 's3', week_no: 2, slot: 1, status: 'published' },
]

describe('pickSessionForOccurrence', () => {
  it('matches an approved session to the live class by week+slot', () => {
    // Wed 2026-08-05 18:00 = week 1 (0-2 days in), slot 1 (Wed)
    expect(pickSessionForOccurrence(block, sessions, '2026-08-05T18:00:00Z')?.id).toBe('s1')
  })
  it('returns null when the matching session is still a draft', () => {
    // Sun 2026-08-09 = week 1, slot 2 -> s2 is draft
    expect(pickSessionForOccurrence(block, sessions, '2026-08-09T10:00:00Z')).toBeNull()
  })
  it('matches a published session too', () => {
    // Wed 2026-08-12 = week 2, slot 1 -> s3 published
    expect(pickSessionForOccurrence(block, sessions, '2026-08-12T18:00:00Z')?.id).toBe('s3')
  })
  it('returns null before the block starts', () => {
    expect(pickSessionForOccurrence(block, sessions, '2026-07-30T18:00:00Z')).toBeNull()
  })
})

describe('resolveHyroxDisplayIds', () => {
  it('returns all active displays when unset', () => {
    expect(resolveHyroxDisplayIds({}, ['d1', 'd2'])).toEqual(['d1', 'd2'])
  })
  it('narrows to the configured display ids (intersected with active)', () => {
    const loc = { settings: { hyrox: { tv_display_ids: ['d2', 'dX'] } } }
    expect(resolveHyroxDisplayIds(loc, ['d1', 'd2'])).toEqual(['d2'])
  })
  it('falls back to all active if the configured list is empty', () => {
    const loc = { settings: { hyrox: { tv_display_ids: [] } } }
    expect(resolveHyroxDisplayIds(loc, ['d1'])).toEqual(['d1'])
  })
})
