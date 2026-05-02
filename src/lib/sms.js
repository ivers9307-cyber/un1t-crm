// SMS broadcast engine. Mirrors src/lib/whatsapp.js#sendBroadcast +
// buildWhatsAppAudience but for freeform SMS over Twilio with the
// per-location alpha sender ID (mig 059 + mig 060).
//
// Two exports:
//   - buildSmsAudience(db, filter, locationId) — returns the audience
//     query (a Supabase builder, ready to await). Filters out
//     opted-out / invalid contacts and contacts with no phone.
//     Applies the user's audience_filter via the whitelisted
//     applyAudienceFilter helper (same shape as email + WA filters).
//   - sendBroadcast(broadcastId) — flips the broadcast to 'sending',
//     resolves the audience, loops sendLocationSms calls, writes
//     per-recipient rows + activities timeline entries, finalises
//     the broadcast status. No template approval step (SMS bodies
//     are freeform).

import { createServerClient } from '@/lib/supabase'
import { applyAudienceFilter } from '@/lib/audience-filter'
import { sendLocationSms, TwilioError } from '@/lib/twilio'
import { applyMergeTags } from '@/lib/postmark'

/**
 * Build a Supabase query for the SMS audience at a location, applying
 * the broadcast's filter on top of the standard send-eligibility
 * gates (active sms_status + has phone + at this location).
 *
 * @param {object} db — Supabase server client (createServerClient()).
 * @param {object|null} filter — { logic, filters: [{field, op, value}] }
 * @param {string} locationId
 * @returns {object} a Supabase query builder. Caller awaits it.
 */
export function buildSmsAudience(db, filter, locationId) {
  let query = db
    .from('contacts')
    .select('id, name, first_name, last_name, email, phone, lead_status, sms_status, location_id')
    .eq('location_id', locationId)
    .eq('sms_status', 'active')
    .not('phone', 'is', null)

  return applyAudienceFilter(query, filter)
}

// Rate limiting — Twilio's published throughput for alpha sender IDs
// in IE/UK is ~10/sec for unverified, higher for verified. Be
// conservative — pause briefly every 25 sends to leave headroom for
// other traffic on the account (deposit links, ad-hoc sends).
const RATE_LIMIT_BATCH = 25
const RATE_LIMIT_PAUSE_MS = 1000

/**
 * Send a broadcast end-to-end. Synchronous from the caller's
 * perspective — mirrors whatsapp.js#sendBroadcast — but the loop
 * yields to setTimeout once per batch so a long send doesn't block
 * the event loop.
 *
 * Idempotency-ish: if called twice on the same broadcast id, the
 * second call short-circuits because the status will already have
 * moved off 'draft'. Recipients are uniquely keyed (broadcast_id,
 * contact_id), so the table-level unique constraint also blocks
 * duplicate per-contact inserts.
 *
 * @param {string} broadcastId
 * @returns {Promise<{ sent: number, failed: number, recipients: number }>}
 */
export async function sendBroadcast(broadcastId) {
  const db = createServerClient()

  // Pull broadcast + the per-location sender ID in one round-trip.
  // sendLocationSms reads location.twilio_alpha_sender_id directly
  // off this object — no second query needed inside the loop.
  const { data: broadcast, error: bErr } = await db
    .from('sms_broadcasts')
    .select('*, locations:location_id(id, name, twilio_alpha_sender_id)')
    .eq('id', broadcastId)
    .single()

  if (bErr || !broadcast) throw new Error('Broadcast not found')
  if (broadcast.status !== 'draft' && broadcast.status !== 'sending') {
    throw new Error(`Broadcast is in '${broadcast.status}' state — only drafts can be sent`)
  }
  if (!broadcast.locations) throw new Error('Broadcast location is missing')

  // Move to 'sending' before iterating so a duplicate POST /send
  // can't kick off two parallel sends.
  await db.from('sms_broadcasts').update({ status: 'sending' }).eq('id', broadcastId)

  // Resolve audience.
  const { data: contacts, error: cErr } = await buildSmsAudience(
    db, broadcast.audience_filter, broadcast.location_id,
  )
  if (cErr) throw new Error(`Audience query failed: ${cErr.message}`)

  if (!contacts?.length) {
    await db.from('sms_broadcasts').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      total_recipients: 0,
      total_sent: 0,
      total_failed: 0,
    }).eq('id', broadcastId)
    return { sent: 0, failed: 0, recipients: 0 }
  }

  let sentCount = 0
  let failedCount = 0

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]

    // Apply merge tags per recipient — same tag set as ad-hoc and
    // email (first_name, name, location_name, etc.).
    const renderedBody = applyMergeTags(broadcast.body, contact, {
      location_name: broadcast.locations?.name || '',
    })

    try {
      const result = await sendLocationSms({
        location: broadcast.locations,
        to: contact.phone,
        body: renderedBody,
      })

      // Per-recipient row. Unique constraint on (broadcast_id,
      // contact_id) means a manual retry of the same broadcast
      // can't double-record. If a send hits a TwilioError mid-loop
      // and we resume, we'd see "duplicate key" — caller decides
      // whether that's a failure or a no-op.
      await db.from('sms_broadcast_recipients').insert({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        twilio_message_sid: result?.sid || null,
        status: 'sent',
        sent_at: new Date().toISOString(),
      })

      // Activity timeline entry on the contact, same shape as the
      // ad-hoc /api/contacts/[id]/sms route. The contact page's
      // activityIcons map already renders 'sms_sent' as a cyan chip.
      await db.from('activities').insert({
        contact_id: contact.id,
        location_id: broadcast.location_id,
        type: 'sms_sent',
        subject: `SMS broadcast: ${broadcast.name}`,
        note: renderedBody,
        created_by: broadcast.created_by,
      })

      sentCount++
    } catch (err) {
      const errMsg = err instanceof TwilioError
        ? `Twilio ${err.code || err.status || ''}: ${err.message}`.trim()
        : (err?.message || 'Unknown send error')

      await db.from('sms_broadcast_recipients').insert({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        status: 'failed',
        error_message: errMsg,
        failed_at: new Date().toISOString(),
      })

      failedCount++
    }

    // Yield to the event loop every batch so a long broadcast
    // doesn't block other requests on this Vercel worker.
    if ((i + 1) % RATE_LIMIT_BATCH === 0 && i + 1 < contacts.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_PAUSE_MS))
    }
  }

  await db.from('sms_broadcasts').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    total_recipients: contacts.length,
    total_sent: sentCount,
    total_failed: failedCount,
  }).eq('id', broadcastId)

  return { sent: sentCount, failed: failedCount, recipients: contacts.length }
}
