// EVENT-MOVE.7 — the web-only event_move card helpers, and the fall-through
// to the shared helpers for every other kind (shared/** is untouched).
import { describe, it, expect } from 'vitest'
import { APPROVAL_KIND_LABELS, approvalCardSummary } from '@shared/approval-cards'
import { failureExplanation } from '@shared/agent-request-failure'
import {
  EVENT_MOVE_LABEL,
  EVENT_MOVE_KIND_CHIP,
  eventMoveSummary,
  eventMoveFailureExplanation,
  eventMoveDoneLine,
  approvalKindLabel,
  approvalSummary,
  explainFailure,
} from './event-move-card'

const details = {
  entry_label: 'The Crushers', source_event_name: 'Hyrox Sim', source_event_date: '2099-10-18',
  target_event_name: 'Hyrox Sim', target_event_date: '2099-10-25', target_wave_label: '09:30',
  price_gap_cents: 1000, currency: 'EUR',
}

describe('eventMoveSummary', () => {
  it('names the entry, both events with their dates and the new time, and a difference to collect', () => {
    expect(eventMoveSummary(details))
      .toBe('Move The Crushers from Hyrox Sim, Sun 18 Oct to Hyrox Sim, Sun 25 Oct 09:30 · €10 difference to collect')
  })
  it('a cheaper date says it is not refunded; the same price says nothing', () => {
    expect(eventMoveSummary({ ...details, price_gap_cents: -550, target_wave_label: null }))
      .toBe('Move The Crushers from Hyrox Sim, Sun 18 Oct to Hyrox Sim, Sun 25 Oct · €5.50 cheaper, not refunded')
    expect(eventMoveSummary({ ...details, price_gap_cents: 0 }))
      .toBe('Move The Crushers from Hyrox Sim, Sun 18 Oct to Hyrox Sim, Sun 25 Oct 09:30')
  })
  it('never throws on empty details', () => {
    expect(eventMoveSummary(null)).toBe('Move entry')
  })
})

describe('eventMoveFailureExplanation', () => {
  it("explains the refusal in the move's words and says how to fix it", () => {
    const line = eventMoveFailureExplanation({ ok: false, move_error: 'wave_full', message: 'That time is full.' })
    expect(line).toMatch(/^The move did not go through: That time is full\./)
    expect(line).toMatch(/retry/i)
    expect(line).not.toMatch(/Glofox/)
  })
  it('falls back to the code when there is no message', () => {
    expect(eventMoveFailureExplanation({ ok: false, move_error: 'conflict' })).toMatch(/^The move did not go through \(conflict\)\./)
  })
  it('null for any other result', () => {
    expect(eventMoveFailureExplanation({ ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' })).toBeNull()
    expect(eventMoveFailureExplanation(null)).toBeNull()
  })
})

describe('EVENT_MOVE_KIND_CHIP', () => {
  it('follows the light-theme chip recipe', () => {
    expect(EVENT_MOVE_KIND_CHIP).toMatch(/^bg-(\w+)-500\/10 text-\1-700$/)
  })
})

describe('eventMoveDoneLine', () => {
  it('says what happened, never Glofox', () => {
    expect(eventMoveDoneLine({ hasThread: true, notified: true })).toBe('Done. The entry is moved and the customer was told in-thread. The new tickets were emailed.')
    expect(eventMoveDoneLine({ hasThread: false, notified: false })).toBe('Done. The entry is moved. The moved email did NOT go, so send them their tickets.')
  })
})

describe('web helpers: event_move here, everything else from shared', () => {
  it('approvalKindLabel', () => {
    expect(approvalKindLabel('event_move')).toBe(EVENT_MOVE_LABEL)
    expect(approvalKindLabel('class_booking')).toBe(APPROVAL_KIND_LABELS.class_booking)
    expect(approvalKindLabel('nope')).toBeNull()
  })
  it('approvalSummary', () => {
    expect(approvalSummary({ kind: 'event_move', details })).toBe(eventMoveSummary(details))
    const other = { kind: 'event_cancellation', details: { event_name: 'Hyrox Sim', event_date: 'Sat 12 Jul' } }
    expect(approvalSummary(other)).toBe(approvalCardSummary(other))
  })
  it('explainFailure', () => {
    expect(explainFailure({ status: 'failed', details: { result: { move_error: 'wave_full', message: 'That time is full.' } } }))
      .toMatch(/^The move did not go through: That time is full\./)
    const glofox = { status: 'failed', details: { result: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } } }
    expect(explainFailure(glofox)).toBe(failureExplanation(glofox))
    expect(explainFailure({ status: 'pending', details: {} })).toBeNull()
  })
})
