import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { sendCardSetToConversation } from '@/lib/whatsapp-carousel-send'

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

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'wa')
  if (perm) return perm

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

  // Shared with the agent's send_card_set tool (whatsapp-carousel-send.js):
  // Meta call + best-effort thread row. Staff sends carry no source stamp.
  try {
    await sendCardSetToConversation(db, { set, conversation, locationId: conversation.location_id })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta carousel call failed' }, { status: 502 })
  }

  return NextResponse.json({ success: true })
}
