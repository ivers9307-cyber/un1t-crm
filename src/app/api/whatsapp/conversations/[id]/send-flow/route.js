import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { sendFlowMessage } from '@/lib/whatsapp'
import { whatsappErrorStatus } from '@/lib/whatsapp-number-missing'
import { logError } from '@/lib/log'

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

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'wa')
  if (perm) return perm

  const db = createServerClient()
  const { data: conversation, error: convErr } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone')
    .eq('id', params.id)
    .maybeSingle()
  // CHECKINRISKS.1 — a failed read is not "no such conversation".
  if (convErr) {
    logError('wa-flow-send', 'conversation read failed', { conversationId: params.id, err: convErr })
    return NextResponse.json({ success: false, error: 'Could not load the conversation just now.' }, { status: 500 })
  }
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  if (!conversation.contact_id) {
    return NextResponse.json(
      { success: false, error: 'Add the sender as a contact first — the Flow books against the linked contact.' },
      { status: 400 }
    )
  }

  const { data: loc, error: locErr } = await db.from('locations').select('settings').eq('id', conversation.location_id).single()
  // CHECKINRISKS.1 — a failed read is not "no Flow configured".
  if (locErr || !loc) {
    logError('wa-flow-send', 'location settings read failed', { locationId: conversation.location_id, err: locErr || 'no row' })
    return NextResponse.json({ success: false, error: 'Could not load the booking Flow settings just now.' }, { status: 500 })
  }
  const cfg = loc.settings?.whatsapp_flow || {}
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
      flowId: cfg.flow_id,
      flowToken: `${conversation.contact_id}.${conversation.location_id}`,
      flowCta: cfg.cta_text || undefined,
      bodyText: cfg.invite_text || undefined,
    })
  } catch (e) {
    // WACONFIGFALLBACK.1 — a location with no WhatsApp number of its own is a
    // 409 with the resolver's message (it used to send from the env number).
    return NextResponse.json({ success: false, error: e?.message || 'Meta flow send failed' }, { status: whatsappErrorStatus(e, 502) })
  }

  // Best-effort thread row (mirrors whatsapp-carousel-send.js) — a logging
  // failure never fails a send Meta already accepted. wa_message_id lets the
  // status webhooks match the row.
  // CHECKINRISKS.1 (C106 e) — supabase-js RESOLVES with { error } rather than
  // throwing, so the try/catch that used to wrap this never saw a failed
  // insert. The row's sent_by is how Mia and the check-in runner know a person
  // acted, so its loss is logged structurally and reported as a warning; the
  // answer stays success, because a failure would invite a second Flow.
  const { error: rowErr } = await db.from('whatsapp_messages').insert({
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
  if (rowErr) {
    logError('wa-flow-send', 'thread row insert failed; the Flow was sent but is missing from the thread (no sent_by for Mia or the check-in runner)', {
      conversationId: conversation.id, locationId: conversation.location_id, err: rowErr,
    })
    return NextResponse.json({ success: true, warning: 'thread_row_not_recorded' })
  }

  return NextResponse.json({ success: true })
}
