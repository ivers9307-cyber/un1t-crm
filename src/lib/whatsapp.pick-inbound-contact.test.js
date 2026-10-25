// ORGCONTACTS.3 — pickInboundContact: which of the contacts sharing the
// sender's phone an inbound WhatsApp message is FROM.
//
// Several contacts can share one phone (a ClassPass placeholder and the real
// account, a parent and a child, 7 contacts on one number on 18 Oct 2026). The
// pick prefers the person with an ACTIVE contact_studios row at a candidate
// studio (the studios the receiving number is switched on at, plus its home),
// by latest last_seen_at; then the contact whose primary studio is a
// candidate; then the oldest match. The caller passes the matches ordered
// oldest first, so the last fallback is deterministic. Supersedes the
// COMMS-AUDIT 2026-07-10 "prefer the receiving number's location" rule, which
// is the second tier here. Fictional ids only.
import { describe, it, expect } from 'vitest'
import { pickInboundContact } from './whatsapp.js'

const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const OTHER = 'loc-other'
const CANDIDATES = [STILL, HATCH]
const row = (locationId, status = 'active', lastSeenAt = null) => ({ location_id: locationId, status, last_seen_at: lastSeenAt })
const rows = (entries) => new Map(Object.entries(entries))

const A = { id: 'a', location_id: OTHER }
const B = { id: 'b', location_id: STILL }
const C = { id: 'c', location_id: HATCH }

describe('pickInboundContact', () => {
  it('prefers the contact with an active row at a candidate, by latest last_seen_at', () => {
    const studiosByContact = rows({
      a: [row(HATCH, 'active', '2026-10-01T00:00:00Z')],
      b: [row(STILL, 'active', '2026-10-10T00:00:00Z')],
    })
    expect(pickInboundContact([A, B, C], { candidateLocationIds: CANDIDATES, studiosByContact })).toBe(B)
    // Flipped activity flips the answer; C (primary at a candidate, no row) loses to both.
    const flipped = rows({
      a: [row(HATCH, 'active', '2026-10-12T00:00:00Z')],
      b: [row(STILL, 'active', '2026-10-10T00:00:00Z')],
    })
    expect(pickInboundContact([A, B, C], { candidateLocationIds: CANDIDATES, studiosByContact: flipped })).toBe(A)
  })

  it('an ended row, or an active row at a non-candidate studio, does not count', () => {
    const studiosByContact = rows({
      a: [row(STILL, 'ended', '2026-10-12T00:00:00Z'), row(OTHER, 'active', '2026-10-12T00:00:00Z')],
      c: [row(HATCH, 'active', '2026-01-01T00:00:00Z')],
    })
    expect(pickInboundContact([A, B, C], { candidateLocationIds: CANDIDATES, studiosByContact })).toBe(C)
  })

  it('else the one whose primary studio is a candidate', () => {
    expect(pickInboundContact([A, B, C], { candidateLocationIds: CANDIDATES, studiosByContact: rows({}) })).toBe(B)
    expect(pickInboundContact([A, C, B], { candidateLocationIds: CANDIDATES, studiosByContact: null })).toBe(C)
    expect(pickInboundContact([A, B], { candidateLocationIds: [HATCH], studiosByContact: null })).toBe(A)
  })

  it('else the oldest (first in the caller-ordered list)', () => {
    expect(pickInboundContact([A, B], { candidateLocationIds: [], studiosByContact: null })).toBe(A)
    expect(pickInboundContact([B, A], { candidateLocationIds: [], studiosByContact: null })).toBe(B)
    expect(pickInboundContact([A, B], {})).toBe(A)
  })

  it('deterministic on ties: equal last_seen_at → the one whose primary is a candidate, else the lower id, whatever the order', () => {
    const at = '2026-10-10T00:00:00Z'
    const tie = rows({ a: [row(HATCH, 'active', at)], b: [row(STILL, 'active', at)] })
    for (const list of [[A, B], [B, A]]) {
      expect(pickInboundContact(list, { candidateLocationIds: CANDIDATES, studiosByContact: tie })).toBe(B)
    }
    const D = { id: 'd', location_id: OTHER }
    const tieNoPrimary = rows({ a: [row(HATCH, 'active', at)], d: [row(STILL, 'active', at)] })
    for (const list of [[A, D], [D, A]]) {
      expect(pickInboundContact(list, { candidateLocationIds: CANDIDATES, studiosByContact: tieNoPrimary })).toBe(A)
    }
    // Rows with no last_seen_at tie at the bottom, still deterministic.
    const noSeen = rows({ a: [row(HATCH)], d: [row(STILL)] })
    expect(pickInboundContact([D, A], { candidateLocationIds: CANDIDATES, studiosByContact: noSeen })).toBe(A)
  })

  it('returns null for an empty or missing list', () => {
    expect(pickInboundContact([], { candidateLocationIds: CANDIDATES })).toBe(null)
    expect(pickInboundContact(null, { candidateLocationIds: CANDIDATES })).toBe(null)
  })
})
