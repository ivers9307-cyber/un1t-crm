// src/lib/person-accounts.test.js — PERSON-ACCT.1

import { describe, it, expect } from 'vitest'
import { linkedAccountsForContact, corroborated, findBookingAcrossAccounts } from './person-accounts'

// ---------------------------------------------------------------------------
// Fake db — mirrors the house idiom (agent-requests.test.js / booking-tools
// -credits.test.js): builders are objects with chainable methods and a
// `.then` (never a `.catch`) so `await` resolves them like a real
// supabase-js thenable. Tracks every `.in()` call so the chunking tests can
// assert on chunk sizes, and a per-table call counter so the singleton
// short-circuit test can assert exactly one contacts read.
// ---------------------------------------------------------------------------
function makeDb({
  personGroupMembers = [],
  contacts = [],
  membersError = null,
  groupListError = null,
  groupMembersOverride = null,
  contactsError = null,
} = {}) {
  const inCalls = []
  const contactsReads = []
  const membershipLookups = []

  return {
    inCalls,
    contactsReads,
    membershipLookups,
    from(table) {
      if (table === 'person_group_members') {
        const state = {}
        const builder = {
          select() { return builder },
          eq(col, val) { state.eqCol = col; state.eqVal = val; return builder },
          in(col, vals) {
            inCalls.push({ table, col, vals: [...vals] })
            state.inVals = vals
            return builder
          },
          async maybeSingle() {
            // The membership lookup — always `.eq('contact_id', …)`. Only
            // membersError applies here; groupListError is scoped to the
            // second (group-members list) read below, which goes through
            // `.then()`, not `.maybeSingle()`. Recorded so the groupId
            // fast-path test can assert this is never called.
            membershipLookups.push({ eqCol: state.eqCol, eqVal: state.eqVal })
            if (membersError) return { data: null, error: membersError }
            if (state.eqCol === 'contact_id') {
              const row = personGroupMembers.find((m) => m.contact_id === state.eqVal)
              return { data: row ? { group_id: row.group_id } : null, error: null }
            }
            return { data: null, error: null }
          },
          then(resolve) {
            // The group-members list read — always `.eq('group_id', …)`.
            if (groupListError) { resolve({ data: null, error: groupListError }); return }
            if (groupMembersOverride !== null) {
              resolve({ data: groupMembersOverride, error: null })
              return
            }
            let rows = personGroupMembers
            if (state.eqCol === 'group_id') rows = rows.filter((m) => m.group_id === state.eqVal)
            resolve({ data: rows.map((m) => ({ contact_id: m.contact_id })), error: null })
          },
        }
        return builder
      }

      if (table === 'contacts') {
        const state = {}
        const builder = {
          select() { return builder },
          eq(col, val) { state.eqCol = col; state.eqVal = val; return builder },
          in(col, vals) {
            inCalls.push({ table, col, vals: [...vals] })
            state.inVals = vals
            return builder
          },
          then(resolve) {
            contactsReads.push({ eqCol: state.eqCol, eqVal: state.eqVal, inVals: state.inVals })
            if (contactsError) { resolve({ data: null, error: contactsError }); return }
            let rows
            if (state.inVals) rows = contacts.filter((c) => state.inVals.includes(c.id))
            else if (state.eqCol === 'id') rows = contacts.filter((c) => c.id === state.eqVal)
            else rows = contacts
            resolve({ data: rows, error: null })
          },
        }
        return builder
      }

      throw new Error(`makeDb: unexpected table ${table}`)
    },
  }
}

describe('linkedAccountsForContact', () => {
  it('singleton short-circuit: ungrouped contact does exactly one contacts read for its own row', async () => {
    const db = makeDb({
      personGroupMembers: [],
      contacts: [{ id: 'c1', name: 'Solo', glofox_member_id: 'gf-1' }],
    })
    const res = await linkedAccountsForContact(db, 'c1')
    expect(res.anchorContactId).toBe('c1')
    expect(res.contacts).toEqual([{ id: 'c1', name: 'Solo', glofox_member_id: 'gf-1' }])
    expect(res.accounts).toEqual([{ id: 'c1', name: 'Solo', glofox_member_id: 'gf-1' }])
    expect(res.readFailed).toBeUndefined()
    expect(db.contactsReads).toHaveLength(1)
  })

  // Dedupe precedence — mirrored fixtures. A dedupe that just does
  // "first wins" or "last wins" over the raw contacts array can pass ONE
  // ordering by accident (e.g. if the anchor row happens to be last in the
  // underlying data). Each rule below is asserted in BOTH orders, so only
  // a genuine anchor-aware / lexicographic-id comparison passes all four.
  it('dedupe rule: anchor listed SECOND (after its colliding sibling) — anchor still wins', async () => {
    const db = makeDb({
      personGroupMembers: [
        { contact_id: 'anchor', group_id: 'g1' },
        { contact_id: 'other', group_id: 'g1' },
      ],
      contacts: [
        { id: 'other', name: 'Other Row', glofox_member_id: 'gf-shared' },
        { id: 'anchor', name: 'Anchor Row', glofox_member_id: 'gf-shared' },
      ],
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res.contacts).toHaveLength(2)
    expect(res.accounts).toHaveLength(1)
    expect(res.accounts[0].id).toBe('anchor')
  })

  it('dedupe rule: anchor listed FIRST (before its colliding sibling) — anchor still wins', async () => {
    const db = makeDb({
      personGroupMembers: [
        { contact_id: 'anchor', group_id: 'g1' },
        { contact_id: 'other', group_id: 'g1' },
      ],
      contacts: [
        { id: 'anchor', name: 'Anchor Row', glofox_member_id: 'gf-shared' },
        { id: 'other', name: 'Other Row', glofox_member_id: 'gf-shared' },
      ],
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res.contacts).toHaveLength(2)
    expect(res.accounts).toHaveLength(1)
    expect(res.accounts[0].id).toBe('anchor')
  })

  it('dedupe rule: neither duplicate is the anchor, "zzz" listed BEFORE "aaa" — keeps "aaa" (lexicographically first)', async () => {
    const db = makeDb({
      personGroupMembers: [
        { contact_id: 'anchor', group_id: 'g1' },
        { contact_id: 'zzz', group_id: 'g1' },
        { contact_id: 'aaa', group_id: 'g1' },
      ],
      contacts: [
        { id: 'anchor', name: 'Anchor', glofox_member_id: 'gf-anchor-only' },
        { id: 'zzz', name: 'Zzz', glofox_member_id: 'gf-shared' },
        { id: 'aaa', name: 'Aaa', glofox_member_id: 'gf-shared' },
      ],
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    const shared = res.accounts.find((a) => a.glofox_member_id === 'gf-shared')
    expect(shared.id).toBe('aaa')
    expect(res.accounts).toHaveLength(2) // gf-anchor-only + gf-shared
  })

  it('dedupe rule: neither duplicate is the anchor, "aaa" listed BEFORE "zzz" — still keeps "aaa" (lexicographically first)', async () => {
    const db = makeDb({
      personGroupMembers: [
        { contact_id: 'anchor', group_id: 'g1' },
        { contact_id: 'aaa', group_id: 'g1' },
        { contact_id: 'zzz', group_id: 'g1' },
      ],
      contacts: [
        { id: 'anchor', name: 'Anchor', glofox_member_id: 'gf-anchor-only' },
        { id: 'aaa', name: 'Aaa', glofox_member_id: 'gf-shared' },
        { id: 'zzz', name: 'Zzz', glofox_member_id: 'gf-shared' },
      ],
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    const shared = res.accounts.find((a) => a.glofox_member_id === 'gf-shared')
    expect(shared.id).toBe('aaa')
    expect(res.accounts).toHaveLength(2) // gf-anchor-only + gf-shared
  })

  it('contacts with no glofox_member_id never appear in accounts', async () => {
    const db = makeDb({
      personGroupMembers: [{ contact_id: 'anchor', group_id: 'g1' }],
      contacts: [{ id: 'anchor', name: 'Anchor', glofox_member_id: null }],
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res.contacts).toHaveLength(1)
    expect(res.accounts).toEqual([])
  })

  it('chunking: a >150-member group produces multiple .in() calls, each ≤150 ids', async () => {
    const memberIds = Array.from({ length: 320 }, (_, i) => `c${i}`)
    const personGroupMembers = memberIds.map((cid) => ({ contact_id: cid, group_id: 'big-group' }))
    const contacts = memberIds.map((cid) => ({ id: cid, name: cid, glofox_member_id: `gf-${cid}` }))
    const db = makeDb({ personGroupMembers, contacts })

    const res = await linkedAccountsForContact(db, 'c0')

    const contactInCalls = db.inCalls.filter((c) => c.table === 'contacts')
    expect(contactInCalls.length).toBeGreaterThan(1)
    for (const call of contactInCalls) {
      expect(call.vals.length).toBeLessThanOrEqual(150)
    }
    const totalIds = contactInCalls.reduce((sum, c) => sum + c.vals.length, 0)
    expect(totalIds).toBe(320)
    expect(res.contacts).toHaveLength(320)
    expect(res.accounts).toHaveLength(320)
  })

  it('readFailed posture: an error looking up the group membership returns readFailed with empty arrays', async () => {
    const db = makeDb({ membersError: { message: 'boom' } })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res).toEqual({ anchorContactId: 'anchor', contacts: [], accounts: [], readFailed: true })
  })

  it('readFailed posture: the membership lookup succeeds but the group-members list read fails, returns readFailed with empty arrays', async () => {
    const db = makeDb({
      personGroupMembers: [{ contact_id: 'anchor', group_id: 'g1' }],
      groupListError: { message: 'boom' },
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res).toEqual({ anchorContactId: 'anchor', contacts: [], accounts: [], readFailed: true })
  })

  it('readFailed posture: an error fetching contacts (grouped path) returns readFailed with empty arrays', async () => {
    const db = makeDb({
      personGroupMembers: [{ contact_id: 'anchor', group_id: 'g1' }],
      contactsError: { message: 'boom' },
    })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res).toEqual({ anchorContactId: 'anchor', contacts: [], accounts: [], readFailed: true })
  })

  it('readFailed posture: an error fetching the contacts row (singleton path) returns readFailed with empty arrays', async () => {
    const db = makeDb({ personGroupMembers: [], contactsError: { message: 'boom' } })
    const res = await linkedAccountsForContact(db, 'anchor')
    expect(res).toEqual({ anchorContactId: 'anchor', contacts: [], accounts: [], readFailed: true })
  })

  it('bad-input guard: a missing contactId lands in readFailed, not confident-empty', async () => {
    const db = makeDb()
    expect(await linkedAccountsForContact(db, null)).toEqual({
      anchorContactId: null, contacts: [], accounts: [], readFailed: true,
    })
    expect(await linkedAccountsForContact(db, undefined)).toEqual({
      anchorContactId: null, contacts: [], accounts: [], readFailed: true,
    })
    // No queries should have been issued at all for bad input.
    expect(db.membershipLookups).toHaveLength(0)
    expect(db.contactsReads).toHaveLength(0)
  })

  it('groupId fast-path: a pre-resolved groupId skips the membership lookup entirely', async () => {
    const db = makeDb({
      personGroupMembers: [
        { contact_id: 'anchor', group_id: 'g1' },
        { contact_id: 'other', group_id: 'g1' },
      ],
      contacts: [
        { id: 'anchor', name: 'Anchor', glofox_member_id: 'gf-anchor' },
        { id: 'other', name: 'Other', glofox_member_id: 'gf-other' },
      ],
    })
    const res = await linkedAccountsForContact(db, 'anchor', { groupId: 'g1' })
    expect(db.membershipLookups).toHaveLength(0)
    expect(res.contacts).toHaveLength(2)
    expect(res.accounts).toHaveLength(2)
    expect(res.readFailed).toBeUndefined()
  })

  it('anchor union invariant: an empty group-members list read still returns the anchor\'s own row', async () => {
    const db = makeDb({
      personGroupMembers: [],
      groupMembersOverride: [], // simulates a racy/stale read finding nobody, despite groupId being known
      contacts: [{ id: 'anchor', name: 'Anchor', glofox_member_id: 'gf-anchor' }],
    })
    const res = await linkedAccountsForContact(db, 'anchor', { groupId: 'g1' })
    expect(res.readFailed).toBeUndefined()
    expect(res.contacts).toEqual([{ id: 'anchor', name: 'Anchor', glofox_member_id: 'gf-anchor' }])
    expect(res.accounts).toEqual([{ id: 'anchor', name: 'Anchor', glofox_member_id: 'gf-anchor' }])
  })
})

describe('corroborated', () => {
  it('a row is always corroborated with itself (same id), even with no matching fields', () => {
    const row = { id: 'c1', phone: null, wa_phone: null, email: null }
    expect(corroborated(row, row)).toBe(true)
    expect(corroborated(row, { ...row })).toBe(true)
  })

  it('matches on phone last-9-digits (both `phone` fields, with formatting noise)', () => {
    const a = { id: 'a', phone: '+353 87 000 1234', wa_phone: null, email: null }
    const b = { id: 'b', phone: '00353870001234', wa_phone: null, email: null }
    expect(corroborated(a, b)).toBe(true)
  })

  it('matches when the anchor\'s phone equals the other row\'s wa_phone', () => {
    const a = { id: 'a', phone: '0870001234', wa_phone: null, email: null }
    const b = { id: 'b', phone: null, wa_phone: '353870001234', email: null }
    expect(corroborated(a, b)).toBe(true)
  })

  it('matches when the anchor\'s wa_phone equals the other row\'s phone', () => {
    const a = { id: 'a', phone: null, wa_phone: '0870001234', email: null }
    const b = { id: 'b', phone: '353870001234', wa_phone: null, email: null }
    expect(corroborated(a, b)).toBe(true)
  })

  it('matches when both rows\' wa_phone match', () => {
    const a = { id: 'a', phone: null, wa_phone: '0870001234', email: null }
    const b = { id: 'b', phone: null, wa_phone: '353870001234', email: null }
    expect(corroborated(a, b)).toBe(true)
  })

  it('matches on email, case-insensitive and trimmed', () => {
    const a = { id: 'a', phone: null, wa_phone: null, email: '  Kate@Example.com ' }
    const b = { id: 'b', phone: null, wa_phone: null, email: 'kate@example.com' }
    expect(corroborated(a, b)).toBe(true)
  })

  it('does not match on a different phone and a different email', () => {
    const a = { id: 'a', phone: '0870001234', wa_phone: null, email: 'kate@example.com' }
    const b = { id: 'b', phone: '0861112222', wa_phone: null, email: 'other@example.com' }
    expect(corroborated(a, b)).toBe(false)
  })

  it('null/missing fields never match each other', () => {
    const a = { id: 'a', phone: null, wa_phone: null, email: null }
    const b = { id: 'b', phone: null, wa_phone: null, email: null }
    expect(corroborated(a, b)).toBe(false)
  })

  it('a too-short phone number never matches (fewer than 9 digits)', () => {
    const a = { id: 'a', phone: '12345', wa_phone: null, email: null }
    const b = { id: 'b', phone: '12345', wa_phone: null, email: null }
    expect(corroborated(a, b)).toBe(false)
  })
})

describe('findBookingAcrossAccounts', () => {
  const creds = { branchId: 'b1' }
  const accounts = [
    { id: 'acc1', glofox_member_id: 'gf-1' },
    { id: 'acc2', glofox_member_id: 'gf-2' },
    { id: 'acc3', glofox_member_id: 'gf-3' },
  ]

  it('finds the owner on the second account', async () => {
    const fetchImpl = async (_creds, memberId) => {
      if (memberId === 'gf-1') return { ok: true, bookings: [{ _id: 'other-booking' }] }
      if (memberId === 'gf-2') return { ok: true, bookings: [{ _id: 'target-booking' }] }
      return { ok: true, bookings: [] }
    }
    const res = await findBookingAcrossAccounts(creds, accounts, 'target-booking', fetchImpl)
    expect(res.owner).toEqual(accounts[1])
    expect(res.unreadable).toEqual([])
  })

  it('one account unreadable (rejected promise), owner found on another', async () => {
    const fetchImpl = async (_creds, memberId) => {
      if (memberId === 'gf-1') throw new Error('network blip')
      if (memberId === 'gf-2') return { ok: true, bookings: [{ _id: 'target-booking' }] }
      return { ok: true, bookings: [] }
    }
    const res = await findBookingAcrossAccounts(creds, accounts, 'target-booking', fetchImpl)
    expect(res.owner).toEqual(accounts[1])
    expect(res.unreadable).toEqual([accounts[0]])
  })

  it('one account unreadable (result.ok === false), owner found on another', async () => {
    const fetchImpl = async (_creds, memberId) => {
      if (memberId === 'gf-1') return { ok: false, bookings: [] }
      if (memberId === 'gf-3') return { ok: true, bookings: [{ _id: 'target-booking' }] }
      return { ok: true, bookings: [] }
    }
    const res = await findBookingAcrossAccounts(creds, accounts, 'target-booking', fetchImpl)
    expect(res.owner).toEqual(accounts[2])
    expect(res.unreadable).toEqual([accounts[0]])
  })

  it('not found anywhere: owner is null, no unreadable accounts', async () => {
    const fetchImpl = async () => ({ ok: true, bookings: [] })
    const res = await findBookingAcrossAccounts(creds, accounts, 'missing-booking', fetchImpl)
    expect(res.owner).toBeNull()
    expect(res.unreadable).toEqual([])
  })

  it('an ok read with empty/absent bookings is EMPTY, not unreadable', async () => {
    const fetchImpl = async (_creds, memberId) => {
      if (memberId === 'gf-1') return { ok: true, bookings: [] }
      if (memberId === 'gf-2') return { ok: true } // absent bookings key
      return { ok: true, bookings: [{ _id: 'irrelevant' }] }
    }
    const res = await findBookingAcrossAccounts(creds, accounts, 'nonexistent', fetchImpl)
    expect(res.owner).toBeNull()
    expect(res.unreadable).toEqual([])
  })

  it('calls fetchImpl per account with the exact upcoming-only options object', async () => {
    const calls = []
    const fetchImpl = async (_creds, memberId, opts) => {
      calls.push({ memberId, opts })
      return { ok: true, bookings: [] }
    }
    await findBookingAcrossAccounts(creds, accounts, 'whatever', fetchImpl)
    expect(calls).toHaveLength(accounts.length)
    for (const call of calls) {
      expect(call.opts).toEqual({ windowDays: 0, limit: 100 })
    }
    expect(calls.map((c) => c.memberId)).toEqual(['gf-1', 'gf-2', 'gf-3'])
  })

  it('first-match-wins: a booking id present on two accounts resolves to the FIRST in accounts order', async () => {
    const fetchImpl = async (_creds, memberId) => {
      if (memberId === 'gf-1') return { ok: true, bookings: [{ _id: 'dup-booking' }] }
      if (memberId === 'gf-2') return { ok: true, bookings: [{ _id: 'dup-booking' }] }
      return { ok: true, bookings: [] }
    }
    const res = await findBookingAcrossAccounts(creds, accounts, 'dup-booking', fetchImpl)
    expect(res.owner).toEqual(accounts[0])
  })

  it('guards a missing fetchImpl by reporting every account unreadable instead of throwing', async () => {
    const res = await findBookingAcrossAccounts(creds, accounts, 'any-booking', undefined)
    expect(res).toEqual({ owner: null, unreadable: accounts })
  })

  it('guards a non-function fetchImpl by reporting every account unreadable instead of throwing', async () => {
    const res = await findBookingAcrossAccounts(creds, accounts, 'any-booking', { not: 'a function' })
    expect(res).toEqual({ owner: null, unreadable: accounts })
  })
})
