// TRIALDONE.6 — Mia knows it is a trial-done conversation.
//
// A un1t.online studio with `customer_agent.trial_done.enabled` sends a trial
// finisher the opener template (trial_done_outreach, mig 756). When they
// reply, the turn's prompt carries the studio's brief (trial_done.mia_instruction)
// so Mia helps them choose the Foundation membership or a class pack through
// MIAHATCH.6's list_purchase_options / send_purchase_link.
//
// The line rides the UNCACHED suffix (buildCustomerSystemPromptParts'
// `trialDoneLine`): it is per contact, so the cached prefix never moves.
import { logWarn } from '@/lib/log'
import { instantToZonedParts } from '@/lib/location-time'
import { DEFAULTS } from './settings-contract'

// How long after the opener a reply still counts as the trial-done conversation.
export const TRIAL_DONE_CONTEXT_WINDOW_MS = 7 * 24 * 3600 * 1000

// A row closed for one of these is no longer a conversation to sell in.
const CLOSED_NO_CONTEXT = new Set(['purchased', 'opted_out'])

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// 'Friday 17 October' for an instant, on the studio's clock. null if unparseable.
function dayLabelIn(iso, zone) {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return null
  const p = instantToZonedParts(ms, zone)
  if (!WEEKDAYS[p.weekday] || !MONTHS[p.mo]) return null
  return `${WEEKDAYS[p.weekday]} ${p.d} ${MONTHS[p.mo]}`
}

/**
 * The trial-done brief for this contact at this studio, or null.
 *
 * Reads `trial_done_outreach` for (locationId, contactId). Returns the
 * studio's `trial_done.mia_instruction` with `{studio}` and `{date}` (the
 * trigger as a day in the studio zone) filled when the opener went out in the
 * last 7 days and the row is not closed `purchased` / `opted_out`. Null
 * otherwise, and on any read failure (logged, never thrown: a missing brief
 * must never cost the customer their reply).
 *
 * @param {object} db supabase client (service role)
 * @param {{ locationId: string, contactId: string, nowMs?: number, settings?: object|null, studioName?: string|null, zone?: string }} args
 * @returns {Promise<string|null>}
 */
export async function trialDoneLineFor(db, { locationId, contactId, nowMs = Date.now(), settings = null, studioName = null, zone } = {}) {
  if (!locationId || !contactId) return null
  let row
  try {
    const { data, error } = await db.from('trial_done_outreach')
      .select('trigger_at, opener_sent_at, closed_reason')
      .eq('location_id', locationId)
      .eq('contact_id', contactId)
      .maybeSingle() // unique (location_id, contact_id): zero rows is the normal answer
    if (error) {
      logWarn('trial-done', 'trial_done_outreach read failed; no trial-done context this turn', { locationId, code: error.code || null })
      return null
    }
    row = data
  } catch (err) {
    logWarn('trial-done', 'trial_done_outreach read threw; no trial-done context this turn', { locationId, errClass: err?.name || null })
    return null
  }
  if (!row) return null

  const sentMs = row.opener_sent_at ? Date.parse(row.opener_sent_at) : NaN
  if (!Number.isFinite(sentMs) || nowMs - sentMs > TRIAL_DONE_CONTEXT_WINDOW_MS) return null
  if (row.closed_reason && CLOSED_NO_CONTEXT.has(row.closed_reason)) return null

  const date = dayLabelIn(row.trigger_at, zone)
  if (!date) return null
  const td = { ...DEFAULTS.trial_done, ...(settings?.trial_done || {}) }
  const template = String(td.mia_instruction || '').trim() || DEFAULTS.trial_done.mia_instruction
  const studio = String(studioName || '').trim() || 'the studio'
  return template.replaceAll('{studio}', studio).replaceAll('{date}', date)
}
