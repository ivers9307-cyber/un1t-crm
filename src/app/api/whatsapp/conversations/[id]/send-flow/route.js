import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { sendFlowMessage } from '@/lib/whatsapp'

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
  const { data: conversation } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone')
    .eq('id', params.id)
    .maybeSingle()
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  if (!conversation.contact_id) {
    return NextResponse.json(
      { success: false, error: 'Add the sender as a contact first — the Flow books against the linked contact.' },
      { status: 400 }
    )
  }

  const { data: loc } = await db.from('locations').select('settings').eq('id', conversation.location_id).single()
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
      flowId: cfg.flow_id,
      flowToken: `${conversation.contact_id}.${conversation.location_id}`,
      flowCta: cfg.cta_text || undefined,
      bodyText: cfg.invite_text || undefined,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta flow send failed' }, { status: 502 })
  }

  // Best-effort thread row (mirrors whatsapp-carousel-send.js) — a logging
  // failure never fails a send Meta already accepted. wa_message_id lets the
  // status webhooks match the row.
  try {
    await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      location_id: conversation.location_id,
      wa_message_id: sendResult?.messageId || null,
      direction: 'outbound',
      message_type: 'flow',
      body: `[Booking Flow] ${cfg.invite_text || 'Tap below to book your first visit.'}`,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[wa-flow-send] thread row insert failed:', e?.message)
  }

  return NextResponse.json({ success: true })
}
