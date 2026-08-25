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
 * and values are strings. `crm_send` is 8 characters; the value is the send
 * instant as ms-epoch (13 characters today, 14 until the year 5138).
 */
export const SEND_MARKER_KEY = 'crm_send'

/**
 * POSTMARK-RACE.2 — WHY THE MARKER CARRIES A TIME.
 *
 * The first cut stamped the constant '1', which says only "a row was written".
 * The processor needed a different statement — "a row is COMING" — and read
 * the constant as if it made it. Those come apart the moment a row that was
 * written stops existing, and prod does that routinely:
 *
 *   • `email_sends_contact_id_fkey … ON DELETE CASCADE` (verified on prod via
 *     pg_constraint). Deleting a contact is the estate's GDPR-erasure path
 *     (/api/contacts/bulk-delete, /api/contacts/[id], the import rollback) and
 *     it takes every email_sends row with it.
 *   • Engagement events arrive LONG after the send: over 60 days of prod
 *     Open/Click webhooks land p50 1.9h, p95 6.8 days and max 44.4 days after
 *     email_sends.created_at (n=5,189).
 *
 * So "marked campaign send → contact erased → a late Open arrives" is a
 * reachable sequence in which the row is provably never coming back. A
 * timeless marker sent it round the retry loop five times and dead-lettered it
 * under `postmark_queue` — the deliberately non-replayable provider that stays
 * `pending` until a human deals with it — carrying the error text
 * `send_row_not_yet_committed`, which is a false statement about an event that
 * is correctly unrecordable.
 *
 * The whole measured race window is p95 11.3s / max 13.2s over 3,231 samples,
 * nothing beyond 60s. Anything older than SEND_MARKER_RACE_WINDOW_MS whose row
 * is missing is therefore NOT racing: it is gone, or it was never written. It
 * drops with a warn, exactly like unmarked traffic — the honest outcome for an
 * erased contact, and a distinguishable log line for the other case.
 */
export const SEND_MARKER_RACE_WINDOW_MS = 5 * 60_000

/**
 * Values below this are not send instants — they are a legacy constant marker
 * ('1'), or garbage. Treated as UNKNOWN age rather than as an ancient send, so
 * the age rule can only ever get stricter than the timeless behaviour, never
 * looser: an unreadable marker still defers.
 */
const MIN_PLAUSIBLE_MARKER_MS = Date.UTC(2020, 0, 1)

/**
 * Stamp the marker onto an outgoing Postmark `Metadata` object.
 *
 * Call this at a send site if and only if that site writes an `email_sends`
 * row for the message on success. Existing metadata is preserved.
 *
 * @param {Record<string, string>} [metadata]
 * @param {number} [now] — ms epoch, injectable for tests
 * @returns {Record<string, string>}
 */
export function withSendMarker(metadata = {}, now = Date.now()) {
  return { ...(metadata || {}), [SEND_MARKER_KEY]: String(now) }
}

/**
 * Read the marker off a webhook payload.
 *
 * @param {object} body — raw Postmark webhook payload
 * @returns {{present: boolean, sentAt: number|null}} — `sentAt` is null when
 *   the marker is present but its value is not a plausible send instant.
 */
export function readSendMarker(body) {
  const metadata = body?.Metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { present: false, sentAt: null }
  }
  const raw = metadata[SEND_MARKER_KEY]
  if (raw === null || raw === undefined) return { present: false, sentAt: null }
  // Metadata values arrive from Postmark as strings, but a caller that ever
  // passed a number must not silently opt its mail out of the retry.
  const value = String(raw).trim()
  if (!value) return { present: false, sentAt: null }
  const parsed = Number(value)
  const sentAt = Number.isFinite(parsed) && parsed >= MIN_PLAUSIBLE_MARKER_MS ? parsed : null
  return { present: true, sentAt }
}

/**
 * Does this webhook payload promise us an `email_sends` row RIGHT NOW?
 *
 * True means the only explanation for a missing row is that the insert has not
 * committed yet. A marker older than the race window answers false: the row is
 * not coming, so nothing is gained by retrying and a dead-letter would tell a
 * lie. A marker with no readable instant also answers true — see
 * MIN_PLAUSIBLE_MARKER_MS.
 *
 * A marker stamped in the FUTURE (clock skew between the sending function and
 * the processing one) reads as age <= 0, i.e. inside the window. Deferring is
 * the safe side of that coin.
 *
 * @param {object} body — raw Postmark webhook payload
 * @param {number} [now] — ms epoch, injectable for tests
 * @returns {boolean}
 */
export function expectsEmailSendRow(body, now = Date.now()) {
  const { present, sentAt } = readSendMarker(body)
  if (!present) return false
  if (sentAt === null) return true
  return now - sentAt < SEND_MARKER_RACE_WINDOW_MS
}

/**
 * Age of the marker in ms, or null when it carries no readable instant.
 * Used only to make the drop log line diagnosable.
 *
 * @param {object} body
 * @param {number} [now]
 * @returns {number|null}
 */
export function sendMarkerAgeMs(body, now = Date.now()) {
  const { sentAt } = readSendMarker(body)
  return sentAt === null ? null : now - sentAt
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
 * p95 11.3s, max 13.2s, nothing beyond 60s in 3,231 samples). Recovery is a
 * DELAYED QStash re-publish at +60s (POSTMARK-RACE.2 — see the worker route),
 * ~4.5x the worst lag, with the sweeper cron behind it as the guarantee for
 * when QStash is unavailable.
 */
export const SEND_ROW_NOT_YET_COMMITTED = 'send_row_not_yet_committed'
