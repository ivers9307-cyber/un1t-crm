// RATINGCOPY.1 — hostEventFormInitial: the race_events row → the host form's
// `initial`. The rating request copy (mig 823) must travel with the rest.
import { describe, it, expect } from 'vitest'
import { hostEventFormInitial } from './host-event-form-initial.js'

const ROW = {
  id: 'E1', host_id: 'h1', status: 'published', rejected_reason: null,
  kind: 'workshop', name: 'Mobility', description: 'Stretch', race_date: '2026-12-05',
  registration_opens_at: '2026-11-01T09:00:00+00:00', registration_closes_at: '2026-12-04T18:00:00+00:00',
  allowed_team_sizes: [1, 2], non_member_fee_cents: 2500,
  pricing_tiers: [{ label: 'Early', price_cents: 2000 }], registration_questions: [{ id: 'q1', label: 'Size?' }], duration_minutes: 90,
  hero_image_url: 'https://x.test/hero.jpg', accent_hex: '#112233', venue_name: 'Studio 1', venue_address: '1 Main St',
  confirmation_email_subject: 'You are in', confirmation_email_intro: 'See you there.',
  reminder_email_subject: 'Tomorrow', reminder_email_intro: 'Bring water.',
  rating_email_subject: 'How was {{event_name}}?', rating_email_intro: 'Two minutes, we promise.',
  series_id: 'S1',
  race_waves: [
    { id: 'w2', start_time: '14:00:00', capacity: 15, label: 'Afternoon', display_order: 1 },
    { id: 'w1', start_time: '10:00:00', capacity: 20, label: null, display_order: 0 },
  ],
}

describe('hostEventFormInitial', () => {
  it('carries the rating request copy (the two fields the edit page used to drop)', () => {
    const initial = hostEventFormInitial(ROW)
    expect(initial.rating_email_subject).toBe('How was {{event_name}}?')
    expect(initial.rating_email_intro).toBe('Two minutes, we promise.')
  })

  it('carries every other editable column unchanged', () => {
    const initial = hostEventFormInitial(ROW)
    for (const k of [
      'kind', 'name', 'description', 'race_date', 'registration_opens_at', 'registration_closes_at',
      'allowed_team_sizes', 'non_member_fee_cents', 'pricing_tiers', 'registration_questions', 'duration_minutes',
      'hero_image_url', 'accent_hex', 'venue_name', 'venue_address',
      'confirmation_email_subject', 'confirmation_email_intro', 'reminder_email_subject', 'reminder_email_intro', 'series_id',
    ]) expect(initial[k], k).toEqual(ROW[k])
  })

  it('turns the waves into session rows in display order (HH:MM)', () => {
    expect(hostEventFormInitial(ROW).sessions).toEqual([
      { id: 'w1', start_time: '10:00', label: null, capacity: 20 },
      { id: 'w2', start_time: '14:00', label: 'Afternoon', capacity: 15 },
    ])
  })

  it('never hands the form the row\'s id, owner, status or review note', () => {
    const initial = hostEventFormInitial(ROW)
    for (const k of ['id', 'host_id', 'status', 'rejected_reason', 'race_waves']) expect(initial).not.toHaveProperty(k)
  })

  it('unset copy and optional columns are null, never undefined', () => {
    const initial = hostEventFormInitial({ kind: 'workshop', name: 'X', race_waves: null })
    for (const k of ['pricing_tiers', 'registration_questions', 'duration_minutes', 'rating_email_subject', 'rating_email_intro', 'series_id']) {
      expect(initial[k], k).toBeNull()
    }
    expect(initial.sessions).toEqual([])
  })
})
