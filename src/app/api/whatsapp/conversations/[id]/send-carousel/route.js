import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { sendMediaCarousel } from '@/lib/whatsapp'

const SendCarouselSchema = z.object({ card_set_id: uuidLike })

// POST /api/whatsapp/conversations/[id]/send-carousel — send one of the
// location's curated card sets (locations.settings.wa_card_sets) as an
// in-session interactive media carousel. 24h window only — Meta rejects it
// outside the window like any session message (surfaced as the 502). Then
// best-effort log a thread row so the send is visible in the inbox.
// Registered in src/lib/openapi.js.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SendCarouselSchema)
  if (!validation.ok) return validation.response
  const { card_set_id } = validation.data

  const db = createServerClient()
  const { data: conversation } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone')
    .eq('id', params.id)
    .maybeSingle()
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  const { data: loc } = await db.from('locations').select('settings').eq('id', conversation.location_id).single()
  const sets = Array.isArray(loc?.settings?.wa_card_sets) ? loc.settings.wa_card_sets : []
  const set = sets.find((s) => s.id === card_set_id)
  if (!set) return NextResponse.json({ success: false, error: 'Card set not found' }, { status: 404 })

  let sendResult
  try {
    sendResult = await sendMediaCarousel(
      conversation.wa_phone,
      { bodyText: set.body_text || set.name, cards: set.cards },
      { locationId: conversation.location_id }
    )
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta carousel call failed' }, { status: 502 })
  }

  // Best-effort thread row — a logging failure never fails the send.
  // wa_message_id lets the carousel's status webhooks match the row.
  try {
    await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id || null,
      location_id: conversation.location_id,
      wa_message_id: sendResult?.messageId || null,
      direction: 'outbound',
      message_type: 'carousel',
      body: `[Card set: ${set.name}]`,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
  } catch (e) { console.error('[wa-carousel] thread row insert failed:', e?.message) }

  return NextResponse.json({ success: true })
}
