// Tests for race-control helpers (mig 081). The pure formatters and
// classifier are covered exhaustively; ensureTeamForBooking gets an
// IO-style test with a mocked db chain (same pattern as
// activity-events.test.js / deposit-receipts.test.js).

import { describe, it, expect, vi } from 'vitest'
import {
  formatElapsed,
  classifyBookingState,
  elapsedSecondsBetween,
  ensureTeamForBooking,
} from './race-control.js'

describe('formatElapsed', () => {
  it('shows MM:SS for sub-hour times', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(5)).toBe('00:05')
    expect(formatElapsed(59)).toBe('00:59')
    expect(formatElapsed(60)).toBe('01:00')
    expect(formatElapsed(125)).toBe('02:05')
    expect(formatElapsed(3599)).toBe('59:59')
  })

  it('shows H:MM:SS when an hour or more has passed', () => {
    expect(formatElapsed(3600)).toBe('1:00:00')
    expect(formatElapsed(3661)).toBe('1:01:01')
    expect(formatElapsed(7200)).toBe('2:00:00')
    expect(formatElapsed(36000)).toBe('10:00:00')
  })

  it('floors fractional seconds (no decimal display)', () => {
    expect(formatElapsed(59.9)).toBe('00:59')
    expect(formatElapsed(60.5)).toBe('01:00')
  })

  it('returns "—" for null / undefined / NaN / negative inputs', () => {
    expect(formatElapsed(null)).toBe('—')
    expect(formatElapsed(undefined)).toBe('—')
    expect(formatElapsed(NaN)).toBe('—')
    expect(formatElapsed(-1)).toBe('—')
  })
})

describe('classifyBookingState', () => {
  it('returns next_up for confirmed bookings without a start time', () => {
    expect(classifyBookingState({ status: 'confirmed' })).toBe('next_up')
    expect(classifyBookingState({ status: 'confirmed', race_started_at: null })).toBe('next_up')
  })

  it('returns on_course when started but not finished', () => {
    expect(classifyBookingState({
      status: 'confirmed',
      race_started_at: '2026-05-10T10:00:00Z',
    })).toBe('on_course')
  })

  it('returns completed when both timestamps are set', () => {
    expect(classifyBookingState({
      status: 'confirmed',
      race_started_at: '2026-05-10T10:00:00Z',
      race_finished_at: '2026-05-10T11:00:00Z',
    })).toBe('completed')
  })

  it('returns no_show for no_show or cancelled status (regardless of timing)', () => {
    expect(classifyBookingState({ status: 'no_show' })).toBe('no_show')
    expect(classifyBookingState({ status: 'cancelled' })).toBe('no_show')
    // Defensive: a cancelled booking with timing data still classifies as no_show.
    expect(classifyBookingState({
      status: 'cancelled',
      race_started_at: '2026-05-10T10:00:00Z',
    })).toBe('no_show')
  })

  it('handles null booking defensively', () => {
    expect(classifyBookingState(null)).toBe('next_up')
    expect(classifyBookingState(undefined)).toBe('next_up')
  })
})

describe('elapsedSecondsBetween', () => {
  it('returns null when either timestamp is missing', () => {
    expect(elapsedSecondsBetween(null, '2026-05-10T11:00:00Z')).toBeNull()
    expect(elapsedSecondsBetween('2026-05-10T10:00:00Z', null)).toBeNull()
    expect(elapsedSecondsBetween(null, null)).toBeNull()
  })

  it('returns whole-second difference', () => {
    expect(elapsedSecondsBetween(
      '2026-05-10T10:00:00.000Z',
      '2026-05-10T10:01:30.000Z',
    )).toBe(90)
  })

  it('clamps negative results to 0 (defensive against clock skew)', () => {
    expect(elapsedSecondsBetween(
      '2026-05-10T11:00:00Z',
      '2026-05-10T10:00:00Z',
    )).toBe(0)
  })

  it('returns null for unparseable input', () => {
    expect(elapsedSecondsBetween('not-a-date', '2026-05-10T11:00:00Z')).toBeNull()
  })
})

// ensureTeamForBooking exercises a chainable supabase mock. Tests
// cover: pre-existing link, find by name, create new, captain seed.

function mockDb({
  preLinkedTeam = null,
  foundByName = null,
  insertResult = { data: { id: 'team-new' }, error: null },
  membersInsertResult = { data: null, error: null },
} = {}) {
  const calls = []

  const teamsSingleByLink = vi.fn(() => Promise.resolve({ data: preLinkedTeam, error: null }))
  const teamsEqLink = vi.fn(() => ({ single: teamsSingleByLink }))

  const teamsMaybeSingle = vi.fn(() => Promise.resolve({ data: foundByName, error: null }))
  const teamsEqByName2 = vi.fn(() => ({ maybeSingle: teamsMaybeSingle }))
  const teamsEqByName1 = vi.fn(() => ({ eq: teamsEqByName2 }))

  const teamsInsertSingle = vi.fn(() => Promise.resolve(insertResult))
  const teamsInsertSelect = vi.fn(() => ({ single: teamsInsertSingle }))
  const teamsInsert = vi.fn((row) => {
    calls.push({ table: 'teams', op: 'insert', row })
    return { select: teamsInsertSelect }
  })

  const teamsSelect = vi.fn((cols) => {
    if (cols === '*') {
      return {
        eq: (...args) => {
          // .eq('id', x) for the link lookup OR .eq('location_id', x) for find-by-name (chained again)
          if (args[0] === 'id') return teamsEqLink(args[0], args[1])
          if (args[0] === 'location_id') return teamsEqByName1(args[0], args[1])
          return { single: vi.fn(() => Promise.resolve({ data: null, error: null })) }
        },
      }
    }
    return { eq: () => ({ single: vi.fn(() => Promise.resolve({ data: null, error: null })) }) }
  })

  const teamMembersInsert = vi.fn((row) => {
    calls.push({ table: 'team_members', op: 'insert', row })
    return Promise.resolve(membersInsertResult)
  })

  const bookingsUpdateEq = vi.fn(() => Promise.resolve({ data: null, error: null }))
  const bookingsUpdate = vi.fn((row) => {
    calls.push({ table: 'bookings', op: 'update', row })
    return { eq: bookingsUpdateEq }
  })

  const db = {
    from: vi.fn((table) => {
      if (table === 'teams') return { select: teamsSelect, insert: teamsInsert }
      if (table === 'team_members') return { insert: teamMembersInsert }
      if (table === 'bookings') return { update: bookingsUpdate }
      throw new Error(`Unexpected table: ${table}`)
    }),
  }

  return { db, calls, spies: { teamsInsert, teamMembersInsert, bookingsUpdate } }
}

describe('ensureTeamForBooking', () => {
  const baseBooking = {
    id: 'booking-1',
    location_id: 'loc-a',
    customer_name: 'The Iron Dogs',
    customer_email: 'captain@example.com',
    contact_id: 'contact-captain',
  }

  it('throws if booking is missing required fields', async () => {
    const { db } = mockDb()
    await expect(ensureTeamForBooking(db, {})).rejects.toThrow(/missing/)
    await expect(ensureTeamForBooking(db, { id: 'b1' })).rejects.toThrow(/missing/)
  })

  it('returns the existing team when booking.team_id is already set', async () => {
    const existing = { id: 'team-already-linked', name: 'The Iron Dogs', size: 4 }
    const { db, spies } = mockDb({ preLinkedTeam: existing })
    const r = await ensureTeamForBooking(db, { ...baseBooking, team_id: existing.id })
    expect(r.team).toEqual(existing)
    expect(r.created).toBe(false)
    expect(spies.teamsInsert).not.toHaveBeenCalled()
  })

  it('finds the team by (location, name) when no team_id and a match exists', async () => {
    const existing = { id: 'team-found', name: 'The Iron Dogs', size: 4 }
    const { db, spies } = mockDb({ foundByName: existing })
    const r = await ensureTeamForBooking(db, baseBooking)
    expect(r.team).toEqual(existing)
    expect(r.created).toBe(false)
    expect(spies.teamsInsert).not.toHaveBeenCalled()
    // Booking link still updated (covers the case where a booking
    // existed pre-mig-081 with no team_id).
    expect(spies.bookingsUpdate).toHaveBeenCalledWith({ team_id: 'team-found' })
  })

  it('creates a new team + seeds captain when no match found', async () => {
    const { db, spies, calls } = mockDb({
      foundByName: null,
      insertResult: { data: { id: 'team-fresh', name: 'The Iron Dogs', captain_contact_id: 'contact-captain' }, error: null },
    })
    const r = await ensureTeamForBooking(db, baseBooking)
    expect(r.created).toBe(true)
    expect(r.team.id).toBe('team-fresh')
    // Team insert with the right shape.
    const teamInsert = calls.find((c) => c.table === 'teams' && c.op === 'insert')
    expect(teamInsert.row).toMatchObject({
      location_id: 'loc-a',
      name: 'The Iron Dogs',
      captain_contact_id: 'contact-captain',
    })
    // Captain seeded as a team_member with role=captain.
    const memberInsert = calls.find((c) => c.table === 'team_members' && c.op === 'insert')
    expect(memberInsert.row).toMatchObject({
      team_id: 'team-fresh',
      contact_id: 'contact-captain',
      role: 'captain',
    })
    // Booking linked.
    expect(spies.bookingsUpdate).toHaveBeenCalledWith({ team_id: 'team-fresh' })
  })

  it('skips the captain team_member seed when booking has no contact_id (defensive)', async () => {
    const { db, spies } = mockDb({
      foundByName: null,
      insertResult: { data: { id: 'team-no-contact' }, error: null },
    })
    await ensureTeamForBooking(db, { ...baseBooking, contact_id: null })
    expect(spies.teamMembersInsert).not.toHaveBeenCalled()
  })

  it('throws (not swallows) on team insert error so the caller can surface it', async () => {
    const { db } = mockDb({
      foundByName: null,
      insertResult: { data: null, error: { message: 'rls denied' } },
    })
    await expect(ensureTeamForBooking(db, baseBooking)).rejects.toThrow(/Team create failed.*rls denied/)
  })
})
