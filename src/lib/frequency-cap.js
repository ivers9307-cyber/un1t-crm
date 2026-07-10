// FREQ-CAP.1 — cross-channel marketing frequency cap (COMMS-AUDIT
// 2026-07-10 missing-features item).
//
// One contact could previously get an email campaign + a WhatsApp
// broadcast + a sequence step on the same day: every marketing
// surface gated consent independently but nothing coordinated
// ACROSS channels. This module is the shared brain:
//
//   • The setting lives on locations.settings.comms_frequency_cap
//     ({ enabled, min_hours_between }) — JSONB, no DDL, OFF by
//     default (enabling it silently would block sends operators
//     expect). Operator UI: Settings → Locations → <name> → Details.
//   • The state is contacts.last_marketing_touch_at (mig 399),
//     stamped by every successful MARKETING send — campaigns
//     (campaign-sender.js), WA blasts + drips (whatsapp.js),
//     sequence email/WhatsApp steps (sequences/steps.js) — even
//     while the cap is disabled, so enabling it later has history.
//     Transactional/administrative sends (booking confirmations,
//     event reminders, inbox 1:1 replies, Mia) NEVER stamp.
//   • Enforcement (only when enabled) is per-channel — each send
//     engine decides how to defer/skip using the pure helpers here.
//     The cap check always runs AFTER the channel's consent/hygiene
//     gates: a suppressed contact is excluded anyway and must be
//     neither stamped nor deferred.
//
// Everything except the two IO helpers at the bottom is pure and
// unit-tested in frequency-cap.test.js.

export const FREQUENCY_CAP_MIN_HOURS = 1
export const FREQUENCY_CAP_MAX_HOURS = 168 // one week
export const FREQUENCY_CAP_DEFAULT_HOURS = 24

// Safety valve for campaigns: a queued recipient still cap-deferred
// this long after the campaign started sending is marked
// 'skipped_frequency_cap' so a permanently-capped contact can't hold
// the campaign open forever.
export const CAMPAIGN_CAP_SKIP_AFTER_MS = 7 * 24 * 60 * 60_000

// Sequence deferrals add up-to-this jitter past the window-clear time
// so a cohort capped by the same broadcast doesn't all re-fire on the
// exact same scheduler tick.
export const DEFER_JITTER_MS = 5 * 60_000

/**
 * Normalise the raw JSONB value into { enabled, minHoursBetween }.
 * Anything malformed degrades to disabled + default hours — the cap
 * must fail OPEN (sends proceed) rather than wedge a send engine.
 */
export function normalizeFrequencyCapSetting(raw) {
  const enabled = raw?.enabled === true
  let hours = Number(raw?.min_hours_between)
  if (!Number.isFinite(hours)) hours = FREQUENCY_CAP_DEFAULT_HOURS
  hours = Math.min(FREQUENCY_CAP_MAX_HOURS, Math.max(FREQUENCY_CAP_MIN_HOURS, Math.round(hours)))
  return { enabled, minHoursBetween: hours }
}

/** Convenience: pull + normalise the setting from a locations.settings JSONB. */
export function frequencyCapFromLocationSettings(settings) {
  return normalizeFrequencyCapSetting(settings?.comms_frequency_cap)
}

/**
 * The core decision: is this contact inside the cap window right now?
 * Pure. `setting` is the normalised shape from
 * normalizeFrequencyCapSetting; a disabled setting is never capped.
 *
 * @param {object} contact — needs last_marketing_touch_at
 * @param {{enabled:boolean, minHoursBetween:number}} setting
 * @param {Date} [now]
 */
export function isFrequencyCapped(contact, setting, now = new Date()) {
  if (!setting?.enabled) return false
  const last = contact?.last_marketing_touch_at
  if (!last) return false
  const lastMs = new Date(last).getTime()
  if (!Number.isFinite(lastMs)) return false
  return now.getTime() - lastMs < setting.minHoursBetween * 60 * 60_000
}

/** Milliseconds until the contact's cap window clears (0 when not capped). */
export function capWindowRemainingMs(contact, setting, now = new Date()) {
  if (!isFrequencyCapped(contact, setting, now)) return 0
  const lastMs = new Date(contact.last_marketing_touch_at).getTime()
  return lastMs + setting.minHoursBetween * 60 * 60_000 - now.getTime()
}

/**
 * When a deferred sequence step should re-fire: window remaining plus
 * a small jitter. Returns an ISO string (sequence_enrollments.next_step_at).
 * `jitterMs` is injectable for tests; defaults to random 0..DEFER_JITTER_MS.
 */
export function frequencyCapDeferUntil(contact, setting, now = new Date(), jitterMs = null) {
  const jitter = jitterMs == null ? Math.floor(Math.random() * DEFER_JITTER_MS) : jitterMs
  return new Date(now.getTime() + capWindowRemainingMs(contact, setting, now) + jitter).toISOString()
}

/**
 * The PostgREST cutoff for "not capped": contacts whose
 * last_marketing_touch_at is >= this ISO instant ARE capped. Used by
 * the campaign chunk query's embedded-contact filter
 * (`last_marketing_touch_at.is.null` OR `.lt.<cutoff>`).
 */
export function capCutoffIso(setting, now = new Date()) {
  return new Date(now.getTime() - setting.minHoursBetween * 60 * 60_000).toISOString()
}

/**
 * Sequence-runner control-flow signal: thrown by a send-step handler
 * AFTER its consent/hygiene gates but BEFORE any provider call when
 * the contact is capped. The scheduler catches it specifically and
 * pushes the enrolment's next_step_at to `deferUntil` WITHOUT
 * incrementing error_count and WITHOUT advancing the cursor — the
 * step fires later, it is never skipped. Because it is thrown before
 * the send, a deferral can never leave a sent-but-unadvanced cursor
 * (the 22P02 re-send-loop incident class).
 */
export class FrequencyCapDeferral extends Error {
  constructor(deferUntilIso) {
    super(`Marketing frequency cap — deferred until ${deferUntilIso}`)
    this.name = 'FrequencyCapDeferral'
    this.deferUntil = deferUntilIso
  }
}

// ── IO helpers ────────────────────────────────────────────────────

/**
 * Stamp contacts.last_marketing_touch_at for a batch of contact ids
 * after a successful MARKETING send. Best-effort: a stamp failure must
 * never fail (or retry) the send that already happened — errors are
 * logged and swallowed. Chunked .in() updates (PostgREST URL-length
 * safety on big campaign chunks).
 */
export async function stampMarketingTouch(db, contactIds, nowIso = new Date().toISOString()) {
  const ids = (contactIds || []).filter(Boolean)
  if (ids.length === 0) return
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      // PostgREST failures resolve as { error } (they don't throw) — log
      // those too; the try/catch only covers network-level throws.
      const { error } = await db.from('contacts')
        .update({ last_marketing_touch_at: nowIso })
        .in('id', ids.slice(i, i + CHUNK))
      if (error) console.error('[frequency-cap] marketing-touch stamp failed:', error.message)
    } catch (e) {
      console.error('[frequency-cap] marketing-touch stamp failed:', e?.message || e)
    }
  }
}

/**
 * Resolve a location's normalised cap setting. Missing location /
 * query error degrades to disabled (fail open — see module header).
 */
export async function getLocationFrequencyCap(db, locationId) {
  if (!locationId) return normalizeFrequencyCapSetting(null)
  try {
    const { data } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    return frequencyCapFromLocationSettings(data?.settings)
  } catch (e) {
    console.error('[frequency-cap] setting load failed:', e?.message || e)
    return normalizeFrequencyCapSetting(null)
  }
}
