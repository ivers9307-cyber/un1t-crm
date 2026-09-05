// CANCEL-FORM.2 — operator-editable copy + options for the membership
// cancellation form. Pure: no DB, no env.
//
// Every string a member reads (the form page, the email / WhatsApp that
// carries the link, the confirmation after staff decide) ships as a code
// default here behind a settings field (locations.settings.customer_agent
// .cancellation_form), per the customer-comms-editable rule. Defaults are
// low-key, no em dashes, no emoji (see copy.test.js).
//
// Placeholders are single-brace, matching lib/agent/notify.js's {class}:
//   {first_name} {plan} {location} {link} {end_date} {start_date}

import { stripEmDashes } from '@/lib/agent/core'
import { REASON_CODES, CANCELLATION_FORM_DEFAULTS, CANCELLATION_FORM_TEXT_KEYS } from './defaults'

export { REASON_CODES, CANCELLATION_FORM_DEFAULTS, CANCELLATION_FORM_TEXT_KEYS }

// Nullable string settings (a blank means "use the default" / "not set").
const NULLABLE_STRING_KEYS = [
  'whatsapp_template_name', 'confirmation_template_cancel', 'confirmation_template_pause',
  'confirmation_template_saved', 'public_base_url',
]

const INT_BOUNDS = {
  pause_max_weeks: [1, 26],
  notice_days: [0, 90],
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Merge an operator blob over the defaults, per key, falling back whenever
 * a stored value is blank or out of range so a stale editor can never break
 * the form.
 * @param {any} blob  locations.settings.customer_agent.cancellation_form
 */
export function resolveCancellationFormCopy(blob) {
  const src = blob && typeof blob === 'object' && !Array.isArray(blob) ? blob : {}
  const out = { ...CANCELLATION_FORM_DEFAULTS }
  for (const key of CANCELLATION_FORM_TEXT_KEYS) {
    const v = str(src[key])
    if (v) out[key] = v
  }
  for (const key of NULLABLE_STRING_KEYS) {
    out[key] = str(src[key]) || null
  }
  if (typeof src.pause_offer_enabled === 'boolean') out.pause_offer_enabled = src.pause_offer_enabled
  for (const [key, [lo, hi]] of Object.entries(INT_BOUNDS)) {
    const n = Number(src[key])
    if (Number.isInteger(n) && n >= lo && n <= hi) out[key] = n
  }
  const labels = { ...CANCELLATION_FORM_DEFAULTS.reason_labels }
  if (src.reason_labels && typeof src.reason_labels === 'object') {
    for (const code of REASON_CODES) {
      const v = str(src.reason_labels[code])
      if (v) labels[code] = v
    }
  }
  out.reason_labels = labels
  return out
}

/**
 * Substitute {placeholders} and scrub em dashes. An unknown or empty
 * placeholder renders as '' (never a literal brace), except {first_name}
 * which falls back to 'there' so a greeting never reads "Hi ,".
 */
export function renderCopy(template, vars = {}) {
  const base = typeof template === 'string' ? template : ''
  const filled = base.replace(/\{([a-z_]+)\}/g, (_, key) => {
    const v = vars[key]
    if (v == null || String(v).trim() === '') return key === 'first_name' ? 'there' : ''
    return String(v)
  })
  return stripEmDashes(filled).trim()
}
