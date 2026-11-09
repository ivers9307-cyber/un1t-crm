// RATINGCOPY.1 — the race_events row → the `initial` object HostEventForm
// hydrates from on the host edit page.
//
// The form sends EVERY field on save and PUT /api/host/events/[id] writes
// each one unconditionally (`input.x ?? null`), so a column the route writes
// but this object leaves out is wiped on the host's next save, whatever they
// changed: the form starts that field blank and posts null. That is how the
// rating request copy (rating_email_subject / rating_email_intro, mig 823)
// was lost: the page selected both columns and never handed them on.
//
// So: a column the PUT route writes from the body has a key here. The guard
// tests/host-event-edit-roundtrip-guard.test.js reads the route and fails
// when one is missing.

import { sessionsFromWaves } from './event-sessions'

/**
 * @param {object} event  a race_events row with its race_waves embed
 * @returns {object} the form's `initial` (DB column names; sessions as HH:MM rows)
 */
export function hostEventFormInitial(event) {
  return {
    kind: event.kind,
    name: event.name,
    description: event.description,
    race_date: event.race_date,
    registration_opens_at: event.registration_opens_at,
    registration_closes_at: event.registration_closes_at,
    allowed_team_sizes: event.allowed_team_sizes,
    non_member_fee_cents: event.non_member_fee_cents,
    pricing_tiers: event.pricing_tiers ?? null,
    registration_questions: event.registration_questions ?? null,
    duration_minutes: event.duration_minutes ?? null,
    hero_image_url: event.hero_image_url,
    accent_hex: event.accent_hex,
    venue_name: event.venue_name,
    venue_address: event.venue_address,
    confirmation_email_subject: event.confirmation_email_subject,
    confirmation_email_intro: event.confirmation_email_intro,
    reminder_email_subject: event.reminder_email_subject,
    reminder_email_intro: event.reminder_email_intro,
    // HOSTPAGE.2 — the post-event rating request's copy.
    rating_email_subject: event.rating_email_subject ?? null,
    rating_email_intro: event.rating_email_intro ?? null,
    // HOSTSERIES.1 — every wave is a session row on the form (HH:MM).
    sessions: sessionsFromWaves(event.race_waves),
    series_id: event.series_id ?? null,
  }
}
