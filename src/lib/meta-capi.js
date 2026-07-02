// META-CAPI — Conversions API for Business Messaging (CTWA attribution).
// A click-to-WhatsApp ad's FIRST inbound message carries referral.ctwa_clid
// (Meta's click id, the gclid analogue). We stamp it on the conversation
// (always exists) + contact (when known; backfilled on link), fire a Lead
// event, and fire a Schedule event when a booking lands — so Meta optimises
// the ad campaign on real bookings instead of clicks.
//
// Gated per location by settings.meta_ads.dataset_id (unset → no-op) and sent
// with the location's WhatsApp number token. All entry points swallow errors —
// attribution must never break a webhook or a booking.

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
