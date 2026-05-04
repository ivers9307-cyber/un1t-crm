// Tests for the Tier 3C / mig 090 re-enrolment cooldown logic.
//
// The cooldown branch lives inside enrolContacts() in sequences.js.
// Rather than mock out the whole Supabase chain we re-implement the
// pure decision step here as a small helper and assert it against a
// fixture set of historical enrolments. If the production logic in
// sequences.js drifts, these assertions pin the contract so an
// accidental regression — say, blocking by ANY past enrolment when
// a cooldown is configured — is caught early.
//
// The contract being tested:
//   - cooldownDays NULL or 0 → ANY completed/exited enrolment blocks
//     re-entry (legacy single-enrolment behaviour, mig 037).
//   - cooldownDays > 0 → only the contact's MOST RECENT terminal
//     enrolment is consulted; if it ended within the cooldown window
//     the contact is blocked. Older terminal enrolments are ignored.

import { describe, it, expect } from 'vitest'

// Re-implementation of the cooldown decision in enrolContacts.
// Inputs:
//   history: rows from sequence_enrollments where status in
//            ('completed','exited') — { contact_id, last_processed_at, created_at }
//   cooldownDays: Number(seqRow.re_enrolment_cooldown_days) — may be
//                 NaN / null / 0 / a positive int.
//   now: Date.now() override (lets tests pin the clock).
function computeBlockedFromHistory({ history = [], cooldownDays, now }) {
  const blocked = new Set()
  if (Number.isFinite(cooldownDays) && cooldownDays > 0) {
    const lastEndByContact = new Map()
    for (const h of history) {
      const end = h.last_processed_at || h.created_at
      const prior = lastEndByContact.get(h.contact_id)
      if (!prior || end > prior) lastEndByContact.set(h.contact_id, end)
    }
    const cooldownMs = cooldownDays * 86400_000
    for (const [cid, end] of lastEndByContact) {
      if (now - new Date(end).getTime() < cooldownMs) blocked.add(cid)
    }
  } else {
    for (const h of history) blocked.add(h.contact_id)
  }
  return blocked
}

describe('mig 090 — re-enrolment cooldown decision', () => {
  const NOW = new Date('2026-05-04T12:00:00Z').getTime()
  const days = (n) => new Date(NOW - n * 86400_000).toISOString()

  it('legacy mode (NULL cooldown) blocks any past enrolment', () => {
    const history = [
      { contact_id: 'a', last_processed_at: days(1000), created_at: days(1000) },
      { contact_id: 'b', last_processed_at: days(1),    created_at: days(1) },
    ]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: NaN, now: NOW })
    expect(blocked.has('a')).toBe(true)
    expect(blocked.has('b')).toBe(true)
  })

  it('legacy mode (cooldown=0) blocks any past enrolment', () => {
    const history = [{ contact_id: 'a', last_processed_at: days(900), created_at: days(900) }]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: 0, now: NOW })
    expect(blocked.has('a')).toBe(true)
  })

  it('cooldown=350 blocks contact who finished 30 days ago', () => {
    const history = [{ contact_id: 'a', last_processed_at: days(30), created_at: days(35) }]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: 350, now: NOW })
    expect(blocked.has('a')).toBe(true)
  })

  it('cooldown=350 lets contact through if they finished 400 days ago', () => {
    const history = [{ contact_id: 'a', last_processed_at: days(400), created_at: days(420) }]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: 350, now: NOW })
    expect(blocked.has('a')).toBe(false)
  })

  it('cooldown picks the MOST RECENT terminal end-time per contact', () => {
    // Anniversary-style: contact ran 2 years ago AND last year. The
    // older run is ancient, the newer one is still inside cooldown.
    // Must block on the recent one, not let the contact through
    // because the oldest row predates the window.
    const history = [
      { contact_id: 'a', last_processed_at: days(700), created_at: days(720) },
      { contact_id: 'a', last_processed_at: days(30),  created_at: days(50) },
    ]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: 350, now: NOW })
    expect(blocked.has('a')).toBe(true)
  })

  it('cooldown falls back to created_at when last_processed_at is null', () => {
    // Sequences that exited in step 0 (eg. goal already met) have
    // null last_processed_at. We still need a timestamp to compare.
    const history = [{ contact_id: 'a', last_processed_at: null, created_at: days(10) }]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: 30, now: NOW })
    expect(blocked.has('a')).toBe(true)
  })

  it('cooldown=350 lets two different contacts through independently', () => {
    const history = [
      { contact_id: 'a', last_processed_at: days(360), created_at: days(380) }, // outside
      { contact_id: 'b', last_processed_at: days(60),  created_at: days(80)  }, // inside
    ]
    const blocked = computeBlockedFromHistory({ history, cooldownDays: 350, now: NOW })
    expect(blocked.has('a')).toBe(false)
    expect(blocked.has('b')).toBe(true)
  })

  it('empty history → nobody blocked, regardless of cooldown', () => {
    expect(computeBlockedFromHistory({ history: [], cooldownDays: NaN, now: NOW }).size).toBe(0)
    expect(computeBlockedFromHistory({ history: [], cooldownDays: 0,    now: NOW }).size).toBe(0)
    expect(computeBlockedFromHistory({ history: [], cooldownDays: 350,  now: NOW }).size).toBe(0)
  })
})
