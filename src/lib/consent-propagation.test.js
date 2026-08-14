// DUPEUNSUB.1 — an opt-out on one contact record must reach that person's
// other records. These tests pin the two things that make this safe rather
// than another live bug:
//   1. the email match is ESCAPED (the CLAUDE.md ilike-equality trap — `_`
//      and `%` are LIKE wildcards and legal email characters).
//   2. the write target follows scope EXACTLY the way the two consent routes
//      do — a global opt-out writes contact_preferences and lets the mig
//      489/543 trigger fan it out; a scoped opt-out writes
//      contact_location_preferences directly, at that location only. Doing
//      the wrong one for either branch is the same global-vs-location desync
//      mig 543 exists to fix, just landing on a different contact.

import { describe, it, expect, vi } from 'vitest'
import { findConsentSiblings, propagateOptOut } from './consent-propagation.js'
import { CONSENT_ACTIONS } from './consent-actions.js'

// Chainable stub in the local house style (see whatsapp-consent.test.js's
// stubDb): `from(table)` dispatches per table and every write is pushed onto
// `writes` so a test can assert which table — and ONLY that table — was
// touched. The update chains resolve via a hand-rolled THENABLE, not a real
// Promise: supabase-js builders have .then but no .catch (CLAUDE.md), and a
// mock that offered .catch would hide the exact bug that invariant warns
// about.
function buildDb({ siblings = [], siblingsError = null, writeError = null } = {}) {
  const writes = []

  const contactsChain = {
    select: vi.fn(() => contactsChain),
    or: vi.fn(() => contactsChain),
    neq: vi.fn(() => contactsChain),
    limit: vi.fn(() => Promise.resolve(
      siblingsError ? { data: null, error: siblingsError } : { data: siblings, error: null },
    )),
  }

  function updateChain(table, patch) {
    const filters = {}
    const chain = {
      in: vi.fn((col, ids) => { filters.in = ids; return chain }),
      eq: vi.fn((col, val) => { filters[col] = val; return chain }),
      then: (resolve, reject) => {
        writes.push({ table, op: 'update', patch, filters: { ...filters } })
        return Promise.resolve({ error: writeError }).then(resolve, reject)
      },
    }
    return chain
  }

  const db = {
    from: vi.fn((table) => {
      if (table === 'contacts') return contactsChain
      if (table === 'consent_log') {
        return {
          insert: vi.fn((rows) => {
            writes.push({ table, op: 'insert', rows })
            return Promise.resolve({ error: null })
          }),
        }
      }
      // contact_preferences / contact_location_preferences
      return { update: vi.fn((patch) => updateChain(table, patch)) }
    }),
  }

  return { db, writes, contactsChain }
}

describe('findConsentSiblings', () => {
  it('matches on email + wa_phone, excludes the origin contact, with an escaped + lower-cased email pattern', async () => {
    const { db, contactsChain } = buildDb({ siblings: [{ id: 'sib-1' }, { id: 'sib-2' }] })
    const ids = await findConsentSiblings(db, {
      contactId: 'origin', email: 'A_B@X.com', waPhone: '353862111105',
    })
    expect(ids).toEqual(['sib-1', 'sib-2'])
    expect(contactsChain.neq).toHaveBeenCalledWith('id', 'origin')
    expect(contactsChain.limit).toHaveBeenCalledWith(20)

    const orArg = contactsChain.or.mock.calls[0][0]
    // CLAUDE.md: `_` is a LIKE wildcard AND a legal email character — must be
    // escaped, or a_b@x.com would also match axb@x.com.
    expect(orArg).toContain('email.ilike.a\\_b@x.com')
    expect(orArg).toContain('wa_phone.eq.353862111105')
  })

  it('returns [] without querying when both email and waPhone are falsy', async () => {
    const { db } = buildDb()
    const ids = await findConsentSiblings(db, { contactId: 'origin', email: null, waPhone: null })
    expect(ids).toEqual([])
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns [] and does not throw when the query errors', async () => {
    const { db } = buildDb({ siblingsError: { message: 'boom' } })
    const ids = await findConsentSiblings(db, { contactId: 'origin', email: 'a@x.com', waPhone: null })
    expect(ids).toEqual([])
  })
})

describe('propagateOptOut — write target follows scope exactly', () => {
  it('with a locationId: writes contact_location_preferences at that location only, never contact_preferences', async () => {
    const { db, writes } = buildDb({ siblings: [{ id: 'sib-1' }] })
    const result = await propagateOptOut(db, {
      contactId: 'origin', email: 'a@x.com', waPhone: null,
      channels: ['email_marketing'], locationId: 'loc-1',
    })
    expect(result).toEqual({ propagated: 1 })

    const scopedWrite = writes.find(w => w.table === 'contact_location_preferences')
    expect(scopedWrite).toBeTruthy()
    expect(scopedWrite.filters.in).toEqual(['sib-1'])
    expect(scopedWrite.filters.location_id).toBe('loc-1')
    expect(scopedWrite.patch).toMatchObject({ email_marketing: false })
    // Direct location write bypasses the sync trigger, so unsubscribed_at
    // must be stamped by hand.
    expect(scopedWrite.patch.unsubscribed_at).toBeTruthy()

    expect(writes.some(w => w.table === 'contact_preferences')).toBe(false)
  })

  it('without a locationId: writes contact_preferences, never contact_location_preferences', async () => {
    const { db, writes } = buildDb({ siblings: [{ id: 'sib-1' }] })
    const result = await propagateOptOut(db, {
      contactId: 'origin', email: 'a@x.com', waPhone: null,
      channels: ['email_marketing'], locationId: null,
    })
    expect(result).toEqual({ propagated: 1 })

    const globalWrite = writes.find(w => w.table === 'contact_preferences')
    expect(globalWrite).toBeTruthy()
    expect(globalWrite.filters.in).toEqual(['sib-1'])
    expect(globalWrite.patch).toMatchObject({ email_marketing: false })
    // The mig 489/543 trigger stamps unsubscribed_at on the fan-out — this
    // path must not stamp it itself, or a re-subscribe could desync it.
    expect(globalWrite.patch.unsubscribed_at).toBeUndefined()

    expect(writes.some(w => w.table === 'contact_location_preferences')).toBe(false)
  })

  it('writes one consent_log row per sibling per channel, source duplicate_propagation', async () => {
    const { db, writes } = buildDb({ siblings: [{ id: 'sib-1' }, { id: 'sib-2' }] })
    await propagateOptOut(db, {
      contactId: 'origin', email: 'a@x.com', waPhone: null,
      channels: ['email_marketing', 'whatsapp_marketing'], locationId: 'loc-1',
    })
    const logWrite = writes.find(w => w.table === 'consent_log')
    expect(logWrite).toBeTruthy()
    expect(logWrite.rows).toHaveLength(4) // 2 siblings x 2 channels
    for (const row of logWrite.rows) {
      expect(row.source).toBe('duplicate_propagation')
      expect(row.action).toBe(CONSENT_ACTIONS.OPT_OUT)
      expect(row.location_id).toBe('loc-1')
    }
    expect(logWrite.rows.map(r => r.contact_id).sort()).toEqual(['sib-1', 'sib-1', 'sib-2', 'sib-2'])
    expect(logWrite.rows.map(r => r.channel).sort()).toEqual(
      ['email_marketing', 'email_marketing', 'whatsapp_marketing', 'whatsapp_marketing'],
    )
  })

  it('returns { propagated: 0 } and does not throw when the sibling write fails', async () => {
    const { db, writes } = buildDb({ siblings: [{ id: 'sib-1' }], writeError: { message: 'db down' } })
    const result = await propagateOptOut(db, {
      contactId: 'origin', email: 'a@x.com', waPhone: null,
      channels: ['email_marketing'], locationId: 'loc-1',
    })
    expect(result).toEqual({ propagated: 0 })
    // Never reaches the audit insert once the write itself failed.
    expect(writes.some(w => w.table === 'consent_log')).toBe(false)
  })

  it('returns { propagated: 0 } and writes nothing when there are no siblings', async () => {
    const { db, writes } = buildDb({ siblings: [] })
    const result = await propagateOptOut(db, {
      contactId: 'origin', email: 'nobody-shares-this@x.com', waPhone: null,
      channels: ['email_marketing'], locationId: null,
    })
    expect(result).toEqual({ propagated: 0 })
    expect(writes).toEqual([])
  })
})
