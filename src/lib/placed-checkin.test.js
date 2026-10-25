// FINDTEAM.9 — every placed row is a redirect, and one whose target is gone
// (placed_into_registration_id null: the FK is ON DELETE SET NULL) refuses
// instead of falling back to the dead solo row.
import { describe, it, expect } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'
import { followPlacementForCheckin, isPlacedRedirect } from './placed-checkin.js'

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
    const db = fakeDb(() => ({ data: { id: 't1', race_event_id: 'e1', teams: { team_members: [{ id: 'm1', email: 'A@x.test', contact_id: null }] } }, error: null }))
    expect(await followPlacementForCheckin(db, { eventId: 'e1', placedIntoId: 't1', person: { email: 'a@x.test' } }))
      .toEqual({ ok: true, registrationId: 't1', member: { id: 'm1', email: 'A@x.test', contact_id: null } })
  })
})
