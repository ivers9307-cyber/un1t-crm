import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { sendFlowMessage } from '@/lib/whatsapp'
import { whatsappErrorStatus } from '@/lib/whatsapp-number-missing'
import { flowTokenFor } from '@/lib/whatsapp-flow/config'
import { logError } from '@/lib/log'

const LOG = 'wa-flow-send'
// Plain words, no em-dashes. Same wording as the inbox send route's.
const TEXT = Object.freeze({
  readFailed: 'Could not load this conversation, so nothing was sent. Try again.',
  settingsReadFailed: "Could not read this studio's booking Flow settings, so nothing was sent. Try again.",
  notLogged: 'Sent to the customer, but it could not be saved to this thread. Do not send it again.',
})

// POST /api/whatsapp/conversations/[id]/send-flow — drop the location's
// booking Flow (settings.whatsapp_flow) into an open conversation as an
// in-session interactive flow message. No template/approval needed inside
// the 24h window; Meta rejects it outside the window like any session
// message (surfaced as the 502). The flow_token is minted as
// <contactId>.<locationId> so the data-exchange endpoint can resolve
// prefill and the booking target — which is why the conversation must be
// linked to a contact before this can be sent. Takes no body.
// Registered in src/lib/openapi.js.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // INBOXLOC.1 — coarse pre-check (WhatsApp at any studio); the decision is
  // requireWhatsAppInboxAt at the conversation's studio, once the row is read.
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const db = createServerClient()
  const { data: conversation, error: convError } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone')
    .eq('id', params.id)
    .maybeSingle()
  // A failed read is never an empty answer: not a 404, a retryable 500.
  if (convError) {
    logError(LOG, 'conversation read failed; nothing sent', { conversationId: params.id, err: convError.message })
    return NextResponse.json({ success: false, error: TEXT.readFailed }, { status: 500 })
  }
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  // INBOXLOC.1 — WhatsApp (web or mobile) judged at THIS studio, not the active one.
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  if (!conversation.contact_id) {
    return NextResponse.json(
      { success: false, error: 'Add the sender as a contact first — the Flow books against the linked contact.' },
      { status: 400 }
    )
  }

  const { data: loc, error: locError } = await db.from('locations').select('settings').eq('id', conversation.location_id).single()
  // Unreadable settings are not "no Flow configured".
  if (locError) {
    logError(LOG, 'location settings read failed; nothing sent', { conversationId: conversation.id, locationId: conversation.location_id, err: locError.message })
    return NextResponse.json({ success: false, error: TEXT.settingsReadFailed }, { status: 500 })
  }
  const cfg = loc?.settings?.whatsapp_flow || {}
  if (!cfg.flow_id) {
    return NextResponse.json({ success: false, error: 'No booking Flow is configured for this location.' }, { status: 400 })
  }

  // No `screen` → data_exchange: Meta calls our INIT endpoint, which returns the
  // class Day screen with live days (classDayScreen). NOTE: the paid-ads TEMPLATE
  // FLOW button still opens via navigate→PATH until it is re-approved as a
  // data_exchange button (see the STARTFLOW.2 republish runbook); this session-send
  // already opens the class Day screen directly.
  let sendResult
  try {
    sendResult = await sendFlowMessage(conversation.wa_phone, {
      locationId: conversation.location_id,
      // WAREPLYNUMBER.1 (C86) — from the number this thread was written to.
      replyInConversation: conversation.id,
      flowId: cfg.flow_id,
      // FLOWTOKENDEDUP.1 — THE token format lives in flowTokenFor. contact_id
      // is checked above, so this is never null here.
      flowToken: flowTokenFor(conversation.contact_id, conversation.location_id),
      flowCta: cfg.cta_text || undefined,
      bodyText: cfg.invite_text || undefined,
    })
  } catch (e) {
    // WACONFIGFALLBACK.1 — a location with no WhatsApp number of its own is a
    // 409 with the resolver's message (it used to send from the env number).
    return NextResponse.json({ success: false, error: e?.message || 'Meta flow send failed' }, { status: whatsappErrorStatus(e, 502) })
  }

  // Meta has accepted the Flow: the customer has it. A lost thread row never
  // fails the request (CLAUDE.md: removing a silent failure must never create
  // a louder one); it is logged structurally and returned as a WARNING so staff
  // don't send it twice. wa_message_id lets the status webhooks match the row.
  const warnings = []
  let insertError = null
  try {
    const { error: err } = await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      location_id: conversation.location_id,
      wa_message_id: sendResult?.messageId || null,
      direction: 'outbound',
      message_type: 'flow',
      body: `[Booking Flow] ${cfg.invite_text || 'Tap below to book your first visit.'}`,
      status: 'sent',
      // CHECKINSTALL.2 (C106 b) — a staff action: sent_by from the SESSION,
      // never the body (UUID REFERENCES profiles, mig 007), same as the send
      // route. Mia's reply path and the check-in runner read sent_by as "a
      // person spoke"; without it this row looked like an automation.
      sent_by: user.id,
      sent_at: new Date().toISOString(),
    })
    insertError = err
  } catch (err) {
    insertError = err
  }
  if (insertError) {
    logError(LOG, 'thread row insert failed after Meta accepted the Flow', {
      conversationId: conversation.id, locationId: conversation.location_id, waMessageId: sendResult?.messageId || null, err: insertError.message,
    })
    warnings.push(TEXT.notLogged)
  }

  return NextResponse.json({ success: true, ...(warnings.length ? { warnings } : {}) })
}
