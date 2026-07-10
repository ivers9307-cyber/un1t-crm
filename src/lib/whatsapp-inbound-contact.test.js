// COMMS-AUDIT 2026-07-10 — cross-location inbound contact match.
//
// The WhatsApp webhook's contact-by-phone lookup had no location filter
// and `.limit(1)` with no ordering: which contact "won" was arbitrary
// (Postgres row order), and the winner's location_id then overrode the
// receiving number's location for the whole conversation. A member of
// gym A messaging gym B's number could land in gym A's inbox — or vice
// versa, non-deterministically.
//
// pickInboundContact pins the policy: prefer a contact in the receiving
// number's location; only fall back to a cross-location match when none
// exists in-location, and the caller supplies a deterministically
// ordered list (oldest first) so the fallback is stable.
import { describe, it, expect } from 'vitest'
import { pickInboundContact } from './whatsapp.js'

const A = { id: 'a', location_id: 'loc-1' }
const B = { id: 'b', location_id: 'loc-2' }
const C = { id: 'c', location_id: 'loc-2' }

describe('pickInboundContact', () => {
  it('prefers a contact in the receiving number location', () => {
    expect(pickInboundContact([A, B], 'loc-2')).toBe(B)
    expect(pickInboundContact([B, A], 'loc-1')).toBe(A)
  })

  it('falls back to the first (deterministically ordered) match when none is in-location', () => {
    expect(pickInboundContact([A, B], 'loc-3')).toBe(A)
  })

  it('with several in-location matches, keeps list order (first wins)', () => {
    expect(pickInboundContact([A, B, C], 'loc-2')).toBe(B)
  })

  it('handles no preferred location (unresolved number) by keeping list order', () => {
    expect(pickInboundContact([B, A], null)).toBe(B)
  })

  it('returns null for an empty or missing list', () => {
    expect(pickInboundContact([], 'loc-1')).toBe(null)
    expect(pickInboundContact(null, 'loc-1')).toBe(null)
  })
})
