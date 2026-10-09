// registration-move-public — what a CUSTOMER sees about moving their own
// entry (EVENT-MOVE.6, /event/entry/[token]). Pure and import-free, like
// registration-entry.js, so the page and the routes share one copy.
//
// Three things live here:
//   - publicMoveOptions: listMoveTargets' staff output reduced to what a
//     customer may see. Only times with room for the entry are listed; no
//     capacity, no remaining places, no count of any kind ever leaves this
//     function (a key or a sentence about room would tell a customer how
//     empty an event is). Mia's list_event_move_options (EVENT-MOVE.7,
//     shapeMoveOptionsForAgent) re-words this output: one mapper, one rule.
//   - entryMoveBlock: why an entry cannot be moved by its holder (unpaid,
//     cancelled, checked in, past), as a code and a plain sentence.
//   - the customer copy and HTTP status for every refusal. Staff copy
//     (MOVE_ERROR_MESSAGES) talks to an operator ("collect payment", "force");
//     this talks to the person who booked. Low-key, no dashes, no emoji.
//
// Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md

function money(cents, currency = 'EUR') {
  const major = (Math.abs(Number(cents) || 0) / 100).toFixed(2)
  if (currency === 'EUR') return `€${major}`
  if (currency === 'GBP') return `£${major}`
  return `${major} ${currency}`
}

/** "Same price", "€10.00 more, paid before the move", "€5.00 less, not refunded". */
export function priceNote(gapCents, currency = 'EUR') {
  const gap = Number(gapCents) || 0
  if (gap === 0) return 'Same price'
  if (gap > 0) return `${money(gap, currency)} more, paid before the move`
  return `${money(gap, currency)} less, not refunded`
}

/** Does a time take an entry of this size? Uncapped times always do. */
function timeTakes(wave, mode, headcount) {
  if (wave?.spots_left === null || wave?.spots_left === undefined) return true
  const need = mode === 'people' ? Math.max(1, Number(headcount) || 1) : 1
  return Number(wave.spots_left) >= need
}

/**
 * listMoveTargets' targets → the customer's options. Built field by field
 * (never spread), so a new staff-side field cannot leak here by accident.
 *
 * @param {Array} targets   listMoveTargets(...).targets
 * @param {number} headcount  the entry's headcount
 * @returns {Array<{ event_id, name, race_date, location_name, price_difference_cents, currency, price_note,
 *   times: Array<{ wave_id, start_time, label }> }>}
 */
export function publicMoveOptions(targets, headcount) {
  const out = []
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t?.id || !t.race_date) continue
    const waves = Array.isArray(t.waves) ? t.waves : []
    const times = waves
      .filter((w) => timeTakes(w, t.capacity_mode, headcount))
      .map((w) => ({ wave_id: w.id, start_time: typeof w.start_time === 'string' ? w.start_time.slice(0, 5) : null, label: w.label || null }))
    // An event with times but none with room is not an option at all.
    if (waves.length > 0 && times.length === 0) continue
    const gap = Number(t.price_gap_cents) || 0
    out.push({
      event_id: t.id,
      name: t.name || '',
      race_date: t.race_date || null,
      location_name: t.location_name || '',
      price_difference_cents: gap,
      currency: t.currency || 'EUR',
      price_note: priceNote(gap, t.currency || 'EUR'),
      times,
    })
  }
  return out.sort((a, b) => String(a.race_date || '').localeCompare(String(b.race_date || ''))
    || String(a.times[0]?.start_time || '').localeCompare(String(b.times[0]?.start_time || '')))
}

// Customer copy, keyed by the lib's refusal codes (MOVE_ERRORS), the gap
// payment's codes (createGapPayment) and the two the public routes add
// (event_past, and not_found for a bad link).
const MESSAGES = Object.freeze({
  not_found: 'This link is not valid any more.',
  not_active: 'This entry is no longer active, so its date cannot be changed.',
  pending_payment: 'This entry is still waiting for payment. Once it is paid you can change the date here.',
  checked_in: 'This entry has already been checked in, so its date cannot be changed.',
  event_past: 'This event has already happened, so its date cannot be changed.',
  same_event: 'You are already booked on that date.',
  target_unavailable: 'That date is no longer available. Pick another one.',
  different_payee: 'That date is no longer available. Pick another one.',
  already_entered: 'Your team already has an entry on that date.',
  headcount_not_allowed: 'That date does not take an entry of your size.',
  wave_required: 'Pick a time.',
  wrong_event: 'That time is no longer available. Pick another one.',
  wave_full: 'That time has just filled up. Pick another one.',
  load_failed: 'Something went wrong on our side. Please try again.',
  write_failed: 'Your date could not be changed and nothing was changed. Please try again.',
  conflict: 'Your entry changed while you were moving it. Reload the page and try again.',
  no_email: 'We need an email address for this entry before we can take a payment. Please get in touch with us.',
  host_not_ready: 'Online payment is not available for this event right now. Please get in touch with us.',
  provider_failed: 'The payment could not be started. Please try again.',
  already_settled: 'This change has already been paid for. Reload the page to see your entry.',
})

/** The customer's sentence for a refusal code. */
export function customerMoveMessage(code) {
  return MESSAGES[code] || 'Your date could not be changed. Please try again.'
}

// HTTP status per code. Anything not listed is a rule that refused: 400.
// Never 401/403: the token is the only credential, and a bad one is a 404.
export const CUSTOMER_MOVE_STATUS = Object.freeze({
  not_found: 404,
  wave_full: 409,
  conflict: 409,
  already_settled: 409,
  host_not_ready: 409,
  load_failed: 500,
  write_failed: 500,
  provider_failed: 502,
})

/**
 * Why the token holder cannot move this entry, or null when they can.
 * Checks what the move rules check about the SOURCE (status, check-in,
 * raced) plus the one they do not: a past event.
 *
 * @param {{ registration: object, checkinCount: number, today: string }} args  today = YYYY-MM-DD, Europe/Dublin
 * @returns {{ code: string, message: string } | null}
 */
export function entryMoveBlock({ registration, checkinCount = 0, today }) {
  const block = (code) => ({ code, message: customerMoveMessage(code) })
  if (!registration) return block('not_found')
  if (registration.status === 'pending_payment') return block('pending_payment')
  if (registration.status !== 'confirmed') return block('not_active')
  if ((Number(checkinCount) || 0) > 0 || registration.race_started_at || registration.race_finished_at) return block('checked_in')
  const date = registration.race?.race_date ? String(registration.race.race_date).slice(0, 10) : null
  if (!date || (today && date < today)) return block('event_past')
  return null
}
