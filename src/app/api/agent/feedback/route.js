import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

// AGENT-QA.1 — staff rate Mia's replies from the inbox. Upsert per
// (message, rater) so a changed mind just overwrites. The message is
// re-read server-side to confirm it exists, is an agent reply, and
// belongs to a location the caller can access.

const Schema = z.object({
  channel: z.enum(['whatsapp', 'instagram']),
  message_id: z.string().regex(uuidLike),
  rating: z.enum(['up', 'down']),
  note: z.string().max(1000).nullable().optional(),
})

const MESSAGE_TABLES = { whatsapp: 'whatsapp_messages', instagram: 'instagram_messages' }

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const v = await validateBody(request, Schema)
  if (!v.ok) return v.response

  const db = createServerClient()
  const { data: msg } = await db.from(MESSAGE_TABLES[v.data.channel])
    .select('id, conversation_id, location_id, source')
    .eq('id', v.data.message_id)
    .maybeSingle()
  // 404 (not 403) so message ids can't be enumerated.
  if (!msg) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const allowed = getUserLocationIds(user) // null = master
  if (allowed !== null && !allowed.includes(msg.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (msg.source !== 'agent') {
    return NextResponse.json({ success: false, error: 'Only agent replies can be rated' }, { status: 400 })
  }

  const { error } = await db.from('agent_message_feedback').upsert({
    location_id: msg.location_id,
    channel: v.data.channel,
    conversation_id: msg.conversation_id,
    message_id: msg.id,
    rating: v.data.rating,
    note: v.data.note?.trim() || null,
    created_by: user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'message_id,created_by' })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
