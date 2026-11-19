// CONTACTLOG.1 — what counts as "contacted" for the board's Not contacted filter.
import { describe, it, expect } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'
import { loadRecentlyContacted, contactLogRow, contactLogSubject, CONTACT_WINDOW_DAYS } from './contact-log.js'

const LOC = 'b0000000-0000-4000-8000-00000000000b'
const OTHER = 'a0000000-0000-4000-8000-00000000000a'
const NOW = Date.parse('2026-11-19T12:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()
const c = (n) => `c0000000-0000-4000-8000-00000000000${n}`

const act = (over) => ({ id: crypto.randomUUID(), subject: 's', type: 'contact_log', kind: 'event', done: true, location_id: LOC, created_at: daysAgo(1), ...over })

describe('loadRecentlyContacted', () => {
  it('counts a logged contact, a logged call or a done call task in the window, at this studio only', async () => {
    const db = createFakeDb({ tables: { activities: [
      act({ contact_id: c(1) }),                                                      // logged yesterday
      act({ contact_id: c(2), type: 'call', kind: 'task', done: true, created_at: daysAgo(30), completed_at: daysAgo(2) }), // call task done lately
      act({ contact_id: c(3), type: 'call', kind: 'task', done: false, created_at: daysAgo(1) }), // planned, not made
      act({ contact_id: c(4), created_at: daysAgo(CONTACT_WINDOW_DAYS + 1) }),        // too long ago
      act({ contact_id: c(5), location_id: OTHER }),                                  // another studio
      act({ contact_id: c(6), type: 'email' }),                                       // an auto-logged send (broadcasts too)
      act({ contact_id: c(7), type: 'call' }),                                        // a Glofox-imported call
      act({ contact_id: c(8), type: 'whatsapp_sent' }),                               // an auto-logged send
    ] } })
    const res = await loadRecentlyContacted(db, { locationId: LOC, contactIds: [1, 2, 3, 4, 5, 6, 7, 8].map(c), nowMs: NOW })
    expect(res.ok).toBe(true)
    expect([...res.contacted].sort()).toEqual([c(1), c(2), c(7)])
  })

  it('no contacts means no read', async () => {
    const db = createFakeDb({ tables: { activities: [] } })
    expect(await loadRecentlyContacted(db, { locationId: LOC, contactIds: [], nowMs: NOW })).toEqual({ ok: true, contacted: new Set() })
    expect(db.calls).toHaveLength(0)
  })

  it('a failed read is not "nobody was contacted"', async () => {
    const db = createFakeDb({ tables: { activities: [] }, errors: { activities: { select: { message: 'boom' } } } })
    expect(await loadRecentlyContacted(db, { locationId: LOC, contactIds: [c(1)], nowMs: NOW })).toEqual({ ok: false })
  })
})

describe('contactLogRow', () => {
  it('is a done contact_log event with channel and outcome as the subject', () => {
    expect(contactLogSubject('email', 'reached')).toBe('Email: got through')
    expect(contactLogRow({ contactId: c(1), locationId: LOC, channel: 'call', outcome: 'no_reply', note: '', nowIso: 'T' })).toEqual({
      subject: 'Call: no reply', type: 'contact_log', kind: 'event', done: true, completed_at: 'T',
      contact_id: c(1), location_id: LOC, note: null, source: 'crm',
    })
  })
})
