// EVENT-MOVE.7 — the in-thread texts once staff decide Mia's event_move
// request. Low-key, no em-dashes, no emoji; the new date and time named; the
// difference mentioned only when the new date costs more, with the link
// promise; never a count. Pure builders.
import { describe, it, expect } from 'vitest'
import {
  buildEventMoveConfirmationText,
  buildEventMoveFailedText,
  DEFAULT_EVENT_MOVE_CONFIRMATION_TEXT,
  DEFAULT_EVENT_MOVE_FAILED_TEXT,
  EVENT_MOVE_FAILURE_REASONS,
} from './notify'
import { MOVE_ERRORS } from '@/lib/registration-entry'

const base = { eventName: 'Hyrox Sim', dateLabel: 'Sun 25 Oct', timeLabel: '09:30', notified: true, priceGapCents: 0, currency: 'EUR' }

describe('buildEventMoveConfirmationText', () => {
  it('names the new event, date and time, and the tickets email when it went', () => {
    expect(buildEventMoveConfirmationText(base))
      .toBe('Done, your entry is now on Hyrox Sim, Sun 25 Oct at 09:30. New tickets are on their way by email.')
  })
  it('mentions the difference only when positive, with the link promise', () => {
    expect(buildEventMoveConfirmationText({ ...base, priceGapCents: 1050 }))
      .toBe('Done, your entry is now on Hyrox Sim, Sun 25 Oct at 09:30. New tickets are on their way by email. The team will send a link for the €10.50 difference.')
    expect(buildEventMoveConfirmationText({ ...base, priceGapCents: -500 })).not.toMatch(/difference|refund|€/)
  })
  it('no time, no email: says only what is true', () => {
    expect(buildEventMoveConfirmationText({ ...base, timeLabel: null, notified: false }))
      .toBe('Done, your entry is now on Hyrox Sim, Sun 25 Oct.')
  })
  it('a blank operator template falls back to the default; a set one is used with {event}', () => {
    expect(buildEventMoveConfirmationText({ ...base, template: '   ' })).toMatch(/^Done, your entry is now on/)
    expect(buildEventMoveConfirmationText({ ...base, template: 'All set for {event}.', notified: false }))
      .toBe('All set for Hyrox Sim, Sun 25 Oct at 09:30.')
  })
  it('scrubs em-dashes even from an operator template', () => {
    expect(buildEventMoveConfirmationText({ ...base, template: 'Moved — {event}.' })).not.toMatch(/—/)
  })
})

describe('buildEventMoveFailedText', () => {
  it('a plain reason, and the team will be in touch', () => {
    expect(buildEventMoveFailedText({ error: 'wave_full' })).toBe('We could not move your entry: that time is now full. The team will be in touch.')
  })
  it('every move error has a customer reason with no number in it; an unknown code still reads', () => {
    for (const code of Object.values(MOVE_ERRORS)) {
      expect(EVENT_MOVE_FAILURE_REASONS[code], code).toBeTruthy()
      expect(EVENT_MOVE_FAILURE_REASONS[code]).not.toMatch(/\d|—/)
    }
    expect(buildEventMoveFailedText({ error: 'something_new' })).toBe('We could not move your entry: something went wrong on our side. The team will be in touch.')
  })
  it('an operator template with {reason} is used', () => {
    expect(buildEventMoveFailedText({ error: 'wave_full', template: 'Sorry, {reason}. We will be in touch.' }))
      .toBe('Sorry, that time is now full. We will be in touch.')
  })
  it('the defaults carry no em-dash or emoji', () => {
    for (const t of [DEFAULT_EVENT_MOVE_CONFIRMATION_TEXT, DEFAULT_EVENT_MOVE_FAILED_TEXT]) {
      expect(t).not.toMatch(/—|\p{Extended_Pictographic}/u)
    }
  })
})
