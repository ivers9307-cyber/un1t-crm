import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'

const ToggleSchema = z.object({ active: z.boolean() })

// PATCH /api/instagram/conversations/[id]/agent — toggle the auto-responder
// for this thread. Lets staff hand a conversation BACK to the agent after a
// manual take-over (active:true), or proactively silence it (active:false).
// withAuth only signs the caller in; the channel permission, the body and the
// thread's studio (404) are judged below in their old order.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const validation = await validateBody(request, ToggleSchema)
  if (!validation.ok) return validation.response
  const { active } = validation.data

  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('id, location_id, agent_handed_off_at')
    .eq('id', params?.id)
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
  // on this thread when she had not. The row must exist (it was just selected
  // above), so zero rows matched is itself a failure — and PostgREST reports no
  // error for a zero-row UPDATE. `.select('id')` is how the row count is
  // obtained; see the note at src/app/api/staff/route.js for why it is
  // preferred over `{ count: 'exact' }` on a bodyless PATCH.
  const { error: updateError, data: updated } = await db
    .from('instagram_conversations')
    .update(update)
    .eq('id', conversation.id)
    .select('id')
  if (updateError || !updated?.length) {
    logError('instagram', 'agent state not changed', { conversationId: conversation.id, code: updateError?.code ?? null, rows: updated?.length ?? 0 })
    return NextResponse.json({
      success: false,
      error: 'Could not change the agent state on this conversation. Try again.',
    }, { status: 500 })
  }
  return NextResponse.json({ success: true, agent_active: active })
})
