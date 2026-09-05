// EMAIL-MERGE.2 — the refusals and the field arithmetic, pinned.
//
// Every case here is a rule that has no other enforcement site: the route that
// lands next reads canMerge()'s verdict rather than restating the conditions,
// so a rule deleted here is a rule deleted everywhere.

import { describe, it, expect } from 'vitest'
import { canMerge, mergedTicketFields, ticketFieldsFromMessages } from './email-ticket-merge'

const T = (over = {}) => ({
  id: 'a', location_id: 'loc-1', merged_into_id: null,
  unread_count: 0, first_response_at: null,
  last_message_at: '2026-08-01T00:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'hi', ...over,
})

describe('canMerge', () => {
  it('allows two ordinary tickets at the same location', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'b' }))).toEqual({ ok: true })
  })
  it('refuses merging a ticket into itself', () => {
    // Pin the exact reason, not just ok:false — nothing consumes .reason yet
    // (no merge route exists), so a transposed string here would ship silently
    // and only surface once a later PR wires user-facing copy to it.
    expect(canMerge(T({ id: 'a' }), T({ id: 'a' }))).toEqual({ ok: false, reason: 'same_ticket' })
  })
  it('refuses across locations', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'b', location_id: 'loc-2' })))
      .toEqual({ ok: false, reason: 'different_location' })
  })
  // Chains would make unmerge inexact: the second unmerge could not tell which
  // rows belonged to which source.
  it('refuses a source that is already merged', () => {
    expect(canMerge(T({ id: 'a', merged_into_id: 'c' }), T({ id: 'b' })))
      .toEqual({ ok: false, reason: 'source_already_merged' })
  })
  it('refuses merging INTO a tombstone', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'b', merged_into_id: 'c' })))
      .toEqual({ ok: false, reason: 'target_is_merged' })
  })
  it('refuses a missing ticket', () => {
    expect(canMerge(null, T())).toEqual({ ok: false, reason: 'missing_ticket' })
    expect(canMerge(T(), null)).toEqual({ ok: false, reason: 'missing_ticket' })
  })
  // MAIL-SPAM.1 review — a merge across the quarantine flag is refused in BOTH
  // directions. Live → spam is the dangerous one: the live row becomes a
  // tombstone pointing at the spam ticket, vanishes from Inbox and the count,
  // and the 30-day purge then deletes target AND tombstone — a member's
  // thread destroyed by a merge. Spam → live is refused too, so a quarantined
  // thread cannot be laundered into a live one without an explicit release.
  it('refuses a LIVE source into a QUARANTINED target', () => {
    expect(canMerge(T({ id: 'a', is_spam: false }), T({ id: 'b', is_spam: true })))
      .toEqual({ ok: false, reason: 'spam_mismatch' })
  })
  it('refuses a QUARANTINED source into a LIVE target', () => {
    expect(canMerge(T({ id: 'a', is_spam: true }), T({ id: 'b', is_spam: false })))
      .toEqual({ ok: false, reason: 'spam_mismatch' })
  })
  it('allows two quarantined tickets to merge, and treats an absent flag as live', () => {
    expect(canMerge(T({ id: 'a', is_spam: true }), T({ id: 'b', is_spam: true }))).toEqual({ ok: true })
    // Rows read before mig 584 (or fixtures without the column) are live.
    expect(canMerge(T({ id: 'a' }), T({ id: 'b', is_spam: false }))).toEqual({ ok: true })
  })
})

describe('mergedTicketFields', () => {
  it('sums unread counts', () => {
    expect(mergedTicketFields(T({ id: 'src', unread_count: 2 }), T({ id: 'tgt', unread_count: 3 })).unread_count).toBe(5)
  })
  it('keeps the EARLIER first response — it is a support metric', () => {
    expect(mergedTicketFields(
      T({ first_response_at: '2026-08-01T00:00:00Z' }),
      T({ first_response_at: '2026-08-05T00:00:00Z' }),
    ).first_response_at).toBe('2026-08-01T00:00:00Z')
  })
  it('takes the earlier value when only the source has one', () => {
    expect(mergedTicketFields(T({ first_response_at: '2026-08-01T00:00:00Z' }), T({ first_response_at: null })).first_response_at).toBe('2026-08-01T00:00:00Z')
  })
  it('adopts the newer last-message trio wholesale', () => {
    const out = mergedTicketFields(
      T({ last_message_at: '2026-08-09T00:00:00Z', last_message_direction: 'outbound', last_message_preview: 'newer' }),
      T({ last_message_at: '2026-08-02T00:00:00Z', last_message_direction: 'inbound', last_message_preview: 'older' }),
    )
    expect(out.last_message_at).toBe('2026-08-09T00:00:00Z')
    expect(out.last_message_direction).toBe('outbound')
    expect(out.last_message_preview).toBe('newer')
  })
})

// EMAIL-MERGE.4 — the inverse of mergedTicketFields, and the reason unmerge can
// claim to be an undo rather than a move. Each rule below mirrors a WRITER; a
// derivation that disagreed with one would silently rewrite correct rows on
// every unmerge, so they are pinned individually rather than through the route.
describe('ticketFieldsFromMessages', () => {
  const M = (over = {}) => ({
    direction: 'inbound', text_body: 'hello', subject: 'Subj',
    is_internal_note: false, forwarded_message_id: null,
    created_at: '2026-08-01T00:00:00Z', ...over,
  })

  it('takes the trio from the newest message', () => {
    const out = ticketFieldsFromMessages([
      M({ created_at: '2026-08-01T00:00:00Z', text_body: 'older' }),
      M({ created_at: '2026-08-09T00:00:00Z', text_body: 'newer', direction: 'outbound' }),
    ])
    expect(out.last_message_at).toBe('2026-08-09T00:00:00Z')
    expect(out.last_message_direction).toBe('outbound')
    expect(out.last_message_preview).toBe('newer')
  })

  it('ignores internal notes — the reply route never lets one advance a ticket', () => {
    const out = ticketFieldsFromMessages([
      M({ created_at: '2026-08-01T00:00:00Z', text_body: 'real' }),
      M({ created_at: '2026-08-09T00:00:00Z', text_body: 'staff only', is_internal_note: true }),
    ])
    expect(out.last_message_preview).toBe('real')
    expect(out.last_message_at).toBe('2026-08-01T00:00:00Z')
  })

  it('ignores forwards — the forward route never touches email_tickets', () => {
    const out = ticketFieldsFromMessages([
      M({ created_at: '2026-08-01T00:00:00Z', text_body: 'real' }),
      M({ created_at: '2026-08-09T00:00:00Z', text_body: 'fwd', forwarded_message_id: 'm-1', direction: 'outbound' }),
    ])
    expect(out.last_message_preview).toBe('real')
    expect(out.first_response_at).toBeNull()
  })

  it('clocks on created_at, NEVER sent_at — inbound sent_at is the sender’s own Date header', () => {
    // A remote Date header years in the future would otherwise seize the top of
    // the queue and rewrite last_message_at on every unmerge.
    const out = ticketFieldsFromMessages([
      M({ created_at: '2026-08-09T00:00:00Z', sent_at: '2035-01-01T00:00:00Z', text_body: 'spoofed date' }),
      M({ created_at: '2026-08-10T00:00:00Z', sent_at: '2019-01-01T00:00:00Z', text_body: 'actually newest' }),
    ])
    expect(out.last_message_at).toBe('2026-08-10T00:00:00Z')
    expect(out.last_message_preview).toBe('actually newest')
  })

  it('stamps first_response_at from the FIRST non-note outbound', () => {
    const out = ticketFieldsFromMessages([
      M({ created_at: '2026-08-02T00:00:00Z', direction: 'outbound', text_body: 'first answer' }),
      M({ created_at: '2026-08-03T00:00:00Z', direction: 'outbound', text_body: 'second answer' }),
      M({ created_at: '2026-08-01T00:00:00Z', direction: 'inbound' }),
    ])
    expect(out.first_response_at).toBe('2026-08-02T00:00:00Z')
  })

  it('leaves first_response_at null when nobody has answered', () => {
    expect(ticketFieldsFromMessages([M(), M()]).first_response_at).toBeNull()
  })

  it('falls back to the subject for a bodyless message, as the webhook does', () => {
    expect(ticketFieldsFromMessages([M({ text_body: '', subject: 'Just a subject' })]).last_message_preview)
      .toBe('Just a subject')
  })

  it('answers all-null for a ticket with no messages left', () => {
    expect(ticketFieldsFromMessages([])).toEqual({
      first_response_at: null, last_message_at: null,
      last_message_direction: null, last_message_preview: null,
    })
    expect(ticketFieldsFromMessages(null).last_message_at).toBeNull()
  })
})

// MAIL-SENT.1 — a survivor that absorbed ANY received mail has received mail.
describe('mergedTicketFields — has_inbound ORs', () => {
  it.each([
    [true,  true,  true],
    [true,  false, true],
    [false, true,  true],
    [false, false, false],
  ])('source %s + target %s → %s', (a, b, expected) => {
    const fields = mergedTicketFields({ has_inbound: a }, { has_inbound: b })
    expect(fields.has_inbound).toBe(expected)
  })
})
