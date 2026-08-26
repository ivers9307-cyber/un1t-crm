// src/lib/person-accounts.test.js — PERSON-ACCT.1

import { describe, it, expect } from 'vitest'
import {
  linkedAccountsForContact, corroborated, findBookingAcrossAccounts, hasBookableMembership,
  MEMBER_STATUSES, electWriteAccount, fanUpcomingBookings, summariseBookingFan,
  directSiblingRows, personRowsForContact, chunkIds, reusableSibling,
} from './person-accounts'

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
  const contactsSelectCols = []

  return {
    inCalls,
    contactsReads,
    membershipLookups,
    contactsSelectCols,
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
          // Traced (not just resolved regardless of what was asked for) so a
          // test can pin CONTACT_COLUMNS itself — a double that ignores its
          // select argument is how a field can be silently dropped from the
          // shared constant with no test noticing.
          select(cols) { contactsSelectCols.push(cols); return builder },
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

// PERSON-ACCT.3 — hasBookableMembership. Live prod (2026-08-26, 8,646
// contacts) proved contacts.glofox_membership_status is NEVER the string
// 'active' — the check this replaces (`status === 'active'`) was dead code
// at every site that had it. The real signal combines a genuine
// member/credit_member STATUS with a STATE that hasn't ended.
describe('hasBookableMembership', () => {
  it('member/credit_member + state active → bookable', () => {
    expect(hasBookableMembership({ glofox_membership_status: 'member', glofox_membership_state: 'active' })).toBe(true)
    expect(hasBookableMembership({ glofox_membership_status: 'credit_member', glofox_membership_state: 'active' })).toBe(true)
  })
  it('member/credit_member + state null/never-set → bookable', () => {
    expect(hasBookableMembership({ glofox_membership_status: 'member', glofox_membership_state: null })).toBe(true)
    expect(hasBookableMembership({ glofox_membership_status: 'credit_member' })).toBe(true) // state undefined
  })
  it('member/credit_member + state paused/locked/future → NOT bookable (a real membership, just not right now)', () => {
    expect(hasBookableMembership({ glofox_membership_status: 'member', glofox_membership_state: 'paused' })).toBe(false)
    expect(hasBookableMembership({ glofox_membership_status: 'member', glofox_membership_state: 'locked' })).toBe(false)
    expect(hasBookableMembership({ glofox_membership_status: 'credit_member', glofox_membership_state: 'future' })).toBe(false)
  })
  it('classpass_payg + state active → NOT bookable (a live account, but not a MEMBER_STATUSES status)', () => {
    expect(hasBookableMembership({ glofox_membership_status: 'classpass_payg', glofox_membership_state: 'active' })).toBe(false)
  })
  it('trial + state active → NOT bookable (same reason — trial is not in MEMBER_STATUSES)', () => {
    expect(hasBookableMembership({ glofox_membership_status: 'trial', glofox_membership_state: 'active' })).toBe(false)
  })
  it('null/missing status → NOT bookable', () => {
    expect(hasBookableMembership({ glofox_membership_status: null, glofox_membership_state: 'active' })).toBe(false)
    expect(hasBookableMembership({ glofox_membership_state: 'active' })).toBe(false)
  })
  it('null/missing row → NOT bookable', () => {
    expect(hasBookableMembership(null)).toBe(false)
    expect(hasBookableMembership(undefined)).toBe(false)
  })
})

// Quality-review finding: makeDb's 'contacts' builder used to return the
// fixture regardless of what select() asked for, so CONTACT_COLUMNS itself
// was never exercised — a future editor could drop
// glofox_membership_state (or any other field the fan-out helpers read)
// from that shared constant and every test in this file would stay green.
// Every consumer (get_my_membership's pick order, get_my_next_class,
// get_my_recent_attendance) reads only what linkedAccountsForContact
// selects, so this one assertion is load-bearing for all of them.
describe('CONTACT_COLUMNS carries every field the fan-out helpers read', () => {
  it('the contacts select includes glofox_member_id, glofox_membership_status, glofox_membership_state, trial_credits_remaining, phone, wa_phone, email, location_id', async () => {
    const db = makeDb({ contacts: [{ id: 'c1', glofox_member_id: 'gf-1' }] })
    await linkedAccountsForContact(db, 'c1')
    expect(db.contactsSelectCols.length).toBeGreaterThan(0)
    // PERSON-ACCT.8 — location_id is pinned alongside the rest: the repo has
    // a live bug class where a predicate reads a column the query never
    // SELECTED and is therefore silently always-false (electWriteAccount's
    // location guard reads acct.location_id — if this constant ever dropped
    // the field, every account would arrive with location_id === undefined
    // and the guard would just never fire).
    for (const col of ['glofox_member_id', 'glofox_membership_status', 'glofox_membership_state', 'trial_credits_remaining', 'phone', 'wa_phone', 'email', 'location_id']) {
      expect(db.contactsSelectCols[0]).toContain(col)
    }
  })
})

// Drift guard: person-accounts.js defines its own MEMBER_STATUSES (rather
// than importing account-home.js's, which pulls @/lib/auth's next/headers
// stack) — this pins the two lists equal so they can never silently diverge.
describe('MEMBER_STATUSES stays in lockstep with account-home.js', () => {
  it('matches src/lib/account-home.js\'s MEMBER_STATUSES exactly', async () => {
    const { MEMBER_STATUSES: ACCOUNT_HOME_MEMBER_STATUSES } = await import('./account-home')
    expect([...MEMBER_STATUSES]).toEqual([...ACCOUNT_HOME_MEMBER_STATUSES])
  })
})

// PERSON-ACCT.5 — electWriteAccount. All fixtures share one anchor phone
// number so "corroborated" is the default; a row is deliberately given a
// DIFFERENT phone+email when a test needs it excluded as a stranger.
describe('electWriteAccount', () => {
  const ANCHOR_PHONE = '0870001111'
  const ANCHOR_EMAIL = 'anchor@example.com'

  // Base shape every fixture spreads over — keeps each test's overrides down
  // to the one or two fields that actually matter for that test.
  function row(overrides) {
    return {
      id: 'row',
      glofox_member_id: 'gf-row',
      phone: ANCHOR_PHONE,
      wa_phone: null,
      email: null,
      glofox_membership_status: 'trial',
      glofox_membership_state: null,
      trial_credits_remaining: 0,
      last_attended_at: null,
      updated_at: null,
      location_id: null,
      ...overrides,
    }
  }

  it('zero accounts → none', () => {
    expect(electWriteAccount({ accounts: [], anchorContactId: 'anchor-1' }))
      .toEqual({ outcome: 'none', candidates: [] })
  })

  it('all-classpass → none, even though the rows corroborate with each other', () => {
    const anchor = row({ id: 'anchor-1', glofox_member_id: 'gf-a', glofox_membership_status: 'classpass_payg' })
    const sibling = row({ id: 'sib-1', glofox_member_id: 'gf-s', glofox_membership_status: 'classpass_payg' })
    expect(electWriteAccount({ accounts: [anchor, sibling], anchorContactId: 'anchor-1' }))
      .toEqual({ outcome: 'none', candidates: [] })
  })

  it('a single uncorroborated sibling → none (anchor\'s own account is ClassPass, so nothing survives)', () => {
    const anchor = row({
      id: 'anchor-1', glofox_member_id: 'gf-a', email: ANCHOR_EMAIL,
      glofox_membership_status: 'classpass_payg', glofox_membership_state: 'active',
    })
    const stranger = row({
      id: 'sib-1', glofox_member_id: 'gf-s', phone: '0861119999', email: 'stranger@example.com',
      glofox_membership_status: 'member', glofox_membership_state: 'active',
    })
    expect(electWriteAccount({ accounts: [anchor, stranger], anchorContactId: 'anchor-1' }))
      .toEqual({ outcome: 'none', candidates: [] })
  })

  it('classpass excluded even when it is the only entitled row', () => {
    const anchorClasspass = row({
      id: 'anchor-2', glofox_member_id: 'gf-a2', email: ANCHOR_EMAIL,
      glofox_membership_status: 'classpass_payg', glofox_membership_state: 'active',
      trial_credits_remaining: 5, // the ONLY row with any entitlement
    })
    const bareSibling = row({ id: 'sib-3', glofox_member_id: 'gf-s3', last_attended_at: '2026-08-01T00:00:00Z' })
    const result = electWriteAccount({ accounts: [anchorClasspass, bareSibling], anchorContactId: 'anchor-2' })
    expect(result).toEqual({ outcome: 'elected', account: bareSibling, candidates: [bareSibling] })
  })

  it('uncorroborated sibling excluded even when entitled; the anchor itself is never excluded by corroboration', () => {
    const anchor = row({ id: 'anchor-3', glofox_member_id: 'gf-a3', email: ANCHOR_EMAIL })
    const strangerWithMembership = row({
      id: 'sib-4', glofox_member_id: 'gf-s4', phone: '0865551234', email: 'nomatch@example.com',
      glofox_membership_status: 'member', glofox_membership_state: 'active',
    })
    const result = electWriteAccount({ accounts: [anchor, strangerWithMembership], anchorContactId: 'anchor-3' })
    expect(result).toEqual({ outcome: 'elected', account: anchor, candidates: [anchor] })
  })

  it('concernsMemberIds narrows the field: a concerned row with NO entitlement beats an unconcerned row WITH entitlement', () => {
    const unconcernedWithMembership = row({
      id: 'a4', glofox_member_id: 'gf-a4', glofox_membership_status: 'member', glofox_membership_state: 'active',
    })
    const concernedBare = row({ id: 'b4', glofox_member_id: 'gf-b4' })
    const result = electWriteAccount({
      accounts: [unconcernedWithMembership, concernedBare],
      anchorContactId: 'a4',
      concernsMemberIds: ['gf-b4'],
    })
    expect(result).toEqual({ outcome: 'elected', account: concernedBare, candidates: [concernedBare] })
  })

  it('concernsMemberIds that intersects nothing in the candidate set leaves the field unnarrowed', () => {
    const withMembership = row({
      id: 'a4b', glofox_member_id: 'gf-a4b', glofox_membership_status: 'member', glofox_membership_state: 'active',
    })
    const bare = row({ id: 'b4b', glofox_member_id: 'gf-b4b' })
    const result = electWriteAccount({
      accounts: [withMembership, bare],
      anchorContactId: 'a4b',
      concernsMemberIds: ['gf-does-not-exist'],
    })
    expect(result).toEqual({ outcome: 'elected', account: withMembership, candidates: [withMembership] })
  })

  it('rank order: bookable membership beats both credits and recency', () => {
    const membership = row({
      id: 'm5', glofox_member_id: 'gf-m5', glofox_membership_status: 'member', glofox_membership_state: 'active',
    })
    const credits = row({ id: 'c5', glofox_member_id: 'gf-c5', trial_credits_remaining: 3, last_attended_at: '2026-08-20T00:00:00Z' })
    const recency = row({ id: 'r5', glofox_member_id: 'gf-r5', last_attended_at: '2026-08-25T00:00:00Z' })
    const result = electWriteAccount({ accounts: [recency, credits, membership], anchorContactId: 'm5' })
    expect(result).toEqual({ outcome: 'elected', account: membership, candidates: [membership] })
  })

  it('rank order: credits beat recency when no row has a bookable membership', () => {
    const credits = row({ id: 'c5b', glofox_member_id: 'gf-c5b', trial_credits_remaining: 1 })
    const recency = row({ id: 'r5b', glofox_member_id: 'gf-r5b', last_attended_at: '2026-08-25T00:00:00Z' })
    const result = electWriteAccount({ accounts: [recency, credits], anchorContactId: 'c5b' })
    expect(result).toEqual({ outcome: 'elected', account: credits, candidates: [credits] })
  })

  it('recency: a later last_attended_at wins over an earlier one', () => {
    const earlier = row({ id: 'a6', glofox_member_id: 'gf-a6', last_attended_at: '2026-08-01T00:00:00Z' })
    const later = row({ id: 'b6', glofox_member_id: 'gf-b6', last_attended_at: '2026-08-20T00:00:00Z' })
    const result = electWriteAccount({ accounts: [earlier, later], anchorContactId: 'a6' })
    expect(result).toEqual({ outcome: 'elected', account: later, candidates: [later] })
  })

  it('recency: falls back to updated_at when last_attended_at is absent', () => {
    const olderUpdated = row({ id: 'c6', glofox_member_id: 'gf-c6', last_attended_at: null, updated_at: '2026-08-10T00:00:00Z' })
    const newerUpdated = row({ id: 'd6', glofox_member_id: 'gf-d6', last_attended_at: null, updated_at: '2026-08-24T00:00:00Z' })
    const result = electWriteAccount({ accounts: [olderUpdated, newerUpdated], anchorContactId: 'c6' })
    expect(result).toEqual({ outcome: 'elected', account: newerUpdated, candidates: [newerUpdated] })
  })

  it('recency: an unparseable last_attended_at (with no usable updated_at) sorts last, even against a very old but valid date', () => {
    const unparseable = row({ id: 'e6', glofox_member_id: 'gf-e6', last_attended_at: 'not-a-date', updated_at: null })
    const veryOldButValid = row({ id: 'f6', glofox_member_id: 'gf-f6', last_attended_at: null, updated_at: '2020-01-01T00:00:00Z' })
    const result = electWriteAccount({ accounts: [unparseable, veryOldButValid], anchorContactId: 'e6' })
    expect(result).toEqual({ outcome: 'elected', account: veryOldButValid, candidates: [veryOldButValid] })
  })

  it('determinism: the same input in a different array order elects the same account (id tie-break)', () => {
    const g = row({ id: 'ggg', glofox_member_id: 'gf-ggg' })
    const h = row({ id: 'hhh', glofox_member_id: 'gf-hhh' })
    const order1 = electWriteAccount({ accounts: [g, h], anchorContactId: 'ggg' })
    const order2 = electWriteAccount({ accounts: [h, g], anchorContactId: 'ggg' })
    expect(order1).toEqual({ outcome: 'elected', account: g, candidates: [g] })
    expect(order2).toEqual({ outcome: 'elected', account: g, candidates: [g] })
  })

  it('conflict: two tied bookable memberships escalate, most-recent-first, instead of guessing', () => {
    const older = row({
      id: 'iii', glofox_member_id: 'gf-iii', glofox_membership_status: 'member', glofox_membership_state: 'active',
      last_attended_at: '2026-08-01T00:00:00Z',
    })
    const newer = row({
      id: 'jjj', glofox_member_id: 'gf-jjj', glofox_membership_status: 'member', glofox_membership_state: 'active',
      last_attended_at: '2026-08-10T00:00:00Z',
    })
    const result = electWriteAccount({ accounts: [older, newer], anchorContactId: 'iii' })
    expect(result).toEqual({ outcome: 'conflict', candidates: [newer, older] })
  })

  it('one bookable membership + one credits-only is elected, NOT a conflict (membership outranks credits)', () => {
    const membership = row({
      id: 'm8', glofox_member_id: 'gf-m8', glofox_membership_status: 'member', glofox_membership_state: 'active',
    })
    const creditsOnly = row({ id: 'c8', glofox_member_id: 'gf-c8', trial_credits_remaining: 4 })
    const result = electWriteAccount({ accounts: [membership, creditsOnly], anchorContactId: 'm8' })
    expect(result).toEqual({ outcome: 'elected', account: membership, candidates: [membership] })
  })

  it('conflict: two credits-only rows with no membership escalate', () => {
    const fewer = row({ id: 'kkk', glofox_member_id: 'gf-kkk', trial_credits_remaining: 2 })
    const more = row({ id: 'lll', glofox_member_id: 'gf-lll', trial_credits_remaining: 5 })
    const result = electWriteAccount({ accounts: [fewer, more], anchorContactId: 'kkk' })
    expect(result.outcome).toBe('conflict')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.map((c) => c.id).sort()).toEqual(['kkk', 'lll'])
  })

  it('never mutates the input accounts array', () => {
    const a = row({ id: 'zzz', glofox_member_id: 'gf-zzz' })
    const b = row({ id: 'aaa', glofox_member_id: 'gf-aaa' })
    const accounts = [a, b]
    const before = [...accounts]
    electWriteAccount({ accounts, anchorContactId: 'zzz' })
    expect(accounts).toEqual(before)
    expect(accounts[0]).toBe(a)
    expect(accounts[1]).toBe(b)
  })

  // PERSON-ACCT.8 — defensive hardening: linkedAccountsForContact does not
  // filter by location, so a person group that ever spans two locations
  // (none do today, verified against prod 2026-08-26) would otherwise let a
  // write elect a contact at the WRONG location.
  describe('locationId guard', () => {
    it('excludes a foreign-location account: a tie collapses to the in-location survivor', () => {
      const home = row({
        id: 'home-1', glofox_member_id: 'gf-home', glofox_membership_status: 'member',
        glofox_membership_state: 'active', location_id: 'loc-1',
      })
      const foreign = row({
        id: 'foreign-1', glofox_member_id: 'gf-foreign', glofox_membership_status: 'member',
        glofox_membership_state: 'active', location_id: 'loc-2',
      })
      // Without the guard this would be a conflict (both tie at the
      // bookable-membership tier) — proof the foreign row was actually
      // excluded, not just outranked.
      const withoutGuard = electWriteAccount({ accounts: [home, foreign], anchorContactId: 'home-1' })
      expect(withoutGuard.outcome).toBe('conflict')

      const result = electWriteAccount({ accounts: [home, foreign], anchorContactId: 'home-1', locationId: 'loc-1' })
      expect(result).toEqual({ outcome: 'elected', account: home, candidates: [home] })
    })

    it('keeps a null-location account — absence is never evidence of a foreign location', () => {
      const home = row({
        id: 'home-2', glofox_member_id: 'gf-home2', glofox_membership_status: 'member',
        glofox_membership_state: 'active', location_id: 'loc-1',
      })
      const noLocation = row({
        id: 'nolocation-2', glofox_member_id: 'gf-nolocation2', glofox_membership_status: 'member',
        glofox_membership_state: 'active', location_id: null,
      })
      const result = electWriteAccount({ accounts: [home, noLocation], anchorContactId: 'home-2', locationId: 'loc-1' })
      // Both survive the guard, so this is a real tie — same as if locationId
      // had never been passed at all.
      expect(result.outcome).toBe('conflict')
      expect(result.candidates.map((c) => c.id).sort()).toEqual(['home-2', 'nolocation-2'])
    })

    it('is a no-op when locationId is not passed, even with mixed locations present', () => {
      const home = row({
        id: 'home-3', glofox_member_id: 'gf-home3', glofox_membership_status: 'member',
        glofox_membership_state: 'active', location_id: 'loc-1',
      })
      const other = row({
        id: 'other-3', glofox_member_id: 'gf-other3', glofox_membership_status: 'member',
        glofox_membership_state: 'active', location_id: 'loc-2',
      })
      const result = electWriteAccount({ accounts: [home, other], anchorContactId: 'home-3' })
      expect(result.outcome).toBe('conflict')
      expect(result.candidates.map((c) => c.id).sort()).toEqual(['home-3', 'other-3'])
    })
  })
})

// ---------------------------------------------------------------------------
// PERSON-ACCT.7 — the upcoming-bookings fan-out, shared by
// list_my_upcoming_bookings (merge), cancel_class_booking
// (findBookingAcrossAccounts) and now book_class (election activity + the
// cross-account double-booking backstop).
// ---------------------------------------------------------------------------
describe('fanUpcomingBookings', () => {
  const creds = { branchId: 'b' }
  const accounts = [
    { id: 'c-1', glofox_member_id: 'gf-1' },
    { id: 'c-2', glofox_member_id: 'gf-2' },
  ]

  it('reads UPCOMING bookings only (windowDays 0) for every account', async () => {
    const calls = []
    const fetchImpl = async (_c, memberId, opts) => {
      calls.push([memberId, opts])
      return { ok: true, bookings: [] }
    }
    const reads = await fanUpcomingBookings(creds, accounts, fetchImpl)
    expect(calls).toEqual([['gf-1', { windowDays: 0, limit: 100 }], ['gf-2', { windowDays: 0, limit: 100 }]])
    expect(reads.map((r) => r.ok)).toEqual([true, true])
  })

  it('a rejected or not-ok read is ok:false — never an empty success', async () => {
    const fetchImpl = async (_c, memberId) => {
      if (memberId === 'gf-1') throw new Error('network')
      return { ok: false, bookings: [] }
    }
    const reads = await fanUpcomingBookings(creds, accounts, fetchImpl)
    expect(reads.map((r) => r.ok)).toEqual([false, false])
    expect(reads.map((r) => r.account.id)).toEqual(['c-1', 'c-2'])
  })

  it('a missing fetchImpl reports every account unreadable rather than throwing', async () => {
    const reads = await fanUpcomingBookings(creds, accounts, undefined)
    expect(reads.every((r) => r.ok === false)).toBe(true)
  })
})

describe('summariseBookingFan', () => {
  const a1 = { id: 'c-1', glofox_member_id: 'gf-1' }
  const a2 = { id: 'c-2', glofox_member_id: 'gf-2' }
  const EVENT = '64aa00000000000000000001'

  it('names the accounts holding activity and the one already holding this event', () => {
    const out = summariseBookingFan([
      { account: a1, ok: true, bookings: [{ _id: 'b1', model_id: 'other-event', status: 'BOOKED' }] },
      { account: a2, ok: true, bookings: [{ _id: 'b2', model_id: EVENT, status: 'BOOKED' }] },
    ], EVENT)
    expect(out.concernsMemberIds).toEqual(['gf-1', 'gf-2'])
    expect(out.alreadyBookedOn).toBe(a2)
    expect(out.unreadable).toEqual([])
  })

  // /2.0/bookings is fetched with exclude_cancelled=false, so a cancelled row
  // for the very class the customer is re-booking comes back in the fan.
  // Treating it as "already booked" would refuse a legitimate re-book.
  it('a CANCELLED row is neither activity nor an existing booking', () => {
    const out = summariseBookingFan([
      { account: a1, ok: true, bookings: [{ _id: 'b1', model_id: EVENT, status: 'CANCELLED' }] },
    ], EVENT)
    expect(out.alreadyBookedOn).toBeNull()
    expect(out.concernsMemberIds).toEqual([])
  })

  // The Glofox Booking is polymorphic: the class reference is model_id, with
  // event_id only ever a defensive fallback (src/lib/class-bookings.js).
  it('matches on model_id, falling back to event_id', () => {
    expect(summariseBookingFan([{ account: a1, ok: true, bookings: [{ event_id: EVENT }] }], EVENT).alreadyBookedOn).toBe(a1)
    expect(summariseBookingFan([{ account: a1, ok: true, bookings: [{ model_id: EVENT }] }], EVENT).alreadyBookedOn).toBe(a1)
  })

  it('an unreadable account is listed, never read as "nothing booked here"', () => {
    const out = summariseBookingFan([
      { account: a1, ok: false, bookings: [] },
      { account: a2, ok: true, bookings: [] },
    ], EVENT)
    expect(out.unreadable).toEqual([a1])
    expect(out.concernsMemberIds).toEqual([])
    expect(out.alreadyBookedOn).toBeNull()
  })

  it('no event id to match → activity only, never an already-booked claim', () => {
    const out = summariseBookingFan([{ account: a1, ok: true, bookings: [{ _id: 'b1', model_id: EVENT }] }], null)
    expect(out.alreadyBookedOn).toBeNull()
    expect(out.concernsMemberIds).toEqual(['gf-1'])
  })
})

// ---------------------------------------------------------------------------
// PERSON-ACCT.9 — seeing the person BEFORE the group exists
// ---------------------------------------------------------------------------

// A second double, deliberately separate from makeDb above: these two
// functions issue query SHAPES that one does not model (`.or()` for the phone
// suffix, `.ilike()` for the email, `.limit()`), and answering them the way
// PostgREST would is the only way the search itself gets exercised.
function makeSearchDb({ rows = [], groupMembers = [], phoneError = null, emailError = null } = {}) {
  const queries = []
  const selectCols = []
  return {
    queries,
    selectCols,
    from(table) {
      const st = { or: null, ilike: null, filters: {}, limit: null }
      const settle = (single) => {
        if (table === 'person_group_members') {
          if (st.cols?.includes('group_id')) {
            const row = groupMembers.find((m) => m.contact_id === st.filters.contact_id)
            return { data: row ? { group_id: row.group_id } : null, error: null }
          }
          return { data: groupMembers.filter((m) => m.group_id === st.filters.group_id), error: null }
        }
        if (table !== 'contacts') return { data: single ? null : [], error: null }
        let out
        if (st.or) {
          if (phoneError) return { data: null, error: phoneError }
          const nums = [...st.or.matchAll(/ilike\.%(\d+)/g)].map((m) => m[1])
          out = rows.filter((c) => nums.some((n) => [c.phone, c.wa_phone]
            .some((p) => typeof p === 'string' && p.replace(/\D/g, '').endsWith(n))))
        } else if (st.ilike) {
          if (emailError) return { data: null, error: emailError }
          out = rows.filter((c) => (c.email || '').toLowerCase() === st.ilike.toLowerCase())
        } else if (Array.isArray(st.filters.id)) {
          out = rows.filter((c) => st.filters.id.includes(c.id))
        } else {
          out = rows.filter((c) => c.id === st.filters.id)
        }
        if (st.filters.location_id) out = out.filter((c) => c.location_id === st.filters.location_id)
        return single ? { data: out[0] || null, error: null } : { data: out, error: null }
      }
      const b = {
        select(cols) { st.cols = cols || ''; selectCols.push({ table, cols: cols || '' }); return b },
        eq(col, val) { st.filters[col] = val; return b },
        in(col, vals) { st.filters[col] = vals; return b },
        or(expr) { st.or = expr; queries.push({ kind: 'or', expr }); return b },
        ilike(col, val) { st.ilike = val; queries.push({ kind: 'ilike', col, val }); return b },
        limit(n) { st.limit = n; return b },
        async maybeSingle() { return settle(true) },
        then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
      }
      return b
    },
  }
}

const searchRow = (id, extra = {}) => ({
  id, name: 'Sam', glofox_member_id: null, glofox_membership_status: 'lead',
  glofox_membership_state: null, trial_credits_remaining: null, last_attended_at: null,
  phone: '+353871234567', wa_phone: null, email: 'sam@example.com',
  updated_at: '2026-08-01T00:00:00Z', location_id: 'L1', ...extra,
})

describe('directSiblingRows', () => {
  const anchor = searchRow('c1')

  it('finds a sibling by the LAST NINE digits of the phone, across phone and wa_phone', async () => {
    const db = makeSearchDb({ rows: [anchor, searchRow('c2', { phone: null, wa_phone: '00353 87 123 4567', email: 'other@x.com' })] })
    const { rows, readFailed } = await directSiblingRows(db, { anchorRow: anchor, locationId: 'L1' })
    expect(rows.map((r) => r.id)).toEqual(['c2'])
    expect(readFailed).toBe(false)
  })

  it('finds a sibling by email, case-insensitively, and never returns the anchor itself', async () => {
    const db = makeSearchDb({ rows: [anchor, searchRow('c2', { phone: '+353870000000', email: 'SAM@Example.com' })] })
    const { rows } = await directSiblingRows(db, { anchorRow: anchor, locationId: 'L1' })
    expect(rows.map((r) => r.id)).toEqual(['c2'])
  })

  it('the email lookup is an EQUALITY check — LIKE metacharacters are escaped, not honoured', async () => {
    const db = makeSearchDb({ rows: [anchor] })
    await directSiblingRows(db, { anchorRow: { ...anchor, email: 'a_b%c@x.com' }, locationId: 'L1' })
    const ilike = db.queries.find((q) => q.kind === 'ilike')
    expect(ilike.val).toBe('a\\_b\\%c@x.com')
  })

  it('scopes both searches to the location', async () => {
    const db = makeSearchDb({ rows: [anchor, searchRow('c2', { location_id: 'L2', email: 'x@x.com' })] })
    const { rows } = await directSiblingRows(db, { anchorRow: anchor, locationId: 'L1' })
    expect(rows).toEqual([])
  })

  it('a failed search reports readFailed and NEVER an empty person', async () => {
    const db = makeSearchDb({ rows: [anchor, searchRow('c2', { email: 'sam@example.com', phone: '+353870000000' })], phoneError: { message: 'boom' } })
    const { rows, readFailed } = await directSiblingRows(db, { anchorRow: anchor, locationId: 'L1' })
    expect(readFailed).toBe(true)
    // The half that DID read still comes back — a partial answer beats none.
    expect(rows.map((r) => r.id)).toEqual(['c2'])
  })

  it('no phone and no email → no queries at all, and that is not a failure', async () => {
    const db = makeSearchDb({ rows: [anchor] })
    const out = await directSiblingRows(db, { anchorRow: { id: 'c1', phone: null, wa_phone: null, email: null }, locationId: 'L1' })
    expect(out).toEqual({ rows: [], readFailed: false })
    expect(db.queries).toEqual([])
  })

  it('a missing anchor row is unreadable, never "nobody"', async () => {
    expect(await directSiblingRows(makeSearchDb({}), { anchorRow: null })).toEqual({ rows: [], readFailed: true })
  })

  it('asks for the shared column list (a predicate must never read an unselected column)', async () => {
    const db = makeSearchDb({ rows: [anchor] })
    await directSiblingRows(db, { anchorRow: anchor, locationId: 'L1' })
    for (const { cols } of db.selectCols) {
      for (const col of ['glofox_member_id', 'glofox_membership_status', 'glofox_membership_state',
        'trial_credits_remaining', 'last_attended_at', 'phone', 'wa_phone', 'email', 'updated_at', 'location_id']) {
        expect(cols).toContain(col)
      }
    }
  })
})

describe('personRowsForContact', () => {
  it('unions the person GROUP with the direct search, deduped', async () => {
    const anchor = searchRow('c1')
    const db = makeSearchDb({
      rows: [anchor, searchRow('c2', { phone: '+353870000000', email: 'grouped@x.com' }), searchRow('c3', { email: 'x@x.com' })],
      groupMembers: [{ contact_id: 'c1', group_id: 'g1' }, { contact_id: 'c2', group_id: 'g1' }],
    })
    const { rows, readFailed, anchorRow } = await personRowsForContact(db, { contactId: 'c1', contact: anchor, locationId: 'L1' })
    expect(rows.map((r) => r.id).sort()).toEqual(['c2', 'c3'])
    expect(anchorRow).toBe(anchor)
    expect(readFailed).toBe(false)
  })

  it('drops a group row that belongs to ANOTHER location, keeps one whose location is unknown', async () => {
    const anchor = searchRow('c1')
    const db = makeSearchDb({
      rows: [
        anchor,
        searchRow('c2', { location_id: 'L2', phone: '+353870000000', email: 'a@x.com' }),
        searchRow('c3', { location_id: null, phone: '+353870000001', email: 'b@x.com' }),
      ],
      groupMembers: [{ contact_id: 'c1', group_id: 'g1' }, { contact_id: 'c2', group_id: 'g1' }, { contact_id: 'c3', group_id: 'g1' }],
    })
    const { rows } = await personRowsForContact(db, { contactId: 'c1', contact: anchor, locationId: 'L1' })
    expect(rows.map((r) => r.id)).toEqual(['c3'])
  })

  it('a failed half sets readFailed while still returning the rows that read', async () => {
    const anchor = searchRow('c1')
    const db = makeSearchDb({
      rows: [anchor, searchRow('c2', { phone: '+353870000000', email: 'grouped@x.com' })],
      groupMembers: [{ contact_id: 'c1', group_id: 'g1' }, { contact_id: 'c2', group_id: 'g1' }],
      phoneError: { message: 'boom' },
      emailError: { message: 'boom' },
    })
    const { rows, readFailed } = await personRowsForContact(db, { contactId: 'c1', contact: anchor, locationId: 'L1' })
    expect(readFailed).toBe(true)
    expect(rows.map((r) => r.id)).toEqual(['c2'])
  })

  it('no contact id → unreadable, never an empty person', async () => {
    const out = await personRowsForContact(makeSearchDb({}), { contactId: null })
    expect(out.readFailed).toBe(true)
    expect(out.rows).toEqual([])
  })
})

describe('chunkIds', () => {
  it('caps every chunk at 150 and drops nothing', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `c${i}`)
    const chunks = chunkIds(ids)
    expect(chunks.map((c) => c.length)).toEqual([150, 150, 100])
    expect(chunks.flat()).toEqual(ids)
  })
  it('skips falsy ids and tolerates a non-array', () => {
    expect(chunkIds(['a', null, 'b', undefined])).toEqual([['a', 'b']])
    expect(chunkIds(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PERSON-ACCT.9 — reusableSibling: may a WRITE move onto this row's account?
//
// The rule exists because `corroborated` is TOO WEAK for a write: it accepts a
// shared phone, and couples/families share numbers. Stillorgan, live
// 2026-08-26: 326 phone-groups, 62 with different first names, 59 of those
// holding multiple Glofox accounts. core.js's resolveAutoVerify already
// refuses to auto-verify two ungrouped contacts on a shared number ("the
// couple case", core.test.js) — this is the same refusal at the write
// boundary.
// ---------------------------------------------------------------------------
describe('reusableSibling', () => {
  const anchor = { id: 'c1', phone: '+353871234567', wa_phone: null, email: 'sam@example.com' }
  const phoneOnly = { id: 'c2', phone: '+353871234567', wa_phone: null, email: 'partner@example.com' }
  const emailOnly = { id: 'c3', phone: '+353870000000', wa_phone: null, email: 'SAM@Example.com' }
  const nothing = { id: 'c4', phone: '+353870000001', wa_phone: null, email: 'other@example.com' }

  it('REFUSES a phone-only match from the direct search — it may be a partner', () => {
    expect(corroborated(anchor, phoneOnly)).toBe(true)      // corroboration says yes…
    expect(reusableSibling(anchor, phoneOnly)).toBe(false)  // …the write rule says no
  })

  it('accepts that same phone-only row once it is a vetted GROUP member', () => {
    expect(reusableSibling(anchor, phoneOnly, { viaGroup: true })).toBe(true)
  })

  it('accepts an exact email match with no group at all (contacts_email_unique is global)', () => {
    expect(reusableSibling(anchor, emailOnly)).toBe(true)
  })

  it('refuses a GROUP row that shares no identifier at all (a name-ish link is not a mandate)', () => {
    expect(reusableSibling(anchor, nothing, { viaGroup: true })).toBe(false)
  })

  it('a row is always reusable with itself; null rows never are', () => {
    expect(reusableSibling(anchor, { ...anchor })).toBe(true)
    expect(reusableSibling(anchor, null)).toBe(false)
    expect(reusableSibling(null, anchor)).toBe(false)
  })

  it('a missing phone/email never matches (an empty field corroborates nothing)', () => {
    const blank = { id: 'c5', phone: null, wa_phone: null, email: null }
    expect(reusableSibling(blank, { id: 'c6', phone: null, wa_phone: null, email: null }, { viaGroup: true })).toBe(false)
  })

  it('viaGroup must be exactly true — a truthy accident does not unlock a write', () => {
    expect(reusableSibling(anchor, phoneOnly, { viaGroup: 'yes' })).toBe(false)
    expect(reusableSibling(anchor, phoneOnly, { viaGroup: 1 })).toBe(false)
  })
})

describe('personRowsForContact reports provenance', () => {
  it('groupContactIds names the rows the GROUP vouched for, not the direct-search ones', async () => {
    const anchor = searchRow('c1')
    const db = makeSearchDb({
      rows: [
        anchor,
        searchRow('c2', { phone: '+353870000000', email: 'grouped@x.com' }),  // group only
        searchRow('c3', { email: 'phone-only@x.com' }),                        // direct only
      ],
      groupMembers: [{ contact_id: 'c1', group_id: 'g1' }, { contact_id: 'c2', group_id: 'g1' }],
    })
    const { rows, groupContactIds } = await personRowsForContact(db, { contactId: 'c1', contact: anchor, locationId: 'L1' })
    expect(rows.map((r) => r.id).sort()).toEqual(['c2', 'c3'])
    expect(groupContactIds).toEqual(['c2'])
  })

  it('a row found BOTH ways keeps its group provenance (the stronger evidence wins)', async () => {
    const anchor = searchRow('c1')
    const db = makeSearchDb({
      rows: [anchor, searchRow('c2', { email: 'both@x.com' })], // same phone AND grouped
      groupMembers: [{ contact_id: 'c1', group_id: 'g1' }, { contact_id: 'c2', group_id: 'g1' }],
    })
    const { groupContactIds } = await personRowsForContact(db, { contactId: 'c1', contact: anchor, locationId: 'L1' })
    expect(groupContactIds).toEqual(['c2'])
  })
})
