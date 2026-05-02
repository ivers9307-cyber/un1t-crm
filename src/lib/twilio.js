// Twilio SMS client — single helper used by the deposit-link issue
// flow (and any future transactional SMS we add).
//
// Auth: Basic <base64(AccountSid:AuthToken)>. Same creds for sandbox
// vs prod — Twilio doesn't have a sandbox in the same sense as
// Stripe / Revolut. Test numbers exist (e.g. +15005550006) for
// integration testing without sending real messages.
//
// Sender: alphanumeric ID by default ('CCFautos'). 11 chars max.
// Override via TWILIO_FROM env if you switch to a phone number or
// a Messaging Service SID later — Twilio's API treats the From
// param as opaque, so any of those work in the same field.
//
// Refs: https://www.twilio.com/docs/sms/api/message-resource

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01'

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
 * @returns {Promise<{sid: string, status: string, to: string, from: string}>}
 */
export async function sendSms({ to, body, from }) {
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
