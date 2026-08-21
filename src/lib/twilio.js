// Twilio SMS client.
//
// Three send paths:
//   - sendSms({ to, body, from? })       — low-level. Used by the
//     car-deposit transactional flow which has its own context for
//     the From slot. Defaults `from` to TWILIO_FROM env (or the
//     'CCFautos' literal). DO NOT add new callers to this — prefer
//     sendLocationSms for anything tied to a location.
//   - sendLocationSms({ location, to, body }) — preferred. Resolves
//     the From slot from `location.twilio_alpha_sender_id` (mig 059),
//     falling back to TWILIO_FROM env when the per-location field
//     is null. Every multi-location surface (ad-hoc, broadcasts,
//     sequences, automations) goes through here.
//   - getLocationSenderId(location)     — pure. Useful for previewing
//     in the UI which sender will be used before sending.
//
// Auth: Basic <base64(AccountSid:AuthToken)>. Same creds for sandbox
// vs prod — Twilio doesn't have a sandbox in the same sense as
// Stripe / Revolut. Test numbers exist (e.g. +15005550006) for
// integration testing without sending real messages.
//
// Sender format: alphanumeric ID (e.g. 'UN1T'), full E.164 number
// (e.g. '+35315550000'), or a Messaging Service SID ('MGxxx...').
// Twilio's API treats the From param as opaque, so any of those
// work in the same field. Alpha sender IDs are 11 chars max —
// letters, numbers and spaces, with at least one letter — validated
// app-side at the Location Settings edit form.
//
// Refs: https://www.twilio.com/docs/sms/api/message-resource

import { overlayConnectionsMany } from '@/lib/connection-registry'

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01'

// Last-resort sender used when neither the per-location field nor
// the env var is set. Kept in sync with the original deposit-flow
// default so an unconfigured environment still sends from a
// recognisable string.
const FALLBACK_SENDER = 'CCFautos'

function getConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  // Sender — alphanumeric ID (e.g. 'CCFautos'), full E.164 number
  // (e.g. '+35315550000'), or a Messaging Service SID ('MGxxx...').
  // Twilio infers which from the value's shape.
  const from = process.env.TWILIO_FROM || 'CCFautos'
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN ' +
      'in your environment. Optional: TWILIO_FROM (defaults to alphanumeric ' +
      "sender 'CCFautos')."
    )
  }
  return { accountSid, authToken, from }
}

export class TwilioError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'TwilioError'
    this.status = status
    this.code = code
  }
}

/**
 * Normalise an Irish phone number to E.164 (+353…). Best-effort —
 * if the input doesn't look like an Irish number, returns it
 * unchanged so Twilio gets a chance to reject explicitly.
 *
 *   '0871234567'    → '+353871234567'
 *   '+353871234567' → '+353871234567'  (unchanged)
 *   '353871234567'  → '+353871234567'
 *   '871234567'     → '+353871234567'
 *
 * @param {string} raw
 * @returns {string}
 */
export function toE164Ireland(raw) {
  if (!raw) return raw
  const digits = String(raw).replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  if (digits.startsWith('00')) return '+' + digits.slice(2)
  if (digits.startsWith('353')) return '+' + digits
  if (digits.startsWith('0')) return '+353' + digits.slice(1)
  // Bare mobile prefix without leading 0 (e.g. just '87…' or '85…')
  if (/^[1-9]\d{7,8}$/.test(digits)) return '+353' + digits
  return digits
}

/**
 * Send a single SMS message via Twilio.
 *
 * @param {object} args
 * @param {string} args.to    — destination phone (any reasonable format; normalised to E.164)
 * @param {string} args.body  — message body. Keep < 160 chars to stay in one segment.
 * @param {string} [args.from] — override sender. Defaults to TWILIO_FROM env.
 * @param {string} [args.statusCallback] — public URL Twilio POSTs to as
 *        the message lifecycle progresses (queued → sent → delivered /
 *        undelivered / failed). Used by broadcasts to populate the
 *        delivery analytics (mig 065). Optional — sends without a
 *        callback still succeed; we just don't get carrier-side updates.
 * @returns {Promise<{sid: string, status: string, to: string, from: string}>}
 */
export async function sendSms({ to, body, from, statusCallback }) {
  if (!to) throw new TwilioError('sendSms: `to` is required', 400)
  if (!body) throw new TwilioError('sendSms: `body` is required', 400)

  const { accountSid, authToken, from: defaultFrom } = getConfig()
  const sender = from || defaultFrom
  const normalisedTo = toE164Ireland(to)

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const params = new URLSearchParams()
  params.set('To', normalisedTo)
  params.set('From', sender)
  params.set('Body', body)
  if (statusCallback) {
    // Twilio POSTs to this URL with form-encoded MessageSid +
    // MessageStatus + (on failure) ErrorCode / ErrorMessage. See
    // /api/webhooks/twilio/status for the receiving end.
    params.set('StatusCallback', statusCallback)
  }

  const res = await fetch(`${TWILIO_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  })

  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}

  if (!res.ok) {
    // Twilio error shape: { code, message, more_info, status }
    throw new TwilioError(
      json?.message || `Twilio API ${res.status}`,
      res.status,
      json?.code
    )
  }

  return {
    sid: json?.sid,
    status: json?.status,
    to: json?.to,
    from: json?.from,
  }
}

/**
 * Resolve which sender ID to use for a given location.
 *
 * Priority:
 *   1. location.twilio_alpha_sender_id (mig 059) — the per-location
 *      override set in Location Settings.
 *   2. process.env.TWILIO_FROM — the global default. Honoured for
 *      backwards compat with the original deposit flow.
 *   3. 'CCFautos' literal — last-resort fallback so an unconfigured
 *      dev environment still sends from a recognisable string.
 *
 * Pure — no side effects, safe to call from UI code.
 *
 * @param {{ twilio_alpha_sender_id?: string | null } | null | undefined} location
 * @returns {string}
 */
export function getLocationSenderId(location) {
  if (location?.twilio_alpha_sender_id) return location.twilio_alpha_sender_id
  if (process.env.TWILIO_FROM) return process.env.TWILIO_FROM
  return FALLBACK_SENDER
}

/**
 * Apply an org-level fallback sender to a location that has none of its own.
 *
 * Pure. Returns the location unchanged when it already has a
 * `twilio_alpha_sender_id`, or when there is no `orgSenderId` to apply. When
 * the location has no sender AND an org sender is supplied, returns a shallow
 * copy carrying that sender so getLocationSenderId resolves to it — instead of
 * falling through to the cross-brand TWILIO_FROM / FALLBACK_SENDER default.
 *
 * The motivating case: hosted events live on a per-host ANCHOR location that
 * has no sender, so their confirmation SMS was resolving to the CCF Autos
 * default. See getOrgDefaultSenderId + race-confirmations.js.
 *
 * @param {{ twilio_alpha_sender_id?: string | null } | null | undefined} location
 * @param {string | null | undefined} orgSenderId
 * @returns {typeof location}
 */
export function effectiveSenderLocation(location, orgSenderId) {
  if (!location) return location
  if (location.twilio_alpha_sender_id) return location
  if (!orgSenderId) return location
  return { ...location, twilio_alpha_sender_id: orgSenderId }
}

/**
 * Resolve an organization's own default SMS sender — the sender of its oldest
 * location that has one, AND whether the question could be answered at all.
 *
 * "No sender configured" and "the query failed" are different facts and must
 * not collapse: the first is an operator to-do ("set one in Location
 * Settings"), the second is a transient blip that the same advice cannot fix.
 * Folding them together produced an operator-facing error that was simply
 * false, and — on the unattended race-confirmation leg — a permanent skip on
 * a path that never retries.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {string | null | undefined} organizationId
 * @returns {Promise<{ senderId: string|null, unreadable: boolean }>}
 */
export async function getOrgDefaultSender(db, organizationId) {
  if (!organizationId) return { senderId: null, unreadable: false }
  // REGISTRY-AWARE (SENDER-REGISTRY.1). This used to filter in Postgres with
  // `.not('twilio_alpha_sender_id','is',null).limit(1)` — i.e. it asked the
  // LEGACY column only, while every actual send resolves its sender through
  // `overlayConnections(…, ['twilio_sender'])`, which prefers the
  // channel_connections registry row. Today mig 419's backfill keeps the two in
  // lockstep so nothing diverges; the moment senders go registry-primary (a
  // location configured only in `channel_connections`, legacy column null) this
  // function would find NOTHING, return null, and every org-fallback send would
  // drop to the global default. That default is another business's sender.
  //
  // So: fetch the org's locations, overlay the registry the same way the send
  // path does, THEN pick the oldest one that has a sender. Ordering is
  // preserved by overlayConnectionsMany (it maps over the list it is given).
  // The `.limit()` is a sanity bound, not a filter — an organisation with more
  // than 200 locations has bigger problems than sender resolution.
  const { data, error } = await db
    .from('locations')
    .select('id, twilio_alpha_sender_id, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) return { senderId: null, unreadable: true }
  if (!data?.length) return { senderId: null, unreadable: false }
  const overlaid = await overlayConnectionsMany(db, data, ['twilio_sender'])
  for (const loc of overlaid || []) {
    if (loc?.twilio_alpha_sender_id) return { senderId: loc.twilio_alpha_sender_id, unreadable: false }
  }
  return { senderId: null, unreadable: false }
}

/**
 * Back-compat wrapper for callers that only want the id and cannot act on the
 * difference. Prefer `getOrgDefaultSender` on any path where "we could not
 * read it" and "it is not set" lead to different behaviour or different copy.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string | null | undefined} organizationId
 * @returns {Promise<string | null>}
 */
export async function getOrgDefaultSenderId(db, organizationId) {
  const { senderId } = await getOrgDefaultSender(db, organizationId)
  return senderId
}

/**
 * Sender resolution for a TENANT-BRANDED path (every event send), with the
 * global fallback REFUSED rather than taken.
 *
 * `getLocationSenderId` ends in `process.env.TWILIO_FROM || 'CCFautos'`. That
 * terminal literal is CCF Autos — a SEPARATE BUSINESS in this estate, not a
 * neutral default — so a UN1T gym event whose location and org both lack a
 * sender texts a paying attendee under a used-car dealership's name. The
 * attendee cannot tell that from a scam, and it is not recoverable after the
 * fact. The env var is no better: it is one global string shared by every
 * tenant, so it can only ever be right for one of them.
 *
 * This returns WHERE the sender came from so the caller can decide, instead of
 * discovering the wrong brand only in the customer's inbox:
 *
 *   source: 'location'   — the location's own sender (registry or legacy)
 *   source: 'org'        — the org's default, applied to a senderless location
 *   source: 'none'       — NOTHING tenant-scoped is configured. The caller must
 *                          NOT send: `getLocationSenderId` would fall through.
 *   source: 'unreadable' — the org lookup FAILED. Also do not send, for the
 *                          same reason — but say something different, because
 *                          "set one in Location Settings" is false advice when
 *                          the sender may well already be set. Collapsing this
 *                          into 'none' is what made the operator-facing 409 lie.
 *
 * Deliberately NOT a hard failure inside this function — see CLAUDE.md, a guard
 * that fails closed can cost more than the thing it prevents. Each caller
 * weighs its own trade: the operator-driven payment-link route refuses with an
 * actionable message (the human is right there and the link is one click from
 * the clipboard), while the race-confirmation SMS leg skips-with-reason and
 * lets the EMAIL receipt — which carries the check-in QR — go out untouched.
 *
 * Measured read-only against prod 2026-08-20: every location that hosts an
 * event resolves at 'location', and the one senderless UN1T location resolves
 * at 'org'. No event in prod today would be refused by this.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ twilio_alpha_sender_id?: string|null, organization_id?: string|null }|null|undefined} location
 * @returns {Promise<{ location: object|null, senderId: string|null, source: 'location'|'org'|'none'|'unreadable' }>}
 */
export async function resolveTenantSmsSender(db, location) {
  if (!location) return { location: null, senderId: null, source: 'none' }
  if (location.twilio_alpha_sender_id) {
    return { location, senderId: location.twilio_alpha_sender_id, source: 'location' }
  }
  if (!location.organization_id) return { location, senderId: null, source: 'none' }
  const { senderId: orgSenderId, unreadable } = await getOrgDefaultSender(db, location.organization_id)
  if (unreadable) return { location, senderId: null, source: 'unreadable' }
  if (!orgSenderId) return { location, senderId: null, source: 'none' }
  return { location: effectiveSenderLocation(location, orgSenderId), senderId: orgSenderId, source: 'org' }
}

/**
 * One-call sender resolution for any SMS attributed to an event's location:
 * keep the location's own sender when it has one (no query), otherwise swap in
 * the location's ORG default sender, otherwise leave it untouched so the
 * global TWILIO_FROM fallback still applies. Pass the location that already
 * reflects any registry overlay.
 *
 * NOT FOR EVENT PATHS ANY MORE. "leave it untouched so the global fallback
 * applies" is exactly the hole SENDER-REGISTRY.1 closed: the global fallback is
 * another business's sender. Event sends use `resolveTenantSmsSender` below,
 * which reports `source: 'none'` instead of silently handing the caller a
 * location that will resolve to `CCFautos`. Kept for any non-event caller that
 * genuinely wants the legacy behaviour.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ twilio_alpha_sender_id?: string | null, organization_id?: string | null } | null | undefined} location
 * @returns {Promise<typeof location>}
 */
export async function resolveSenderLocation(db, location) {
  if (!location || location.twilio_alpha_sender_id || !location.organization_id) return location
  const orgSenderId = await getOrgDefaultSenderId(db, location.organization_id)
  return effectiveSenderLocation(location, orgSenderId)
}

/**
 * Validate an alpha sender ID before persisting. Twilio's rules
 * (https://www.twilio.com/docs/glossary/what-alphanumeric-sender-id):
 * 1-11 characters; letters, numbers AND spaces are allowed; must
 * contain at least one letter (an all-number ID looks like a phone
 * number and is rejected). We additionally disallow leading/trailing
 * spaces. (Twilio also permits `- + _ &`, but we keep the set to
 * alphanumerics + space — the common case — and reject other
 * punctuation rather than guess per-country support.) Returns null if
 * valid, or a short human message naming the problem.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function validateAlphaSenderId(value) {
  if (typeof value !== 'string') return 'Sender ID must be a string'
  if (value.length === 0) return 'Sender ID cannot be empty'
  if (value.length > 11) return 'Sender ID cannot exceed 11 characters'
  if (value !== value.trim()) return 'Sender ID cannot start or end with a space'
  if (!/^[A-Za-z0-9 ]+$/.test(value)) return 'Sender ID can only contain letters, numbers and spaces'
  if (!/[A-Za-z]/.test(value)) return 'Sender ID must contain at least one letter'
  return null
}

/**
 * Send an SMS attributed to a specific location. Uses the per-
 * location alpha sender ID if set, falls back to env / FALLBACK_SENDER.
 *
 * Every multi-location SMS surface (ad-hoc, broadcasts, sequences,
 * automations) should go through here so per-location branding is
 * consistent.
 *
 * @param {object} args
 * @param {{ twilio_alpha_sender_id?: string | null } | null} args.location  Full location row (or at least the sender field).
 * @param {string} args.to    — destination phone (any reasonable format; normalised to E.164).
 * @param {string} args.body  — message body. Keep < 160 chars to stay in one segment.
 * @param {string} [args.statusCallback] — public URL Twilio POSTs to with
 *        delivery lifecycle updates. Broadcasts pass one keyed by
 *        broadcast_id + recipient_id so the webhook can locate the row;
 *        ad-hoc / sequence / event-reminder sends omit it (they don't
 *        have a recipient row to update).
 * @returns {Promise<{sid: string, status: string, to: string, from: string}>}
 */
export async function sendLocationSms({ location, to, body, statusCallback }) {
  const from = getLocationSenderId(location)
  return sendSms({ to, body, from, statusCallback })
}
