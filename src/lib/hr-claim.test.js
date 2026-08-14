// src/lib/hr-claim.test.js
import { describe, it, expect } from 'vitest'
import { rankClaimCandidates, findRegistrationConflict, planAnonAdoption } from './hr-claim'

describe('rankClaimCandidates', () => {
  const roster = [
    { contact_id: 'c1', member_name: 'Alice Byrne', status: 'BOOKED' },
    { contact_id: 'c2', member_name: 'Bob Walsh', status: 'BOOKED' },
    { contact_id: null, member_name: 'Glofox Only', status: 'BOOKED' },
    { contact_id: 'c3', member_name: 'Cara Doyle', status: 'CANCELLED' },
  ]
  const contacts = [
    { id: 'c2', name: 'Bob Walsh' },
    { id: 'c9', name: 'Zoe Nolan' },
  ]

  it('puts roster members first, then search results, deduped by id', () => {
    const out = rankClaimCandidates({ roster, contacts })
    expect(out).toEqual([
      { id: 'c1', name: 'Alice Byrne', on_roster: true },
      { id: 'c2', name: 'Bob Walsh', on_roster: true },
      { id: 'c9', name: 'Zoe Nolan', on_roster: false },
    ])
  })

  it('skips roster rows with no contact_id and cancelled bookings', () => {
    const out = rankClaimCandidates({ roster, contacts: [] })
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('filters roster rows by the query (case-insensitive substring)', () => {
    const out = rankClaimCandidates({ roster, contacts: [], query: 'ali' })
    expect(out).toEqual([{ id: 'c1', name: 'Alice Byrne', on_roster: true }])
  })

  it('a query never drops search results (already filtered server-side)', () => {
    const out = rankClaimCandidates({ roster, contacts: [{ id: 'c9', name: 'Zoe Nolan' }], query: 'zoe' })
    expect(out).toEqual([{ id: 'c9', name: 'Zoe Nolan', on_roster: false }])
  })

  it('empty inputs → empty list', () => {
    expect(rankClaimCandidates({})).toEqual([])
    expect(rankClaimCandidates()).toEqual([])
  })

  it('a roster row with no name still ranks (placeholder name)', () => {
    const out = rankClaimCandidates({ roster: [{ contact_id: 'c1', member_name: null, status: null }] })
    expect(out).toEqual([{ id: 'c1', name: '—', on_roster: true }])
  })
})

describe('findRegistrationConflict', () => {
  it('null when nobody holds the strap', () => {
    expect(findRegistrationConflict({ deviceRows: [], contactId: 'c1', locationId: 'loc1' })).toBeNull()
  })

  it('null when the claiming contact already holds it (idempotent re-claim)', () => {
    const rows = [{ contact_id: 'c1', is_active: true, contacts: { name: 'Alice', location_id: 'loc1' } }]
    expect(findRegistrationConflict({ deviceRows: rows, contactId: 'c1', locationId: 'loc1' })).toBeNull()
  })

  it('conflict with name when another SAME-location contact holds it', () => {
    const rows = [{ contact_id: 'c2', is_active: true, contacts: { name: 'Bob', location_id: 'loc1' } }]
    expect(findRegistrationConflict({ deviceRows: rows, contactId: 'c1', locationId: 'loc1' }))
      .toEqual({ contactId: 'c2', name: 'Bob' })
  })

  it('conflict WITHOUT a name when the holder is at another location (no cross-tenant leak)', () => {
    const rows = [{ contact_id: 'c2', is_active: true, contacts: { name: 'Bob', location_id: 'loc2' } }]
    expect(findRegistrationConflict({ deviceRows: rows, contactId: 'c1', locationId: 'loc1' }))
      .toEqual({ contactId: 'c2', name: null })
  })

  it('ignores inactive rows (an unregistered strap is claimable)', () => {
    const rows = [{ contact_id: 'c2', is_active: false, contacts: { name: 'Bob', location_id: 'loc1' } }]
    expect(findRegistrationConflict({ deviceRows: rows, contactId: 'c1', locationId: 'loc1' })).toBeNull()
  })
})

describe('planAnonAdoption', () => {
  const anon = { id: 's1', contact_id: null, ended_at: null }

  it('adopts the open anonymous session', () => {
    expect(planAnonAdoption({ anonSession: anon, memberOpenSessionId: null }))
      .toEqual({ adoptId: 's1', reason: null })
  })

  it('refuses when the member already has an open session (mig 343 index)', () => {
    expect(planAnonAdoption({ anonSession: anon, memberOpenSessionId: 's9' }))
      .toEqual({ adoptId: null, reason: 'member-has-open-session' })
  })

  it('refuses when there is no open anonymous session', () => {
    expect(planAnonAdoption({ anonSession: null, memberOpenSessionId: null }))
      .toEqual({ adoptId: null, reason: 'no-open-anon-session' })
    expect(planAnonAdoption({})).toEqual({ adoptId: null, reason: 'no-open-anon-session' })
  })

  it('never adopts a session that already belongs to a contact', () => {
    expect(planAnonAdoption({ anonSession: { id: 's1', contact_id: 'c2', ended_at: null } }))
      .toEqual({ adoptId: null, reason: 'not-anonymous' })
  })

  it('never adopts an ended session', () => {
    expect(planAnonAdoption({ anonSession: { id: 's1', contact_id: null, ended_at: '2026-08-14T10:00:00Z' } }))
      .toEqual({ adoptId: null, reason: 'already-ended' })
  })
})
