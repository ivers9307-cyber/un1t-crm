// FINDTEAM.9 — every placed row is a redirect, and one whose target is gone
// (placed_into_registration_id null: the FK is ON DELETE SET NULL) refuses
// instead of falling back to the dead solo row.
import { describe, it, expect } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'
import { followPlacementForCheckin, isPlacedRedirect, checkinStatusRefusal, isAlreadyCheckedIn } from './placed-checkin.js'

describe('isPlacedRedirect', () => {
  it('is true for every placed row, target or not', () => {
    expect(isPlacedRedirect({ status: 'placed', placed_into_registration_id: 't1' })).toBe(true)
    expect(isPlacedRedirect({ status: 'placed', placed_into_registration_id: null })).toBe(true)
  })
  it('is false for any other status, and for nothing', () => {
    expect(isPlacedRedirect({ status: 'confirmed', placed_into_registration_id: 't1' })).toBe(false)
    expect(isPlacedRedirect({ status: 'cancelled', placed_into_registration_id: null })).toBe(false)
    expect(isPlacedRedirect(null)).toBe(false)
  })
})

describe('followPlacementForCheckin', () => {
  it('refuses a missing target as target_gone without reading anything', async () => {
    const db = fakeDb(() => ({ data: null, error: null }))
    expect(await followPlacementForCheckin(db, { eventId: 'e1', placedIntoId: null, person: { email: 'a@x.test' } })).toEqual({ ok: false, reason: 'target_gone' })
    expect(db.queries).toHaveLength(0)
  })
  it('still follows a live target to the person\'s member row there', async () => {
    const db = fakeDb(() => ({ data: { id: 't1', race_event_id: 'e1', status: 'confirmed', teams: { team_members: [{ id: 'm1', email: 'A@x.test', contact_id: null }] } }, error: null }))
    expect(await followPlacementForCheckin(db, { eventId: 'e1', placedIntoId: 't1', person: { email: 'a@x.test' } }))
      .toEqual({ ok: true, registrationId: 't1', member: { id: 'm1', email: 'A@x.test', contact_id: null }, registrationStatus: 'confirmed' })
  })
})

// CHECKINSTATUS.1 — audit 2026-11-15 item 11.
describe('checkinStatusRefusal', () => {
  it('confirmed and no_show may check in', () => {
    expect(checkinStatusRefusal('confirmed')).toBeNull()
    expect(checkinStatusRefusal('no_show')).toBeNull()
  })
  it('cancelled, unpaid and anything else are refused, each with plain words', () => {
    expect(checkinStatusRefusal('cancelled')).toMatch(/cancelled/)
    expect(checkinStatusRefusal('pending_payment')).toMatch(/not been paid/)
    expect(checkinStatusRefusal('placed')).toMatch(/cannot be checked in/)
    expect(checkinStatusRefusal(undefined)).toMatch(/cannot be checked in/)
  })
})
describe('isAlreadyCheckedIn', () => {
  it('reads a unique violation as already in, and nothing else', () => {
    expect(isAlreadyCheckedIn({ message: 'duplicate key value violates unique constraint "race_checkins_pkey"' })).toBe(true)
    expect(isAlreadyCheckedIn({ code: '23505', message: '23505' })).toBe(true)
    expect(isAlreadyCheckedIn({ message: 'permission denied' })).toBe(false)
    expect(isAlreadyCheckedIn(null)).toBe(false)
  })
})
