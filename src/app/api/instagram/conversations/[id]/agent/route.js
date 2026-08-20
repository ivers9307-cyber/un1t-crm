import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const ToggleSchema = z.object({ active: z.boolean() })

// PATCH /api/instagram/conversations/[id]/agent — toggle the auto-responder
// for this thread. Lets staff hand a conversation BACK to the agent after a
// manual take-over (active:true), or proactively silence it (active:false).
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const validation = await validateBody(request, ToggleSchema)
  if (!validation.ok) return validation.response
  const { active } = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('id, location_id, agent_handed_off_at')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  const now = new Date().toISOString()
  const update = { agent_active: active, updated_at: now }
  // Stamp the first hand-off only; re-enabling keeps history.
  if (!active && !conversation.agent_handed_off_at) update.agent_handed_off_at = now

  // BAREWRITE.1 — the response echoes the new agent state, so a silently
  // failed write left the operator believing Mia had been paused (or resumed)
  // on this thread when she had not. `count: 'exact'`: the row must exist (it
  // was just selected above), so zero rows matched is itself a failure.
  const { error: updateError, count: updated } = await db
    .from('instagram_conversations')
    .update(update, { count: 'exact' })
    .eq('id', params.id)
  if (updateError || !updated) {
    return NextResponse.json({
      success: false,
      error: `Could not change the agent state on this conversation: ${updateError?.message || 'conversation not found'}`,
    }, { status: 500 })
  }
  return NextResponse.json({ success: true, agent_active: active })
}
