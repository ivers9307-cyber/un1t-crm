import { describe, it, expect } from 'vitest'
import {
  hostTagFor,
  isEmailable,
  addEventAttendeesToHostList,
  fetchHostContactRows,
} from './host-contact-list'

describe('hostTagFor', () => {
  it('prefers the slug when set', () => {
    expect(hostTagFor({ slug: 'acme-events', name: 'Something Else' })).toBe('host:acme-events')
  })
  it('derives from the name when there is no slug: lowercased, non-alnum → -', () => {
    expect(hostTagFor({ slug: null, name: 'Acme Events & Co.' })).toBe('host:acme-events-co')
  })
  it('trims leading/trailing dashes', () => {
    expect(hostTagFor({ name: '  !!Acme!!  ' })).toBe('host:acme')
  })
  it('falls back to a non-empty tag for degenerate input', () => {
    expect(hostTagFor({ name: '###' })).toBe('host:host')
    expect(hostTagFor({})).toBe('host:host')
    expect(hostTagFor(null)).toBe('host:host')
  })
})

describe('isEmailable', () => {
  // Mirrors the broadcast send path's exact marketing gate:
  //   postmark.js buildAudienceQuery — email_marketing = true,
  //   email_status NOT IN ('bounced','complained'), email_suppressed_at IS NULL
  //   campaign-sender.js consentOk — email_marketing === true &&
  //   !['bounced','complained'].includes(email_status)
  //   (an unsubscribe stamps email_status='unsubscribed' AND flips
  //   email_marketing to false — both are blocked here)
  const good = { email: 'a@b.ie', email_marketing: true, email_status: 'active', email_suppressed_at: null }

  it('is true for a consented contact with an email and clean flags', () => {
    expect(isEmailable(good, false)).toBe(true)
  })
  it('is false without an email address', () => {
    expect(isEmailable({ ...good, email: null }, false)).toBe(false)
    expect(isEmailable({ ...good, email: '' }, false)).toBe(false)
  })
  it('is false without marketing consent (email_marketing !== true)', () => {
    expect(isEmailable({ ...good, email_marketing: false }, false)).toBe(false)
    expect(isEmailable({ ...good, email_marketing: null }, false)).toBe(false)
    expect(isEmailable({ ...good, email_marketing: undefined }, false)).toBe(false)
  })
  it('is false when bounced / complained / unsubscribed', () => {
    expect(isEmailable({ ...good, email_status: 'bounced' }, false)).toBe(false)
    expect(isEmailable({ ...good, email_status: 'complained' }, false)).toBe(false)
    expect(isEmailable({ ...good, email_status: 'unsubscribed' }, false)).toBe(false)
  })
  it('tolerates a missing/other email_status', () => {
    expect(isEmailable({ ...good, email_status: null }, false)).toBe(true)
    expect(isEmailable({ ...good, email_status: undefined }, false)).toBe(true)
  })
  it('is false when inactivity-suppressed (email_suppressed_at set, mig 395)', () => {
    expect(isEmailable({ ...good, email_suppressed_at: '2026-01-01T00:00:00Z' }, false)).toBe(false)
  })
  it('is false when per-host suppressed', () => {
    expect(isEmailable(good, true)).toBe(false)
  })
  it('is false for a missing contact (defensive)', () => {
    expect(isEmailable(null, false)).toBe(false)
    expect(isEmailable(undefined, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// addEventAttendeesToHostList — fakeDb mirrors the host-events.test.js pattern.
// regPages: array of pages served to successive .range() calls.
// ---------------------------------------------------------------------------
function fakeListDb({ race, regPages = [], upsertError = null } = {}) {
  const calls = { upserts: [], regQueries: [] }
  let regCall = 0
  return {
    calls,
    from(table) {
      if (table === 'race_events') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: race, error: null }) }) }),
        }
      }
      if (table === 'race_registrations') {
        return {
          select: (cols) => {
            const filters = []
            const builder = {
              eq: (col, val) => { filters.push([col, val]); return builder },
              order: () => builder,
              range: async (from, to) => {
                calls.regQueries.push({ cols, filters: [...filters], from, to })
                const page = regPages[regCall] || []
                regCall++
                return { data: page, error: null }
              },
            }
            return builder
          },
        }
      }
      if (table === 'host_contacts') {
        return {
          upsert: async (rows, opts) => {
            calls.upserts.push({ rows, opts })
            return { error: upsertError }
          },
        }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

const reg = (contactIds) => ({
  id: 'r-' + contactIds.join('-'),
  teams: { team_members: contactIds.map((c) => ({ contact_id: c })) },
})

describe('addEventAttendeesToHostList', () => {
  it('returns 0 and never upserts when the race does not exist', async () => {
    const db = fakeListDb({ race: null })
    expect(await addEventAttendeesToHostList(db, 'ev1')).toBe(0)
    expect(db.calls.upserts).toEqual([])
  })

  it('returns 0 and never upserts for an internal (no host_id) event', async () => {
    const db = fakeListDb({ race: { id: 'ev1', host_id: null } })
    expect(await addEventAttendeesToHostList(db, 'ev1')).toBe(0)
    expect(db.calls.upserts).toEqual([])
  })

  it('only queries CONFIRMED registrations for this race', async () => {
    const db = fakeListDb({ race: { id: 'ev1', host_id: 'h1' }, regPages: [[reg(['c1'])]] })
    await addEventAttendeesToHostList(db, 'ev1')
    expect(db.calls.regQueries[0].filters).toEqual([
      ['race_event_id', 'ev1'],
      ['status', 'confirmed'],
    ])
  })

  it('dedupes contact ids, skips members without a contact_id, upserts the right shape', async () => {
    const db = fakeListDb({
      race: { id: 'ev1', host_id: 'h1' },
      regPages: [[
        reg(['c1', 'c2']),
        { id: 'r3', teams: { team_members: [{ contact_id: 'c2' }, { contact_id: null }, {}] } },
        { id: 'r4', teams: null }, // registration with no team — tolerated
      ]],
    })
    const count = await addEventAttendeesToHostList(db, 'ev1')
    expect(count).toBe(2)
    expect(db.calls.upserts).toHaveLength(1)
    expect(db.calls.upserts[0].opts).toEqual({ onConflict: 'host_id,contact_id', ignoreDuplicates: true })
    expect(db.calls.upserts[0].rows).toEqual([
      { host_id: 'h1', contact_id: 'c1', source: 'event', source_event_id: 'ev1' },
      { host_id: 'h1', contact_id: 'c2', source: 'event', source_event_id: 'ev1' },
    ])
  })

  it('returns 0 without upserting when no confirmed member has a contact_id', async () => {
    const db = fakeListDb({
      race: { id: 'ev1', host_id: 'h1' },
      regPages: [[{ id: 'r1', teams: { team_members: [{ contact_id: null }] } }]],
    })
    expect(await addEventAttendeesToHostList(db, 'ev1')).toBe(0)
    expect(db.calls.upserts).toEqual([])
  })

  it('paginates past the 1000-row select cap and chunks upserts at 500', async () => {
    // Page 1: exactly 1000 regs (forces a second range call), page 2: 5 more.
    const page1 = Array.from({ length: 1000 }, (_, i) => reg([`c${i}`]))
    const page2 = Array.from({ length: 5 }, (_, i) => reg([`d${i}`]))
    const db = fakeListDb({ race: { id: 'ev1', host_id: 'h1' }, regPages: [page1, page2] })

    const count = await addEventAttendeesToHostList(db, 'ev1')
    expect(count).toBe(1005)
    expect(db.calls.regQueries).toHaveLength(2)
    expect(db.calls.regQueries[0]).toMatchObject({ from: 0, to: 999 })
    expect(db.calls.regQueries[1]).toMatchObject({ from: 1000, to: 1999 })
    expect(db.calls.upserts.map((u) => u.rows.length)).toEqual([500, 500, 5])
  })

  it('throws on an upsert error (callers are fire-and-forget with their own catch)', async () => {
    const db = fakeListDb({
      race: { id: 'ev1', host_id: 'h1' },
      regPages: [[reg(['c1'])]],
      upsertError: { message: 'boom' },
    })
    await expect(addEventAttendeesToHostList(db, 'ev1')).rejects.toThrow(/boom/)
  })
})

// ---------------------------------------------------------------------------
// fetchHostContactRows — membership join + suppression set → emailable rows.
// ---------------------------------------------------------------------------
function fakeRowsDb({ memberships = [], suppressions = [] } = {}) {
  const calls = { hostFilters: [] }
  const pageBuilder = (table, rows) => ({
    select: () => ({
      eq: (col, val) => {
        calls.hostFilters.push([table, col, val])
        // Chainable order — the real query adds a unique-id tiebreaker
        // after created_at (stable pagination across ties).
        const chain = { order: () => chain, range: async () => ({ data: rows, error: null }) }
        return chain
      },
    }),
  })
  return {
    calls,
    from(table) {
      if (table === 'host_contacts') return pageBuilder(table, memberships)
      if (table === 'host_email_suppressions') return pageBuilder(table, suppressions)
      throw new Error('unexpected table ' + table)
    },
  }
}

describe('fetchHostContactRows', () => {
  const membership = (contactId, contact, source = 'event') => ({
    contact_id: contactId,
    source,
    created_at: '2026-07-01T10:00:00Z',
    contact,
  })
  const goodContact = (id) => ({
    id, name: 'Pat', email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null,
  })

  it('scopes BOTH queries to the host_id (tenancy)', async () => {
    const db = fakeRowsDb()
    await fetchHostContactRows(db, 'h1')
    expect(db.calls.hostFilters).toEqual([
      ['host_contacts', 'host_id', 'h1'],
      ['host_email_suppressions', 'host_id', 'h1'],
    ])
  })

  it('returns rows with emailable computed via isEmailable', async () => {
    const db = fakeRowsDb({
      memberships: [
        membership('c1', goodContact('c1')),
        membership('c2', { ...goodContact('c2'), email_marketing: false }, 'mailing_list'),
      ],
    })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows).toEqual([
      { contact_id: 'c1', name: 'Pat', email: 'c1@x.ie', source: 'event', created_at: '2026-07-01T10:00:00Z', emailable: true },
      { contact_id: 'c2', name: 'Pat', email: 'c2@x.ie', source: 'mailing_list', created_at: '2026-07-01T10:00:00Z', emailable: false },
    ])
  })

  it('marks per-host-suppressed contacts not emailable', async () => {
    const db = fakeRowsDb({
      memberships: [membership('c1', goodContact('c1'))],
      suppressions: [{ contact_id: 'c1' }],
    })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows[0].emailable).toBe(false)
  })

  it('tolerates a membership row whose contact join is missing', async () => {
    const db = fakeRowsDb({ memberships: [membership('c1', null)] })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows[0]).toMatchObject({ contact_id: 'c1', name: '', email: '', emailable: false })
  })
})

// HOST-EMAIL.6 — utility vs marketing consent families.
describe('isEmailable — utility emails', () => {
  const base = { email: 'a@x.com', email_marketing: false, email_administrative: true, email_status: 'active', email_suppressed_at: null }
  it('reaches admin-consented contacts regardless of marketing opt-out or host unsubscribe', () => {
    expect(isEmailable(base, false, { emailType: 'utility' })).toBe(true)
    expect(isEmailable(base, true, { emailType: 'utility' })).toBe(true)
    expect(isEmailable({ ...base, email_status: 'unsubscribed' }, false, { emailType: 'utility' })).toBe(true)
  })
  it('still blocks on missing admin consent and deliverability', () => {
    expect(isEmailable({ ...base, email_administrative: false }, false, { emailType: 'utility' })).toBe(false)
    expect(isEmailable({ ...base, email_status: 'bounced' }, false, { emailType: 'utility' })).toBe(false)
    expect(isEmailable({ ...base, email_status: 'complained' }, false, { emailType: 'utility' })).toBe(false)
    expect(isEmailable({ ...base, email_suppressed_at: '2026-01-01' }, false, { emailType: 'utility' })).toBe(false)
  })
  it('marketing gate is unchanged by default', () => {
    expect(isEmailable(base, false)).toBe(false)
    expect(isEmailable({ ...base, email_marketing: true }, false)).toBe(true)
    expect(isEmailable({ ...base, email_marketing: true }, true)).toBe(false)
  })
})
