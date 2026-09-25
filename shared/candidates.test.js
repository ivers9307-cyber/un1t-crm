// CANDIDATES.1 — ranked candidates. Pure: no clock, no database. Run under
// TZ=Europe/Dublin AND a US zone; nothing here may move with the host.

import { describe, it, expect } from 'vitest'
import {
  CANDIDATE_TIERS, CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE,
  candidateTier, compareCandidates, rankCandidates, candidateTone,
  candidateBadges, candidateHoursLine, candidateMeta, candidateReason,
  candidatesUncheckedNote, parseCandidatesAnswer,
  candidateFacts, buildCandidates,
} from './candidates.js'

describe('candidateTier', () => {
  it('ready, advisory, unavailable, blocked — in that order of badness', () => {
    expect(CANDIDATE_TIERS).toEqual(['ready', 'advisory', 'unavailable', 'blocked'])
    expect(candidateTier({})).toBe('ready')
    expect(candidateTier({ free: null })).toBe('ready') // unknown is neutral
    expect(candidateTier({ rest_gap: { rest_minutes: 600 } })).toBe('advisory')
    expect(candidateTier({ week_over: { minutes: 2940 } })).toBe('advisory')
    expect(candidateTier({ unavailable: { summary: 'all day' }, rest_gap: { rest_minutes: 1 } })).toBe('unavailable')
    expect(candidateTier({ free: false, unavailable: { summary: 'all day' } })).toBe('blocked')
    expect(candidateTier({ on_leave: { type: 'holiday' } })).toBe('blocked')
  })
})

describe('rankCandidates', () => {
  it('tier, then on site, then under-contract share, then fewest hours, then name', () => {
    const list = [
      { profile_id: 'z', full_name: 'Zoe', free: false },
      { profile_id: 'y', full_name: 'Yan', unavailable: { summary: 'all day' } },
      { profile_id: 'x', full_name: 'Xia', rest_gap: { rest_minutes: 600 } },
      { profile_id: 'c', full_name: 'Cal', free: true, week_minutes: 0 },
      { profile_id: 'b', full_name: 'Bea', free: true, week_minutes: 1200, contracted_hours: 39 },
      { profile_id: 'a', full_name: 'Abe', free: true, week_minutes: 600, contracted_hours: 20 },
      { profile_id: 'o', full_name: 'Ola', free: true, week_minutes: 2400, contracted_hours: 20 },
      { profile_id: 's', full_name: 'Sam', free: true, week_minutes: 900, on_site: { start: '07:00', end: '09:00' } },
      { profile_id: 'd', full_name: 'Dee', free: true, week_minutes: 0 },
    ]
    const ranked = rankCandidates(list)
    // s on site; a (10h of 20h = 0.50) before b (20h of 39h = 0.51); then the
    // no-contract / over-contract group by hours: c 0h, d 0h (name), o 40h.
    expect(ranked.map((c) => c.profile_id)).toEqual(['s', 'a', 'b', 'c', 'd', 'o', 'x', 'y', 'z'])
    expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ranked.map((c) => c.tier)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'advisory', 'unavailable', 'blocked'])
    expect(list[0]).not.toHaveProperty('rank') // a copy, never mutates
  })

  it('an unknown week is neutral: those rows fall back to name, then id', () => {
    const ranked = rankCandidates([
      { profile_id: '2', full_name: 'ann', week_minutes: null },
      { profile_id: '1', full_name: 'Ann', week_minutes: null },
      { profile_id: '3', full_name: 'Aaron' },
    ])
    expect(ranked.map((c) => c.profile_id)).toEqual(['3', '1', '2'])
    expect(compareCandidates(ranked[1], ranked[2])).toBeLessThan(0)
  })

  it('tone follows the tier', () => {
    expect(['ready', 'advisory', 'unavailable', 'blocked'].map((tier) => candidateTone({ tier }))).toEqual(['good', 'warn', 'muted', 'bad'])
    expect(candidateTone(null)).toBe('muted')
  })
})

describe('words', () => {
  const FACTS = {
    profile_id: 'p', full_name: 'P', role: 'staff', free: false,
    busy: { block_id: 'b', date: '2026-05-06', start: '09:30', end: '10:30', name: 'Morning HIIT', location_name: 'Studio South' },
    on_leave: { type: 'sick', label: 'Sick leave', start_date: '2026-05-06', end_date: '2026-05-06' },
    unavailable: { summary: 'all day', detail: '6 May, all day' },
    rest_gap: { rest_minutes: 570, side: 'before', other: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' } },
    week_over: { week_start: '2026-05-04', minutes: 2910 },
    on_site: null, week_minutes: 2790, contracted_hours: 37.5,
  }

  it('badges keep the picker\'s existing words and titles', () => {
    expect(candidateBadges(FACTS)).toEqual([
      { key: 'leave', tone: 'bad', text: 'on approved leave', title: 'Sick leave, Wed 6 May' },
      { key: 'busy', tone: 'warn', text: 'clashes with 9:30am Morning HIIT', title: 'Already on Morning HIIT, 9:30am–10:30am at Studio South' },
      { key: 'unavailable', tone: 'muted', text: 'Unavailable: all day', title: '6 May, all day' },
      { key: 'rest', tone: 'warn', text: '9h 30m rest', title: 'Only 9h 30m between this shift and Evening 8pm–9:30pm at Studio South on Tue 5 May. Employees need 11 hours between working days.' },
      { key: 'week', tone: 'warn', text: '48h 30m this week', title: 'Assigning this shift brings their week to 48h 30m across every studio, over the 48-hour limit.' },
    ])
    expect(candidateBadges({ free: true })).toEqual([])
    expect(candidateBadges({ on_leave: { label: 'Holiday', start_date: '2026-05-05', end_date: '2026-05-07' } })[0].title)
      .toBe('Holiday, Tue 5 May to Thu 7 May')
  })

  it('the hours line: share of a contract, plain hours, or none', () => {
    expect(candidateHoursLine(FACTS)).toBe('46h 30m of 37.5h this week')
    expect(candidateHoursLine({ week_minutes: 0, contracted_hours: 30 })).toBe('0h of 30h this week')
    expect(candidateHoursLine({ week_minutes: 120 })).toBe('2h this week')
    expect(candidateHoursLine({ week_minutes: 0 })).toBe('No shifts this week')
    expect(candidateHoursLine({ week_minutes: null, contracted_hours: 39 })).toBeNull()
  })

  it('meta line: on site, then hours', () => {
    expect(candidateMeta({ on_site: { start: '07:00', end: '09:00' }, week_minutes: 120 })).toBe('Here 7am–9am · 2h this week')
    expect(candidateMeta({ week_minutes: 0 })).toBe('No shifts this week')
    expect(candidateMeta({})).toBeNull()
  })

  it('reason: the worst thing first, then the hours; a colleague sees free or working only', () => {
    expect(candidateReason(FACTS)).toBe('On leave (Sick leave) · 46h 30m of 37.5h this week')
    expect(candidateReason({ ...FACTS, on_leave: null })).toBe('Working 9:30am–10:30am Morning HIIT at Studio South · 46h 30m of 37.5h this week')
    expect(candidateReason({ ...FACTS, on_leave: null, busy: null, free: true })).toBe('Unavailable all day · 46h 30m of 37.5h this week')
    expect(candidateReason({ rest_gap: FACTS.rest_gap, week_minutes: 90, contracted_hours: 39 })).toBe('Only 9h 30m rest · 1h 30m of 39h this week')
    expect(candidateReason({ week_over: { minutes: 2940 }, week_minutes: 2820, contracted_hours: 39 })).toBe('49h with this shift · 47h of 39h this week')
    expect(candidateReason({ free: true, on_site: { start: '12:00', end: '13:00' }, week_minutes: 60 })).toBe('Here 12pm–1pm · 1h this week')
    expect(candidateReason({ free: true, week_minutes: 240, contracted_hours: 39 })).toBe('Free · 4h of 39h this week')
    expect(candidateReason({})).toBeNull()
    expect(candidateReason({ free: true }, 'colleague')).toBe('Free then')
    expect(candidateReason({ free: false }, 'colleague')).toBe('Working then')
    expect(candidateReason({ free: null }, 'colleague')).toBeNull()
  })

  it('what could not be checked, in words', () => {
    expect(candidatesUncheckedNote({ shifts: true, leave: false })).toBe('Could not check leave, so the order may be off.')
    expect(candidatesUncheckedNote({ leave: false, availability: false })).toBe('Could not check leave and availability, so the order may be off.')
    expect(candidatesUncheckedNote({ shifts: false, cross_studio: false, contract: false }))
      .toBe('Could not check other shifts, the other studios and contracted hours, so the order may be off.')
    expect(candidatesUncheckedNote({ shifts: true })).toBeNull()
    expect(candidatesUncheckedNote(undefined)).toBeNull()
    expect(CANDIDATES_RANKING_NOTE).toBe('Ranking coaches…')
    expect(CANDIDATES_UNRANKED_NOTE).toBe('Coaches could not be ranked, so they are listed A–Z.')
  })
})

describe('parseCandidatesAnswer', () => {
  it('a failed or missing answer is failed; a success of another shape is unrecognised', () => {
    expect(parseCandidatesAnswer(null)).toEqual({ ok: false, reason: 'failed' })
    expect(parseCandidatesAnswer({ success: false, error: 'boom' })).toEqual({ ok: false, reason: 'failed' })
    expect(parseCandidatesAnswer({ success: true, data: [] })).toEqual({ ok: false, reason: 'unrecognised' })
    expect(parseCandidatesAnswer({ success: true, data: { byProfile: {} } })).toEqual({ ok: false, reason: 'unrecognised' })
  })

  it('orders by rank, drops junk rows, defaults the rest', () => {
    const out = parseCandidatesAnswer({ success: true, data: { candidates: [
      { profile_id: 'b', rank: 2 }, null, { rank: 3 }, { profile_id: 'a', rank: 1 }, { profile_id: 'c' },
    ] } })
    expect(out).toEqual({
      ok: true, audience: 'manager', checked: {}, untimed: 0,
      candidates: [{ profile_id: 'a', rank: 1 }, { profile_id: 'b', rank: 2 }, { profile_id: 'c' }],
    })
    expect(parseCandidatesAnswer({ success: true, data: { audience: 'colleague', candidates: [], checked: { shifts: false }, untimed: 2 } }))
      .toEqual({ ok: true, audience: 'colleague', candidates: [], checked: { shifts: false }, untimed: 2 })
  })
})
