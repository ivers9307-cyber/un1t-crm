// POSTMARK-RACE.1 — the correlation marker that makes "is this event OURS?"
// an answerable question instead of an inference from absence.
//
// ── The defect ────────────────────────────────────────────────────────────
// A Postmark Delivery webhook lands 1-2s after the send API returns. Every
// send path here learns its `postmark_message_id` only FROM that return value
// (Postmark mints the id server-side), so the `email_sends` row cannot be
// written until the API call completes — and the campaign path sends a batch
// of up to 500 before it inserts. Measured on prod over 21 days: 3,231 of
// 10,191 Delivery events (32%) were processed BEFORE their email_sends row
// committed. Every single one of them lost its delivery permanently, because
// the processor treated "no row" as success and the queue row was stamped
// processed.
//
// ── Why absence cannot be the test ────────────────────────────────────────
// "No email_sends row" genuinely means two different things, and prod contains
// plenty of both:
//   (a) ours, not committed yet          — 3,231 events / 21d, recoverable
//   (b) never recorded, by design        —   655 events / 21d, correctly ignored
// Category (b) is real traffic: operational alert mail (`cron.health-check`,
// `twilio.balance`, `supabase.advisor-security`, `fleet-health`), host
// campaigns (which keep their own `host_campaign_sends` ledger and deliberately
// write no email_sends row), campaign TEST sends, and any transactional mail
// sent with no contact to attribute it to. Retrying those forever — or minting
// a synthetic row for them — manufactures junk out of legitimate noise.
//
// Inferring (a) vs (b) from the payload does not work either. Measured on the
// same 21 days: 277 of the (b) events carry non-empty Metadata (host campaigns
// and test sends both set some), and 72 of the genuinely-ours events carry
// none. So "has Metadata" is wrong in both directions, and a Tag allowlist
// would need editing every time a new alert cron is written.
//
// ── The marker ────────────────────────────────────────────────────────────
// Postmark echoes the custom `Metadata` object it was sent, verbatim, on every
// webhook record type (verified against 16k stored prod payloads: the key is
// present on 100% of them). So the send paths that DO write an email_sends row
// stamp one extra field, and the processor reads it as a contract:
//
//   marker present  → an email_sends row is coming. Not finding one is a RACE,
//                     not an answer: fail the event so the queue retries it.
//   marker absent   → nothing will ever be written for this message. Drop it,
//                     exactly as today. No retry, no dead-letter, no noise.
//
// The marker is stamped ONLY where the insert is unconditional-on-success —
// which for the transactional/marketing/ticket paths means "only when we have
// a contact_id", since that is precisely the condition those paths already
// gate their email_sends insert on. Getting that pairing wrong in the generous
// direction is the one way this design can hurt: a marker on mail that never
// writes a row would burn the retry budget and dead-letter honest noise.
//
// ── Rollout ───────────────────────────────────────────────────────────────
// Events for mail sent BEFORE this deploys carry no marker and therefore
// behave exactly as they do today (dropped, logged). The fix self-heals as the
// send paths roll forward; there is no backfill dependency and no flag day.

/**
 * Postmark caps metadata at 10 fields, 20 chars per field name, 80 per value,
 * and values are strings. `crm_send` is 8 characters and the value is '1'.
 */
export const SEND_MARKER_KEY = 'crm_send'
export const SEND_MARKER_VALUE = '1'

/**
 * Stamp the marker onto an outgoing Postmark `Metadata` object.
 *
 * Call this at a send site if and only if that site writes an `email_sends`
 * row for the message on success. Existing metadata is preserved.
 *
 * @param {Record<string, string>} [metadata]
 * @returns {Record<string, string>}
 */
export function withSendMarker(metadata = {}) {
  return { ...(metadata || {}), [SEND_MARKER_KEY]: SEND_MARKER_VALUE }
}

/**
 * Does this webhook payload promise us an `email_sends` row?
 *
 * Deliberately strict: only the exact marker value counts. Metadata values
 * arrive from Postmark as strings, but a caller that ever passed a number
 * would otherwise silently opt its mail out of the retry, so the comparison
 * coerces rather than using ===.
 *
 * @param {object} body — raw Postmark webhook payload
 * @returns {boolean}
 */
export function expectsEmailSendRow(body) {
  const metadata = body?.Metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const value = metadata[SEND_MARKER_KEY]
  if (value === null || value === undefined) return false
  return String(value) === SEND_MARKER_VALUE
}

/**
 * The error string a handler returns when the send row it needs is not there
 * YET. `claimAndProcessQueueRow` treats any non-ok result as a failed attempt:
 * the claim is released, attempts++, and both consumers (the QStash worker and
 * the 10-minute sweeper cron) pick the row up again.
 *
 * Bounded by MAX_ATTEMPTS like every other failure, so a marker on mail whose
 * insert genuinely failed ends in webhook_dead_letter rather than a loop —
 * which is the honest outcome: a campaign chunk whose email_sends insert died
 * is a real incident, and the DLQ row is the only artefact that would say so.
 *
 * Sizing: prod's worst observed commit lag over 21 days is 13.2s (p50 8.1s,
 * p95 11.3s, max 13.2s, nothing beyond 60s in 3,231 samples). The sweeper runs
 * every 10 minutes, so attempt 2 clears the window by ~45x even with QStash
 * out of the picture entirely.
 */
export const SEND_ROW_NOT_YET_COMMITTED = 'send_row_not_yet_committed'
