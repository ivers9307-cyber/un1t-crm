// HOSTPAGE.2 — post-event ratings: the signed link in the "How was <event>?"
// email, the public summary rule, and the request email's default copy.
//
// The token names ONE registration and ONE event, is HMAC-signed with the
// service-role key (the entry-manage-tokens pattern) and lives 30 days; the
// public rating routes verify it before reading anything and answer 404 on
// every failure. A rating is one per registration (UNIQUE in mig 823).
//
// The public summary appears only once a host has three or more PUBLIC
// ratings (the host can hide one): the average to one decimal, the count,
// and the three newest public comments with a first name only.

import crypto from 'node:crypto'
import { escapeHtml } from '@/lib/event-email'

const KIND = 'event_rating'
const b64url = (input) => Buffer.from(input).toString('base64url')
const hmac = (payload, secret) => b64url(crypto.createHmac('sha256', String(secret)).update(payload).digest())

export const RATING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SKEW_MS = 60 * 1000
export const RATING_SUMMARY_MIN_PUBLIC = 3
export const RATING_SUMMARY_COMMENTS = 3

export function signRatingToken({ registrationId, eventId }, secret, { nowMs = Date.now() } = {}) {
  if (!secret) throw new Error('signRatingToken: no secret')
  if (!registrationId || !eventId) throw new Error('signRatingToken: registration and event ids required')
  const payload = b64url(JSON.stringify({ r: String(registrationId), e: String(eventId), k: KIND, iat: nowMs }))
  return `${payload}.${hmac(payload, secret)}`
}

/** @returns {{ registrationId: string, eventId: string }|null} */
export function verifyRatingToken(token, secret, { nowMs = Date.now(), ttlMs = RATING_TOKEN_TTL_MS } = {}) {
  if (!secret || typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const [payload, sig] = parts
  const a = Buffer.from(sig)
  const b = Buffer.from(hmac(payload, secret))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj || obj.k !== KIND) return null
    if (typeof obj.r !== 'string' || !obj.r || typeof obj.e !== 'string' || !obj.e) return null
    if (typeof obj.iat !== 'number' || !Number.isFinite(obj.iat)) return null
    if (obj.iat > nowMs + SKEW_MS) return null
    if (nowMs - obj.iat > ttlMs) return null
    return { registrationId: obj.r, eventId: obj.e }
  } catch {
    return null
  }
}

/** The customer's rate link on `baseUrl` (the tenant host), or null without a signing secret. */
export function ratingUrl({ registrationId, eventId, baseUrl, nowMs = Date.now() }) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  if (!secret || !registrationId || !eventId || !baseUrl) return null
  return `${String(baseUrl).replace(/\/+$/, '')}/event/rate/${signRatingToken({ registrationId, eventId }, secret, { nowMs })}`
}

/**
 * @param rows event_ratings rows with `rating, comment, is_public, created_at, contact:{ first_name }`
 * @returns {{ average: number, count: number, comments: { rating, comment, author, created_at }[] }|null}
 */
export function ratingSummary(rows, { minPublic = RATING_SUMMARY_MIN_PUBLIC, comments = RATING_SUMMARY_COMMENTS } = {}) {
  const pub = (Array.isArray(rows) ? rows : []).filter((r) => r && r.is_public === true && Number.isFinite(Number(r.rating)))
  if (pub.length < minPublic) return null
  const sum = pub.reduce((n, r) => n + Number(r.rating), 0)
  const withComment = pub
    .filter((r) => typeof r.comment === 'string' && r.comment.trim())
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, comments)
    .map((r) => ({ rating: Number(r.rating), comment: r.comment.trim(), author: String(r.contact?.first_name || '').trim(), created_at: r.created_at }))
  return { average: Number((sum / pub.length).toFixed(1)), count: pub.length, comments: withComment }
}

/** Default copy for the request email; operator copy on race_events overrides subject/intro. */
export function ratingRequestDefaults({ eventName, hostName, rateUrl }) {
  const ev = escapeHtml(eventName || 'the event')
  const host = escapeHtml(hostName || 'the organiser')
  const url = escapeHtml(rateUrl || '')
  return {
    subject: `How was ${eventName || 'the event'}?`,
    heading: eventName || '',
    introHtml: `<p>Thanks for coming to <strong>${ev}</strong>. Would you tell ${host} how it went? It takes ten seconds.</p>`,
    afterInfoHtml: url
      ? `<p style="margin:24px 0;text-align:center;"><a href="${url}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#111111;color:#ffffff;text-decoration:none;font-weight:600;">Rate ${ev}</a></p>`
      : '',
  }
}
