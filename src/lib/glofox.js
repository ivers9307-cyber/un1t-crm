// Glofox integration helpers (GLOFOX1).
//
// Pure functions — no DB / no fetch — so the receiver route can be
// thin and the tests can be tight. The receiver imports:
//   verifyGlofoxSignature() — HMAC-SHA256 against the operator's
//                             Glofox webhook secret. Constant-time.
//   parseGlofoxEvent()      — pull event_id / event_type / entity_id
//                             / contact_email out of an unfamiliar
//                             payload shape. Defensive — returns
//                             nulls rather than throwing on missing
//                             fields so dark-launch can still record
//                             the event for shape inspection.
//   tagsForGlofoxEvent()    — map a Glofox event_type string to the
//                             list of CRM tags to apply. Single
//                             source of truth — extending the
//                             integration with a new event type is
//                             a one-line change here.

import { createHmac, timingSafeEqual } from 'node:crypto'

// ─────────────────────────────────────────────────────────────
// Signature verification (HMAC-SHA256 hex)
// ─────────────────────────────────────────────────────────────
//
// Per Glofox docs:
//   Signature = Hex( HMAC-SHA256( YourSecretKey, StringToSign ) )
//
// The "StringToSign" is the raw request body (consistent with the
// Twilio/Stripe convention). The signature value arrives in a
// header — Glofox uses 'signature' (lowercase) in their docs.
// We treat it case-insensitively.

export function verifyGlofoxSignature({ rawBody, signatureHeader, secret }) {
  if (!rawBody || !signatureHeader || !secret) return false
  if (typeof rawBody !== 'string' || typeof signatureHeader !== 'string') return false

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Constant-time compare. Length mismatch returns false immediately
  // (timingSafeEqual would throw if buffers differ in length).
  if (expected.length !== signatureHeader.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// Payload parsing
// ─────────────────────────────────────────────────────────────
//
// We don't have official payload samples yet — the operator just
// requested webhook setup, real shapes will land during dark-launch.
// This parser is defensive: it tries the most likely paths for each
// field and returns null when nothing matches. Once we see real
// payloads we tighten the parser without changing the call sites.

const EVENT_ID_PATHS = [
  ['event_id'],
  ['eventId'],
  ['id'],
  ['_id'],
  ['message_id'],
  ['data', 'event_id'],
  ['data', 'id'],
]
const EVENT_TYPE_PATHS = [
  ['event_type'],
  ['eventType'],
  ['type'],
  ['event'],
  ['data', 'event_type'],
]
const BRANCH_ID_PATHS = [
  ['branch_id'],
  ['branchId'],
  ['data', 'branch_id'],
  ['data', 'branchId'],
]
const ENTITY_ID_PATHS = [
  ['data', 'id'],
  ['data', '_id'],
  ['data', 'booking_id'],
  ['data', 'member_id'],
  ['data', 'membership_id'],
  ['entity_id'],
]
// Email lives under different keys depending on the entity:
//   - member.created     → data.email
//   - booking.created    → data.member.email OR data.member_email
//   - membership.cancelled → data.member.email
const CONTACT_EMAIL_PATHS = [
  ['data', 'email'],
  ['data', 'member_email'],
  ['data', 'member', 'email'],
  ['data', 'user', 'email'],
  ['data', 'customer', 'email'],
  ['email'],
]

function pluck(obj, paths) {
  for (const path of paths) {
    let cur = obj
    let ok = true
    for (const key of path) {
      if (cur == null || typeof cur !== 'object') { ok = false; break }
      cur = cur[key]
    }
    if (ok && cur != null && cur !== '') return cur
  }
  return null
}

export function parseGlofoxEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return { eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null }
  }
  const eventId = pluck(payload, EVENT_ID_PATHS)
  const eventType = pluck(payload, EVENT_TYPE_PATHS)
  const branchId = pluck(payload, BRANCH_ID_PATHS)
  const entityId = pluck(payload, ENTITY_ID_PATHS)
  const emailRaw = pluck(payload, CONTACT_EMAIL_PATHS)
  const contactEmail = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : null
  return {
    eventId: eventId != null ? String(eventId) : null,
    eventType: eventType != null ? String(eventType) : null,
    branchId: branchId != null ? String(branchId) : null,
    entityId: entityId != null ? String(entityId) : null,
    contactEmail,
  }
}

// ─────────────────────────────────────────────────────────────
// Event-type → CRM tag map
// ─────────────────────────────────────────────────────────────
//
// Single source of truth for "when Glofox says X, apply tag Y to
// the matching CRM contact." Each tag becomes the trigger for any
// sequence the operator has built with trigger_type='tag_added'
// + trigger_config.tag === '<tag>'.
//
// Tag naming convention: glofox_<entity>_<verb>. Snake_case. Matches
// the codebase's existing contact_tags conventions.
//
// Real Glofox event_type strings will be confirmed during dark-
// launch. The keys below are the most likely Glofox conventions
// (entity.verb, dot-separated lowercase) plus common variations
// (snake_case, hyphenated). Add more keys per actual payload —
// updating this single object surfaces the new event type to every
// downstream sequence template + the audit UI.

const EVENT_TYPE_TAGS = {
  // Bookings
  'booking.created':         ['glofox_booking_created'],
  'booking.cancelled':       ['glofox_booking_cancelled'],
  'booking.canceled':        ['glofox_booking_cancelled'], // US spelling
  'booking.no_show':         ['glofox_booking_no_show'],
  'booking.attended':        ['glofox_booking_attended'],
  'booking.late_cancel':     ['glofox_booking_late_cancel'],
  // Memberships
  'membership.created':      ['glofox_membership_created'],
  'membership.cancelled':    ['glofox_membership_cancelled'],
  'membership.canceled':     ['glofox_membership_cancelled'],
  'membership.ended':        ['glofox_membership_ended'],
  'membership.expired':      ['glofox_membership_ended'],
  'membership.paused':       ['glofox_membership_paused'],
  'membership.unpaused':     ['glofox_membership_unpaused'],
  'membership.renewed':      ['glofox_membership_renewed'],
  // Members (+ leads)
  'member.created':          ['glofox_member_created'],
  'member.updated':          ['glofox_member_updated'],
  'lead.created':            ['glofox_lead_created'],
  // Access (barcodes — not door access)
  'access.created':          ['glofox_access_created'],
  'access.updated':          ['glofox_access_updated'],
}

export function tagsForGlofoxEvent(eventType) {
  if (!eventType) return []
  const direct = EVENT_TYPE_TAGS[eventType]
  if (direct) return direct.slice()
  // Forgiving lookups — try common variations before giving up.
  const lower = eventType.toLowerCase()
  if (EVENT_TYPE_TAGS[lower]) return EVENT_TYPE_TAGS[lower].slice()
  // snake_case → dotted
  const dotted = lower.replace(/_/g, '.')
  if (EVENT_TYPE_TAGS[dotted]) return EVENT_TYPE_TAGS[dotted].slice()
  // hyphenated → dotted
  const fromHyphen = lower.replace(/-/g, '.')
  if (EVENT_TYPE_TAGS[fromHyphen]) return EVENT_TYPE_TAGS[fromHyphen].slice()
  return []
}

// Surface the registry for tests + future admin UI.
export { EVENT_TYPE_TAGS }
