// src/lib/person-accounts.test.js — PERSON-ACCT.1

import { describe, it, expect } from 'vitest'
import {
  linkedAccountsForContact, corroborated, findBookingAcrossAccounts, hasBookableMembership,
  MEMBER_STATUSES, electWriteAccount, fanUpcomingBookings, summariseBookingFan,
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
  it('the contacts select includes glofox_member_id, glofox_membership_status, glofox_membership_state, trial_credits_remaining, phone, wa_phone, email', async () => {
    const db = makeDb({ contacts: [{ id: 'c1', glofox_member_id: 'gf-1' }] })
    await linkedAccountsForContact(db, 'c1')
    expect(db.contactsSelectCols.length).toBeGreaterThan(0)
    for (const col of ['glofox_member_id', 'glofox_membership_status', 'glofox_membership_state', 'trial_credits_remaining', 'phone', 'wa_phone', 'email']) {
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
