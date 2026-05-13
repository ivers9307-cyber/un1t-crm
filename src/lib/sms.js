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
import { getAppUrl } from '@/lib/app-url'

// Build the URL Twilio will POST status updates to. Includes broadcast
// + recipient identifiers as query params so the webhook can locate
// the row in O(1). Phase 5D / mig 065.
function buildStatusCallback(broadcastId, contactId) {
  // getAppUrl() throws if NEXT_PUBLIC_APP_URL is unset — for SMS
  // delivery tracking we treat that as a hard requirement (the
  // callback URL has to be publicly reachable; localhost won't do).
  // Catch + return null so the broadcast still sends; we just lose
  // delivery telemetry.
  try {
    const base = getAppUrl()
    return `${base}/api/webhooks/twilio/status?b=${broadcastId}&c=${contactId}`
  } catch {
    return null
  }
}

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
  // Inner-join contact_preferences so we filter on sms_marketing in
  // the same query (mig 064). Mirrors buildWhatsAppAudience' use of
  // !inner. Contacts without a preferences row are excluded — same
  // semantics as the WA broadcast path; the trigger from mig 005
  // creates a row on every new contact so this only excludes legacy
  // rows that pre-date the preferences table.
  let query = db
    .from('contacts')
    .select('id, name, first_name, last_name, email, phone, pipeline_stage_slug, sms_status, location_id, contact_preferences!inner(sms_marketing)')
    .eq('location_id', locationId)
    .eq('sms_status', 'active')
    .eq('contact_preferences.sms_marketing', true)
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
 * Send a broadcast — chunked + resumable (Phase 5B / mig 060+).
 *
 * The loop processes up to `maxRecipients` contacts per call. If
 * more remain, the broadcast stays in 'sending' state and the next
 * cron tick (or another manual call) picks up where this left off,
 * skipping contacts already in sms_broadcast_recipients via a
 * NOT-IN filter. When the audience is exhausted, the broadcast
 * finalises as 'sent' with the cumulative totals.
 *
 * This makes broadcasts to >500 recipients viable on Vercel without
 * tripping the serverless timeout. Smaller broadcasts (default cap
 * stays generous) finish in one call exactly as before.
 *
 * Idempotency: if the broadcast is already 'sent' or 'cancelled',
 * we throw early. Recipients are uniquely keyed (broadcast_id,
 * contact_id) at the DB level, so a duplicate insert from a
 * concurrent run is rejected by the constraint instead of producing
 * a double-send.
 *
 * @param {string} broadcastId
 * @param {object} [opts]
 * @param {number} [opts.maxRecipients=Infinity]  Cap recipients
 *        processed in this call. Cron passes a small number
 *        (default 200); manual send-now passes Infinity to finish
 *        in one shot when possible.
 * @returns {Promise<{ sent: number, failed: number, recipients: number, remaining: number, status: string }>}
 */
export async function sendBroadcast(broadcastId, { maxRecipients = Infinity } = {}) {
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
  // Allowed entry states:
  //   - draft     : user clicked "Send now" in the UI.
  //   - scheduled : cron picked it up at scheduled_at.
  //   - sending   : an earlier crash left it stuck — let a manual
  //                 retry resume (idempotent at the recipients level
  //                 thanks to the unique (broadcast_id, contact_id)
  //                 constraint).
  if (broadcast.status !== 'draft' && broadcast.status !== 'scheduled' && broadcast.status !== 'sending') {
    throw new Error(`Broadcast is in '${broadcast.status}' state — only draft / scheduled / sending can be sent`)
  }
  if (!broadcast.locations) throw new Error('Broadcast location is missing')

  // Move to 'sending' before iterating so a duplicate POST /send
  // can't kick off two parallel sends. If the broadcast was already
  // 'sending' (resumed from a previous chunk), this is a no-op.
  if (broadcast.status !== 'sending') {
    await db.from('sms_broadcasts').update({ status: 'sending' }).eq('id', broadcastId)
  }

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
    return { sent: 0, failed: 0, recipients: 0, remaining: 0, status: 'sent' }
  }

  // Exclude contacts already processed (sent OR failed) from a
  // previous chunk — the unique (broadcast_id, contact_id)
  // constraint would reject duplicates anyway, but skipping them
  // up-front saves the Twilio call. The recipients table is
  // typically small (only THIS broadcast's rows), so this query
  // is cheap.
  const { data: alreadyDone } = await db
    .from('sms_broadcast_recipients')
    .select('contact_id')
    .eq('broadcast_id', broadcastId)
  const doneSet = new Set((alreadyDone || []).map(r => r.contact_id))
  const remaining = contacts.filter(c => !doneSet.has(c.id))

  // Cap by chunk size. The cap defaults to Infinity for sync
  // send-now; cron passes a small number to share Twilio rate
  // limits with deposit / ad-hoc traffic.
  const chunk = Number.isFinite(maxRecipients)
    ? remaining.slice(0, maxRecipients)
    : remaining

  let sentCount = 0
  let failedCount = 0

  for (let i = 0; i < chunk.length; i++) {
    const contact = chunk[i]

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
        // Phase 5D / mig 065 — Twilio POSTs delivery updates here.
        // Falls back to no-tracking if NEXT_PUBLIC_APP_URL isn't set
        // (e.g. local dev without a tunnel).
        statusCallback: buildStatusCallback(broadcastId, contact.id),
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
    if ((i + 1) % RATE_LIMIT_BATCH === 0 && i + 1 < chunk.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_PAUSE_MS))
    }
  }

  // Recompute totals from the table — the chunk we just processed
  // adds to whatever previous chunks already wrote.
  const { data: allDone } = await db
    .from('sms_broadcast_recipients')
    .select('status')
    .eq('broadcast_id', broadcastId)
  const cumulativeSent = (allDone || []).filter(r => r.status === 'sent').length
  const cumulativeFailed = (allDone || []).filter(r => r.status === 'failed').length

  // Decide finalisation: if we exhausted the audience, mark sent.
  // Otherwise leave in 'sending' for the next tick to continue.
  const stillRemaining = remaining.length - chunk.length
  const isComplete = stillRemaining === 0

  await db.from('sms_broadcasts').update({
    status: isComplete ? 'sent' : 'sending',
    sent_at: isComplete ? new Date().toISOString() : null,
    total_recipients: contacts.length,
    total_sent: cumulativeSent,
    total_failed: cumulativeFailed,
  }).eq('id', broadcastId)

  return {
    sent: sentCount,
    failed: failedCount,
    recipients: contacts.length,
    remaining: stillRemaining,
    status: isComplete ? 'sent' : 'sending',
  }
}
