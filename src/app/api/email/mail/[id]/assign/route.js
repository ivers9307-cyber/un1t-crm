import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { AssignBodySchema, assignThread, assignPickerFor } from '@/lib/inbox-assignment'
import { loadConversationForUser } from '../../_conversation'

// /api/email/mail/[id]/assign — who owns this conversation (INBOXASSIGN.1;
// the ticket-era EMAIL-ASSIGN.1 routes were deleted with the ticket queue in
// RETIRE-TICKETS.2, and Mail never had a replacement).
//   GET  → { assigned_to, assignee_name, viewer_id, staff: [{ id, full_name }] }
//   POST { assignee: 'me' | null | <profile id> } → { assigned_to, assignee_name }
//
// The gate is every Mail detail route's: loadConversationForUser — studio
// membership, `email_inbox` at the CONVERSATION'S studio and sight of its
// mailbox, every refusal a 404. A merged-away conversation is a tombstone and
// takes no owner (409, like a send). The inbound-mail push pages only the
// owner of an assigned conversation (EMAIL-PUSH-ASSIGNEE.1).

function mergedAway() {
  return NextResponse.json({
    success: false,
    error: 'This conversation was merged into another one. Assign the conversation it was merged into.',
  }, { status: 409 })
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const loaded = await loadConversationForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const out = await assignPickerFor(db, { channel: 'mail', user, thread: loaded.conversation })
  return NextResponse.json(out.body, { status: out.status })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const validation = await validateBody(request, AssignBodySchema)
  if (!validation.ok) return validation.response
  const db = createServerClient()
  const loaded = await loadConversationForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  if (loaded.conversation.merged_into_id) return mergedAway()
  const out = await assignThread(db, {
    channel: 'mail', user, thread: loaded.conversation, assignee: validation.data.assignee,
  })
  return NextResponse.json(out.body, { status: out.status })
}
