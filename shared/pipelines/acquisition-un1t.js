// HATCHPIPE.2 — the acquisition board, fed from un1t.online instead of contacts.
//
// Same stages as the Glofox acquisition board, by reference. inputSource tells
// the pipeline reclassifier to read this board's inputs from un1t.online
// (un1t_* mirror tables) rather than the contacts columns, so requiredFields
// is the identity set the reclassifier needs to place and report a row, not the
// contacts column list acquisition.js carries.
//
// TRIALDONE.2 — classify() is classifyContact() with ONE un1t-only rule on top:
// exactly 2 attended (classifyContact's 'second_class') AND the trial has
// expired (snapshot.trial_expires_at, the newest trial grant + that trial
// product's expire_credits_in_days, shapePipelineSnapshot) is 'trial_done'.
// A person cannot attend a third trial class once the trial has run out, so
// two is as far as the trial goes. classifyContact itself is not changed:
// Stillorgan's Glofox board (acquisition.js) never sees this rule.
//
// REBOOK.1 — and one more: a New Lead whose every booking here was cancelled,
// missed or passed without attendance, with nothing upcoming, is 'rebook'
// (needsRebook). Glofox's board has no Rebook column and never sees it.
//
// A board that does not declare inputSource reads contacts (acquisition.js).

import { classifyContact } from '../pipeline-classifier.js'
import { stages as acquisitionStages } from './acquisition.js'

// REBOOK.1 — the Glofox board's columns plus Rebook after New Leads (mig 807
// moved Hatch's live 302..311 up one, so these orders mirror Hatch's rows).
export const REBOOK_STAGE = Object.freeze({ slug: 'rebook', name: 'Rebook', display_order: 302, color: '#6366F1', is_dormant: false })
export const stages = Object.freeze([
  ...acquisitionStages.filter((s) => s.slug === 'new_lead'),
  REBOOK_STAGE,
  ...acquisitionStages
    .filter((s) => s.slug !== 'new_lead')
    .map((s) => Object.freeze({ ...s, display_order: s.display_order + 1 })),
])

export const inputSource = 'un1t_online'

export const requiredFields = Object.freeze(['id', 'name', 'email', 'location_id'])

/**
 * The un1t board's stage for one snapshot (shapePipelineSnapshot).
 * An unknown or unreadable trial_expires_at is never "expired".
 *
 * @param {object} snapshot
 * @param {number} [now]  epoch ms
 * @returns {string} stage slug
 */
export function classify(snapshot, now = Date.now()) {
  const slug = classifyContact(snapshot, now)
  if (slug === 'new_lead') return needsRebook(snapshot, now) ? 'rebook' : slug
  if (slug !== 'second_class') return slug
  const expiresMs = snapshot?.trial_expires_at ? Date.parse(snapshot.trial_expires_at) : NaN
  return Number.isFinite(expiresMs) && expiresMs <= now ? 'trial_done' : slug
}

// REBOOK.1 — the un1t.online statuses that end a booking without the class.
// A past BOOKED (un1t.online never marked it) is a class they did not come to
// either: a lead who trained has an ATTENDED row or a last_attended_at.
const ENDED_UNATTENDED = new Set(['CANCELLED', 'LATE_CANCELLED', 'NO_SHOW'])

/**
 * REBOOK.1 (Richard, 3 Nov 2026: "that needs to be represented better on the
 * pipeline") — a New Lead who HAD a class booked here and never came: every
 * booking cancelled, missed or past, none attended, nothing upcoming. Conall
 * (Hatch, 28 Oct) was booked into a trial class, could not sign in to the app,
 * cancelled, and sat in New Leads beside people who never booked at all. He is
 * the warmest lead on the board and needs a call to rebook, not a first touch.
 * Pure. Reads only snapshot.recent_bookings and last_attended_at.
 *
 * @param {object} snapshot  shapePipelineSnapshot output
 * @param {number} [now]     epoch ms
 */
export function needsRebook(snapshot, now = Date.now()) {
  if (snapshot?.last_attended_at) return false
  const bookings = Array.isArray(snapshot?.recent_bookings) ? snapshot.recent_bookings.filter(Boolean) : []
  if (bookings.length === 0) return false
  let missed = false
  for (const b of bookings) {
    const status = String(b.status ?? '').toUpperCase()
    if (b.attended === true || status === 'ATTENDED') return false
    const startMs = Number.isFinite(b.time_start) ? b.time_start * 1000 : NaN
    if (ENDED_UNATTENDED.has(status)) { missed = true; continue }
    // A live booking still to come: they are booked, not lost.
    if (!Number.isFinite(startMs) || startMs > now) return false
    missed = true
  }
  return missed
}
