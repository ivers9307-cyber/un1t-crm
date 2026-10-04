// META-CAPI — Conversions API events for ad attribution, two channels:
//  · business_messaging (CTWA): a click-to-WhatsApp ad's FIRST inbound message
//    carries referral.ctwa_clid (Meta's click id, the gclid analogue). We stamp
//    it on the conversation (always exists) + contact (when known; backfilled
//    on link), fire a Lead event, and fire a Schedule event when a booking
//    lands.
//  · website: the /start + /free-class paid funnels emit Lead (captured) and
//    Schedule (booking confirmed) with SHA-256-hashed email/phone so Meta can
//    optimise the campaign on real bookings instead of clicks. Callers pass a
//    stable event_id (contact- or booking-keyed) so retries dedupe at Meta.
//
// Gated per location by settings.meta_ads.dataset_id (unset → no-op) and sent
// with the location's WhatsApp number token. All entry points swallow errors —
// attribution must never break a webhook or a booking.

import { createHash } from 'crypto'
import { websiteEventToken } from './meta-conversions-settings.js'

export function buildBusinessMessagingEvent({ eventName, ctwaClid, wabaId, eventTime, contentName }) {
  const event = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { ctwa_clid: ctwaClid, ...(wabaId ? { whatsapp_business_account_id: wabaId } : {}) },
  }
  if (contentName) event.custom_data = { content_name: contentName }
  return event
}

/** Stamp ctwa_clid onto a contact if not already set. Returns true when newly set. */
export async function captureCtwaReferral(db, contactId, ctwaClid) {
  const { data: updated } = await db.from('contacts')
    .update({ ctwa_clid: ctwaClid, ctwa_clid_at: new Date().toISOString() })
    .eq('id', contactId)
    .is('ctwa_clid', null)
    .select('id')
  return Boolean(updated?.length)
}

/**
 * Fire a conversion event for a contact's stored (or supplied) ctwa_clid.
 * No-ops cleanly when the contact has no click id, the location has no
 * settings.meta_ads.dataset_id, or the number has no token. Never throws.
 */
export async function sendCtwaConversion(db, { locationId, contactId, eventName, contentName, ctwaClid }) {
  try {
    if (!ctwaClid) {
      if (!contactId) return { sent: false, reason: 'no_contact' }
      const { data: c } = await db.from('contacts').select('ctwa_clid').eq('id', contactId).maybeSingle()
      ctwaClid = c?.ctwa_clid || null
    }
    if (!ctwaClid) return { sent: false, reason: 'no_ctwa_clid' }
    if (!locationId) return { sent: false, reason: 'no_location' }

    const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    const datasetId = loc?.settings?.meta_ads?.dataset_id
    if (!datasetId) return { sent: false, reason: 'no_dataset' }

    const { data: num } = await db.from('whatsapp_numbers')
      .select('access_token, business_account_id')
      .eq('location_id', locationId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    if (!num?.access_token) return { sent: false, reason: 'no_token' }

    const event = buildBusinessMessagingEvent({
      eventName,
      ctwaClid,
      wabaId: num.business_account_id,
      eventTime: Math.floor(Date.now() / 1000),
      contentName,
    })
    const res = await fetch(`https://graph.facebook.com/v21.0/${datasetId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event], access_token: num.access_token }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) {
      console.error('[meta-capi] event send failed:', json.error?.message || `HTTP ${res.status}`)
      return { sent: false, reason: 'api_error' }
    }
    return { sent: true }
  } catch (e) {
    console.error('[meta-capi] conversion failed:', e?.message)
    return { sent: false, reason: 'exception' }
  }
}

// ——— Website events (the /start + /free-class funnels) ———

/** Meta match normalization: trimmed + lowercased; null when not an email. */
export function normalizeEmailForMeta(email) {
  const e = String(email || '').trim().toLowerCase()
  return e.includes('@') ? e : null
}

/**
 * Meta match normalization: digits only with country code — Irish national
 * format (08x…) becomes 3538x…, international 00-prefixes are stripped.
 * Null when too short to be a real number.
 */
export function normalizePhoneForMeta(phone) {
  let d = String(phone || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = `353${d.slice(1)}`
  return d.length >= 8 ? d : null
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * MATCHQUALITY.1 — Meta match normalisation for a name: lower-case, trimmed,
 * punctuation and digits removed (letters, marks and spaces survive, so
 * "Seán O'Brien" → "seán obrien"). Null when nothing is left.
 */
export function normalizeNameForMeta(name) {
  const n = String(name || '').toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, '').replace(/\s+/g, ' ').trim()
  return n || null
}

/**
 * MATCHQUALITY.1 — Meta's browser id cookie value (`_fbp`), read by the form
 * from document.cookie once the Pixel has loaded (consent-gated, so often
 * absent). Sent unhashed. Null for anything but the documented shape.
 */
export function fbpIfValid(fbp) {
  const v = typeof fbp === 'string' ? fbp.trim() : ''
  return /^fb\.1\.\d{6,}\.\d{1,}$/.test(v) && v.length <= 100 ? v : null
}

/**
 * METADATASET.1 — Meta's click id cookie value for an ad click, built from the
 * `fbclid` the landing URL carried: `fb.1.<ms>.<fbclid>`. It is what lets
 * Meta credit a server-side event to the ad that was clicked, and the funnel
 * needs no pixel cookie (and so no cookie consent) to have it. Null for
 * anything that is not a plausible fbclid.
 */
export function fbcFromFbclid(fbclid, nowMs = Date.now()) {
  const v = typeof fbclid === 'string' ? fbclid.trim() : ''
  if (!v || v.length > 500 || !/^[A-Za-z0-9_-]+$/.test(v)) return null
  return `fb.1.${nowMs}.${v}`
}

/**
 * Build a website-channel conversion event with hashed identifiers.
 * Returns null when neither email nor phone normalizes — an event Meta
 * can't match is not worth sending.
 */
export function buildWebsiteEvent({ eventName, eventTime, email, phone, eventSourceUrl, eventId, contentName, fbc, clientIp, userAgent, firstName, lastName, externalId, fbp }) {
  const em = normalizeEmailForMeta(email)
  const ph = normalizePhoneForMeta(phone)
  if (!em && !ph) return null
  const user_data = {}
  if (em) user_data.em = [sha256Hex(em)]
  if (ph) user_data.ph = [sha256Hex(ph)]
  // MATCHQUALITY.1 — more hashed identifiers raise Meta's event match
  // quality, which is what decides how well it can find more people like
  // the ones who convert. Name as given on the form; country inferred only
  // from an Irish-prefixed phone (never guessed otherwise); our contact id
  // as external_id so every later event about the same person joins up.
  const fn = normalizeNameForMeta(firstName)
  const ln = normalizeNameForMeta(lastName)
  if (fn) user_data.fn = [sha256Hex(fn)]
  if (ln) user_data.ln = [sha256Hex(ln)]
  if (ph && ph.startsWith('353')) user_data.country = [sha256Hex('ie')]
  if (typeof externalId === 'string' && externalId.trim()) user_data.external_id = [sha256Hex(externalId.trim())]
  const fbpValue = fbpIfValid(fbp)
  if (fbpValue) user_data.fbp = fbpValue
  // METADATASET.1 — the three things that tie a server event back to the ad
  // click and the browser it came from. All optional and sent as given (Meta
  // does not want these hashed); an event without them is still sent.
  if (typeof fbc === 'string' && fbc) user_data.fbc = fbc
  if (typeof clientIp === 'string' && clientIp && clientIp !== 'unknown') user_data.client_ip_address = clientIp
  if (typeof userAgent === 'string' && userAgent) user_data.client_user_agent = userAgent.slice(0, 512)
  const event = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'website',
    user_data,
  }
  if (eventSourceUrl) event.event_source_url = eventSourceUrl
  if (eventId) event.event_id = eventId
  if (contentName) event.custom_data = { content_name: contentName }
  return event
}

/**
 * Fire a website conversion event for a lead/booking. Same gates as the CTWA
 * path: no dataset_id or no number token → clean no-op. Never throws.
 */
export async function sendWebsiteConversion(db, { locationId, eventName, email, phone, eventSourceUrl, eventId, contentName, fbc, clientIp, userAgent, firstName, lastName, externalId, fbp }) {
  try {
    if (!locationId) return { sent: false, reason: 'no_location' }
    const event = buildWebsiteEvent({
      eventName,
      eventTime: Math.floor(Date.now() / 1000),
      email, phone, eventSourceUrl, eventId, contentName, fbc, clientIp, userAgent,
      firstName, lastName, externalId, fbp,
    })
    if (!event) return { sent: false, reason: 'no_identifiers' }

    const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    const datasetId = loc?.settings?.meta_ads?.dataset_id
    if (!datasetId) return { sent: false, reason: 'no_dataset' }

    // METADATASET.1 — the dataset's own token when the location stores one
    // (a studio whose dataset sits in a different Meta business from any
    // WhatsApp account, or that has no WhatsApp number at all). Otherwise
    // the WhatsApp number token, as before.
    let accessToken = websiteEventToken(loc?.settings, null)
    if (!accessToken) {
      const { data: num } = await db.from('whatsapp_numbers')
        .select('access_token, business_account_id')
        .eq('location_id', locationId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
      accessToken = websiteEventToken(null, num?.access_token)
    }
    if (!accessToken) return { sent: false, reason: 'no_token' }

    const res = await fetch(`https://graph.facebook.com/v21.0/${datasetId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event], access_token: accessToken }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) {
      console.error('[meta-capi] website event send failed:', json.error?.message || `HTTP ${res.status}`)
      return { sent: false, reason: 'api_error' }
    }
    return { sent: true }
  } catch (e) {
    console.error('[meta-capi] website conversion failed:', e?.message)
    return { sent: false, reason: 'exception' }
  }
}

/**
 * Webhook entry point: persist a CTWA click id from an inbound referral (or a
 * conversation backfill) and fire the Lead event exactly once per contact —
 * captureCtwaReferral's stamp-if-null makes Meta webhook retries no-ops.
 * Swallows all errors.
 */
export async function recordCtwaTouch(db, { ctwaClid, conversationId, contact, locationId }) {
  try {
    if (!ctwaClid) return
    if (conversationId) {
      await db.from('whatsapp_conversations')
        .update({ ctwa_clid: ctwaClid })
        .eq('id', conversationId)
        .is('ctwa_clid', null)
    }
    if (contact?.id) {
      const newlySet = await captureCtwaReferral(db, contact.id, ctwaClid)
      if (newlySet) {
        await sendCtwaConversion(db, { locationId, contactId: contact.id, eventName: 'Lead', ctwaClid })
      }
    }
  } catch (e) {
    console.error('[meta-capi] ctwa touch failed:', e?.message)
  }
}
