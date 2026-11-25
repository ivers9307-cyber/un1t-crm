import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { z } from 'zod'
import { assertLocationAccessOr404, requireWebWhatsAppInboxAnywhere, requireWebWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { handBackPatch } from '@/lib/inbox-state'

const ToggleSchema = z.object({ active: z.boolean() })

// PATCH /api/whatsapp/conversations/[id]/agent — pause/resume Mia for this
// thread. Mirrors the Instagram sibling's shape but NOT its column: WA's
// agent_active already auto-flips on every staff reply and auto-rearms after
// handoff_cooldown_hours (manualTakeoverPatch in @/lib/agent/core), so it
// can't express an explicit "stay off until I resume". Uses the dedicated
// agent_paused_at timestamp instead (mig 435) — null = Mia active, set = Mia
// paused (sticky). Deliberately does NOT stamp agent_handed_off_at; that's
// IG rearm machinery this route intentionally does not reuse.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, request, params }) => {
  // INBOXWEBONLY3.1 — web only (the phone never calls this), so the WEB
  // `whatsapp` key: coarse pre-check at any studio before the row is read; the
  // decision is requireWebWhatsAppInboxAt at the conversation's studio.
  const perm = requireWebWhatsAppInboxAnywhere(user)
  if (perm) return perm

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
  // INBOXWEBONLY3.1 — the WEB `whatsapp` key judged at THIS studio, not the active one.
  const permHere = requireWebWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  const now = new Date().toISOString()
  const agent_paused_at = active ? null : now

  // INBOXFOLLOW.1 — resuming Mia is a hand-back: the coach's ownership, the
  // hand-off and the wait clocks all clear so she answers the thread again and
  // the queues stop counting it as the coach's.
  const { error: updateError } = await db.from('whatsapp_conversations')
    .update({ agent_paused_at, updated_at: now, ...(active ? handBackPatch() : {}) })
    .eq('id', params.id)
  if (updateError) {
    logError('whatsapp', 'agent state not changed', { conversationId: params.id, code: updateError.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not change the agent state on this conversation. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, agent_paused_at })
})
