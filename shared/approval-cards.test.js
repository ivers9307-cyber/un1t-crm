import { describe, it, expect } from 'vitest'
import { approvalCardSummary, mergeTimeline, APPROVAL_KIND_LABELS } from './approval-cards.js'

describe('approvalCardSummary', () => {
  it('class_booking → class name + time', () => {
    expect(approvalCardSummary({
      kind: 'class_booking',
      details: { class_name: 'Core Fusion', class_time: 'Wed 9:30am' },
    })).toBe('Core Fusion · Wed 9:30am')
  })
  it('pause → date span + reason', () => {
    expect(approvalCardSummary({
      kind: 'pause',
      details: { start_date: '2026-08-01', end_date: '2026-09-01', reason: 'travel' },
    })).toBe('2026-08-01 → 2026-09-01 · travel')
  })
  it('event_cancellation → event name + date', () => {
    expect(approvalCardSummary({
      kind: 'event_cancellation',
      details: { event_name: 'Hyrox Sim', event_date: 'Sat 12 Jul' },
    })).toBe('Hyrox Sim · Sat 12 Jul')
  })
  it('falls back to the kind label when details are empty', () => {
    expect(approvalCardSummary({ kind: 'cancellation', details: {} }))
      .toBe(APPROVAL_KIND_LABELS.cancellation + ' request')
  })
  it('never throws on null input', () => {
    expect(() => approvalCardSummary(null)).not.toThrow()
  })
})

describe('mergeTimeline', () => {
  const msg = (id, ts) => ({ id, sent_at: ts, body: 'x' })
  const req = (id, ts) => ({ id, created_at: ts, kind: 'class_booking', status: 'pending' })

  it('interleaves messages and requests chronologically ascending', () => {
    const out = mergeTimeline(
      [msg('m1', '2026-07-01T10:00:00Z'), msg('m2', '2026-07-01T12:00:00Z')],
      [req('r1', '2026-07-01T11:00:00Z')],
    )
    expect(out.map(i => i.key)).toEqual(['m:m1', 'a:r1', 'm:m2'])
  })

  it('same-timestamp: message renders before the approval it triggered', () => {
    const out = mergeTimeline([msg('m1', '2026-07-01T10:00:00Z')], [req('r1', '2026-07-01T10:00:00Z')])
    expect(out.map(i => i.kind)).toEqual(['message', 'approval'])
  })

  it('tags items with kind + stable key and carries the source object', () => {
    const out = mergeTimeline([msg('m1', '2026-07-01T10:00:00Z')], [])
    expect(out[0]).toMatchObject({ kind: 'message', key: 'm:m1' })
    expect(out[0].message.body).toBe('x')
  })

  it('handles empty/undefined inputs', () => {
    expect(mergeTimeline()).toEqual([])
    expect(mergeTimeline([], [])).toEqual([])
  })
})

// CANCEL-FORM.6 — form-originated cancellations carry a structured end date.
describe('CANCEL-FORM.6 — approvalCardSummary for form cancellations', () => {
  it('shows the reason and the requested end date', () => {
    expect(approvalCardSummary({ kind: 'cancellation', details: { reason: 'Too dear', requested_end_date: '2026-10-05' } }))
      .toBe('Too dear · ends 2026-10-05')
  })
  it('a Mia row with only a reason is unchanged', () => {
    expect(approvalCardSummary({ kind: 'cancellation', details: { reason: 'Moving away' } })).toBe('Moving away')
  })
})

// EVENT-MOVE.7 — Mia's move request, summarised for staff.
describe('approvalCardSummary — event_move', () => {
  const details = {
    entry_label: 'The Crushers', source_event_name: 'Hyrox Sim', source_event_date: '2099-10-18',
    target_event_name: 'Hyrox Sim', target_event_date: '2099-10-25', target_wave_label: '09:30',
    price_gap_cents: 1000, currency: 'EUR',
  }
  it('names the entry, both events with their dates and the new time, and a difference to collect', () => {
    expect(approvalCardSummary({ kind: 'event_move', details }))
      .toBe('Move The Crushers from Hyrox Sim, Sun 18 Oct to Hyrox Sim, Sun 25 Oct 09:30 · €10 difference to collect')
  })
  it('a cheaper date says it is not refunded; the same price says nothing', () => {
    expect(approvalCardSummary({ kind: 'event_move', details: { ...details, price_gap_cents: -550, target_wave_label: null } }))
      .toBe('Move The Crushers from Hyrox Sim, Sun 18 Oct to Hyrox Sim, Sun 25 Oct · €5.50 cheaper, not refunded')
    expect(approvalCardSummary({ kind: 'event_move', details: { ...details, price_gap_cents: 0 } }))
      .toBe('Move The Crushers from Hyrox Sim, Sun 18 Oct to Hyrox Sim, Sun 25 Oct 09:30')
  })
  it('has a label', () => {
    expect(APPROVAL_KIND_LABELS.event_move).toBe('Event move')
  })
})
