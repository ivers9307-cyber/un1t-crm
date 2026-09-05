// CANCEL-FORM.3 — pure submission rules for the public form. No DB, no env.
//
// Dates are Dublin business days as YYYY-MM-DD strings compared lexically
// and advanced with addDaysISO (string arithmetic), never Date-at-midnight
// maths, so the same submission validates identically on a Dublin laptop
// and a UTC Vercel function (LESSONS: the roster-summary TZ bug).

import { z } from 'zod'
import { addDaysISO } from '@/lib/dublin-time'
import { REASON_CODES } from './defaults'

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// How far out a member may pick an end date. Generous; the staff decision is
// still the thing that sets the real date.
export const MAX_END_DATE_DAYS = 180

export const SubmitSchema = z.discriminatedUnion('choice', [
  z.object({
    choice: z.literal('pause'),
    start_date: isoDay,
    end_date: isoDay,
    note: z.string().max(1000).optional(),
  }),
  z.object({
    choice: z.literal('cancel'),
    reason_code: z.enum(REASON_CODES),
    reason_text: z.string().max(1000).optional(),
    requested_end_date: isoDay,
    // "This is my membership and I want to cancel it" — a forwarded link
    // lands on someone else's name, and this is the deliberate step that
    // makes them read it.
    confirm: z.literal(true),
  }),
])

/**
 * The member-facing options the GET returns (bounds + labelled reasons).
 * @param {object} copy  resolveCancellationFormCopy() output
 * @param {string} today  YYYY-MM-DD in Europe/Dublin
 */
export function formOptions(copy, today) {
  return {
    today,
    pause_offer_enabled: copy.pause_offer_enabled !== false,
    pause_max_weeks: copy.pause_max_weeks,
    notice_days: copy.notice_days,
    min_end_date: addDaysISO(today, copy.notice_days),
    max_end_date: addDaysISO(today, MAX_END_DATE_DAYS),
    reasons: REASON_CODES.map((code) => ({ code, label: copy.reason_labels[code] })),
  }
}

const clean = (s) => (typeof s === 'string' ? s.trim().slice(0, 1000) : '')

/**
 * Semantic validation of a SubmitSchema-parsed body against the operator's
 * options. Returns either { ok:false, field, error } or the request-row shape.
 *
 * @returns {{ok:false, field:string, error:string} |
 *           {ok:true, kind:'pause'|'cancellation', details:object, customerNote:string, summary:string}}
 */
export function validateSubmission(body, copy, today) {
  const pauseOffered = copy.pause_offer_enabled !== false

  if (body.choice === 'pause') {
    if (!pauseOffered) return { ok: false, field: 'choice', error: 'Pausing is not available here.' }
    if (body.start_date < today) return { ok: false, field: 'start_date', error: 'The pause has to start today or later.' }
    if (body.end_date <= body.start_date) return { ok: false, field: 'end_date', error: 'The pause has to end after it starts.' }
    const maxEnd = addDaysISO(body.start_date, copy.pause_max_weeks * 7)
    if (body.end_date > maxEnd) {
      return { ok: false, field: 'end_date', error: `A pause can run for up to ${copy.pause_max_weeks} weeks.` }
    }
    const note = clean(body.note) || 'Chose a pause instead of cancelling'
    return {
      ok: true,
      kind: 'pause',
      details: {
        source: 'cancellation_form',
        start_date: body.start_date,
        end_date: body.end_date,
        reason: note,
        pause_offered: true,
        pause_taken: true,
      },
      customerNote: note,
      summary: `Pause ${body.start_date} to ${body.end_date}`,
    }
  }

  const minEnd = addDaysISO(today, copy.notice_days)
  const maxEnd = addDaysISO(today, MAX_END_DATE_DAYS)
  if (body.requested_end_date < minEnd) {
    return {
      ok: false,
      field: 'requested_end_date',
      error: copy.notice_days > 0
        ? `The earliest end date is ${minEnd} (${copy.notice_days} days notice).`
        : 'The end date has to be today or later.',
    }
  }
  if (body.requested_end_date > maxEnd) {
    return { ok: false, field: 'requested_end_date', error: `Please choose a date before ${maxEnd}.` }
  }
  const label = copy.reason_labels[body.reason_code] || body.reason_code
  const freeText = clean(body.reason_text)
  const note = freeText || label
  return {
    ok: true,
    kind: 'cancellation',
    details: {
      source: 'cancellation_form',
      reason_code: body.reason_code,
      // The customer's own words (or the label they picked). The approval
      // card renders details.reason verbatim for pause/cancellation.
      reason: note,
      requested_end_date: body.requested_end_date,
      pause_offered: pauseOffered,
      pause_taken: false,
    },
    customerNote: note,
    summary: `${label}, ending ${body.requested_end_date}`,
  }
}
