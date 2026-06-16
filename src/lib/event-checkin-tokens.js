// Signed check-in QR tokens (EVENT-CHECKIN.B). The per-attendee QR encodes
// a URL containing one of these tokens; staff scan it with any phone camera,
// which opens the check-in landing page and stamps attendance (the page also
// requires a staff session + location access — the token carries identity,
// not authorisation). Stateless HMAC, no DB column.
//
// Server-only (node:crypto). Kept separate from event-checkins.js so the
// client bundle that imports checkinCounts never pulls in crypto.

import crypto from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

/**
 * @param {{eventId:string, registrationId:string, memberId:string}} ids
 * @param {string} secret
 * @returns {string} `${payload}.${sig}`
 */
export function signCheckinToken({ eventId, registrationId, memberId }, secret) {
  const payload = b64url(JSON.stringify({ e: eventId, r: registrationId, m: memberId }))
  const sig = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * @param {string} token
 * @param {string} secret
 * @returns {{eventId:string, registrationId:string, memberId:string}|null}
 */
export function verifyCheckinToken(token, secret) {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  if (!payload || !sig) return null
  const expected = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || typeof obj !== 'object' || !obj.e || !obj.r || !obj.m) return null
    return { eventId: obj.e, registrationId: obj.r, memberId: obj.m }
  } catch {
    return null
  }
}
