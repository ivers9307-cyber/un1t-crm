import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const ToggleSchema = z.object({ active: z.boolean() })

// PATCH /api/whatsapp/conversations/[id]/agent — pause/resume Mia for this
// thread. Mirrors the Instagram sibling's shape but NOT its column: WA's
// agent_active already auto-flips on every staff reply and auto-rearms after
// handoff_cooldown_hours (manualTakeoverPatch in @/lib/agent/core), so it
// can't express an explicit "stay off until I resume". Uses the dedicated
// agent_paused_at timestamp instead (mig 435) — null = Mia active, set = Mia
// paused (sticky). Deliberately does NOT stamp agent_handed_off_at; that's
// IG rearm machinery this route intentionally does not reuse.
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ToggleSchema)
  if (!validation.ok) return validation.response
  const { active } = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  const now = new Date().toISOString()
  const agent_paused_at = active ? null : now

  await db.from('whatsapp_conversations')
    .update({ agent_paused_at, updated_at: now })
    .eq('id', params.id)

  return NextResponse.json({ success: true, agent_paused_at })
}
