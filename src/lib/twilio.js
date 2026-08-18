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
 * location that has one. Used as the fallback for an event whose location has
 * no sender (e.g. the per-host anchor location a hosted event sits on) so a
 * UN1T event never falls through to the cross-brand TWILIO_FROM default.
 * Returns null when the org has no configured sender (the caller then keeps the
 * existing global fallback) or on any query error — it never guesses.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {string | null | undefined} organizationId
 * @returns {Promise<string | null>}
 */
export async function getOrgDefaultSenderId(db, organizationId) {
  if (!organizationId) return null
  const { data, error } = await db
    .from('locations')
    .select('twilio_alpha_sender_id, created_at')
    .eq('organization_id', organizationId)
    .not('twilio_alpha_sender_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error || !data?.length) return null
  return data[0].twilio_alpha_sender_id || null
}

/**
 * One-call sender resolution for any SMS attributed to an event's location:
 * keep the location's own sender when it has one (no query), otherwise swap in
 * the location's ORG default sender, otherwise leave it untouched so the
 * global TWILIO_FROM fallback still applies. This is the shared entry point for
 * every event SMS path (race confirmations + the registration payment-link
 * route) so a senderless host-anchor location never texts from the CCF Autos
 * default. Pass the location that already reflects any registry overlay.
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
