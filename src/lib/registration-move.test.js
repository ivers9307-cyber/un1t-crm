import { describe, it, expect } from 'vitest'
import { entryLabel, entryHeadcount, computePriceGapCents, evaluateMove, MOVE_ERRORS } from './registration-move.js'

describe('entryLabel', () => {
  it('names a team of two or more by the team name', () => {
    expect(entryLabel({ teams: { name: 'The Crushers', team_members: [{ name: 'A' }, { name: 'B' }] } })).toBe('The Crushers')
  })
  it('names a team of one by the person, not the team', () => {
    expect(entryLabel({ teams: { name: 'Mark Kelly', team_members: [{ name: 'Mark Kelly', role: 'captain' }] } })).toBe('Mark Kelly')
  })
  it('names a team-less entry by its lead contact', () => {
    expect(entryLabel({ teams: null, contact: { first_name: 'Aoife', last_name: 'Byrne' } })).toBe('Aoife Byrne')
  })
  it('falls back to "Entry" when nothing is known', () => {
    expect(entryLabel({})).toBe('Entry')
  })
})

describe('entryHeadcount', () => {
  it('counts the team members', () => {
    expect(entryHeadcount({ teams: { size: 4, team_members: [{}, {}] } })).toBe(2)
  })
  it('falls back to teams.size when members are not loaded', () => {
    expect(entryHeadcount({ teams: { size: 3 } })).toBe(3)
  })
  it('is 1 for a team-less entry', () => {
    expect(entryHeadcount({ teams: null })).toBe(1)
    expect(entryHeadcount({})).toBe(1)
  })
})

describe('computePriceGapCents', () => {
  const source = { member_pricing_enabled: true, member_fee_cents: 2000, non_member_fee_cents: 3000 }
  const target = { member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500 }
  it('charges the member rate for members and the non-member rate otherwise', () => {
    const members = [{ is_member: true }, { is_member: false }]
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members })).toBe(500 + 500)
  })
  it('is negative when the target is cheaper', () => {
    expect(computePriceGapCents({ sourceEvent: target, targetEvent: source, members: [{ is_member: false }] })).toBe(-500)
  })
  it('uses the non-member rate for everyone when member pricing is off', () => {
    const t = { member_pricing_enabled: false, member_fee_cents: 0, non_member_fee_cents: 3500 }
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: t, members: [{ is_member: true }] })).toBe(1500)
  })
  it('treats a missing fee as free', () => {
    expect(computePriceGapCents({ sourceEvent: {}, targetEvent: target, members: [{ is_member: false }] })).toBe(3500)
  })
  it('counts one person for a team-less entry', () => {
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members: [] })).toBe(500)
  })
})

const TODAY = '2026-10-08'
function base(over = {}) {
  return {
    registration: { id: 'r1', status: 'confirmed', race_event_id: 'e1', wave_id: 'w1', team_id: 't1',
      teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [{ is_member: false }, { is_member: false }] } },
    sourceEvent: { id: 'e1', host_id: null, location_id: 'L1', allowed_team_sizes: [1, 2, 4] },
    targetEvent: { id: 'e2', host_id: null, location_id: 'L1', active: true, status: 'published', race_date: '2026-10-25',
      capacity_mode: 'teams', allowed_team_sizes: [1, 2, 4], waves: [{ id: 'w9', capacity: 10 }] },
    targetWave: { id: 'w9', race_event_id: 'e2', capacity: 10 },
    targetWaveRegistrations: [],
    checkinCount: 0,
    existingOnTarget: null,
    force: false,
    today: TODAY,
    ...over,
  }
}

describe('evaluateMove', () => {
  it('passes a clean move', () => {
    expect(evaluateMove(base())).toEqual({ ok: true })
  })
  it('not_active for cancelled and no_show', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'cancelled' } })).error).toBe(MOVE_ERRORS.NOT_ACTIVE)
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'no_show' } })).error).toBe(MOVE_ERRORS.NOT_ACTIVE)
  })
  it('allows an entry awaiting payment', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'pending_payment' } })).ok).toBe(true)
  })
  it('checked_in when anyone has checked in', () => {
    expect(evaluateMove(base({ checkinCount: 1 })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('same_event when the target is the source', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, id: 'e1' } })).error).toBe(MOVE_ERRORS.SAME_EVENT)
  })
  it('target_unavailable for draft, inactive or past events', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, status: 'draft' } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, active: false } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, race_date: '2026-10-07' } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
  })
  it('a target on today is still available', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, race_date: TODAY } })).ok).toBe(true)
  })
  it('different_payee when host_id differs; NULL equals NULL', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, host_id: 'h1' } })).error).toBe(MOVE_ERRORS.DIFFERENT_PAYEE)
    expect(evaluateMove(base({ sourceEvent: { ...base().sourceEvent, host_id: 'h1' }, targetEvent: { ...base().targetEvent, host_id: 'h1' } })).ok).toBe(true)
  })
  it('allows a move to another studio', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, location_id: 'L2' } })).ok).toBe(true)
  })
  it('already_entered only at the same studio', () => {
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'confirmed' } })).error).toBe(MOVE_ERRORS.ALREADY_ENTERED)
    // UNIQUE (race_event_id, team_id) is not partial: a cancelled row of the
    // same team on the target would make the write fail, so refuse it here.
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'cancelled' } })).error).toBe(MOVE_ERRORS.ALREADY_ENTERED)
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'confirmed' }, targetEvent: { ...base().targetEvent, location_id: 'L2' } })).ok).toBe(true)
  })
  it('headcount_not_allowed when the target does not accept the size', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, allowed_team_sizes: [1, 4] } })).error).toBe(MOVE_ERRORS.HEADCOUNT_NOT_ALLOWED)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, allowed_team_sizes: null } })).ok).toBe(true)
  })
  it('wave_required when the target has waves and none was given', () => {
    expect(evaluateMove(base({ targetWave: null })).error).toBe(MOVE_ERRORS.WAVE_REQUIRED)
  })
  it('no wave needed when the target has no waves', () => {
    expect(evaluateMove(base({ targetWave: null, targetEvent: { ...base().targetEvent, waves: [] } })).ok).toBe(true)
  })
  it('wrong_event when the wave belongs elsewhere', () => {
    expect(evaluateMove(base({ targetWave: { id: 'w9', race_event_id: 'e3', capacity: 10 } })).error).toBe(MOVE_ERRORS.WRONG_EVENT)
  })
  it('wave_full in teams mode counts confirmed entries, with spots_left', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const r = evaluateMove(base({ targetWaveRegistrations: full }))
    expect(r.error).toBe(MOVE_ERRORS.WAVE_FULL)
    expect(r.spots_left).toBe(0)
  })
  it('wave_full in people mode needs room for the whole entry', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const r = evaluateMove(base({ targetWaveRegistrations: nine, targetEvent: { ...base().targetEvent, capacity_mode: 'people' } }))
    expect(r.error).toBe(MOVE_ERRORS.WAVE_FULL)
    expect(r.spots_left).toBe(1)
  })
  it('force skips wave_full and nothing else', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    expect(evaluateMove(base({ targetWaveRegistrations: full, force: true })).ok).toBe(true)
    expect(evaluateMove(base({ checkinCount: 1, force: true })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('an uncapped wave always fits', () => {
    expect(evaluateMove(base({ targetWave: { id: 'w9', race_event_id: 'e2', capacity: null } })).ok).toBe(true)
  })
})
