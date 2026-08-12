// EMAIL-MERGE.2 — the refusals and the field arithmetic, pinned.
//
// Every case here is a rule that has no other enforcement site: the route that
// lands next reads canMerge()'s verdict rather than restating the conditions,
// so a rule deleted here is a rule deleted everywhere.

import { describe, it, expect } from 'vitest'
import { canMerge, mergedTicketFields } from './email-ticket-merge'

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
