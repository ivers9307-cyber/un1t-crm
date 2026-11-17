import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { AssignBodySchema, assignThread, assignPickerFor } from '@/lib/inbox-assignment'

// /api/instagram/conversations/[id]/assign — who owns this thread (INBOXASSIGN.1).
//   GET  → { assigned_to, assignee_name, viewer_id, staff: [{ id, full_name }] }
//   POST { assignee: 'me' | null | <profile id> } → { assigned_to, assignee_name }
//
// The gate is every other Instagram thread route's (INBOX-PERM.1):
// requireInboxPermission(user, 'ig') — which rides the `whatsapp` key, as
// Instagram has none of its own — then membership of the thread's studio
// (404). Who may be NAMED is judged at the thread's studio in
// src/lib/inbox-assignment.js, the same code path as WhatsApp and mail.
// The Instagram agent pages only the owner of an assigned thread.

async function loadGatedThread(user, id) {
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return { response: perm }
  const db = createServerClient()
  const { data: thread, error } = await db.from('instagram_conversations')
    .select('id, location_id, assigned_to')
    .eq('id', id)
    .maybeSingle()
  if (error || !thread) {
    return { response: NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 }) }
  }
  const guard = assertLocationAccessOr404(user, thread.location_id)
  if (guard) return { response: guard }
  return { db, thread }
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const loaded = await loadGatedThread(user, params.id)
  if (loaded.response) return loaded.response
  const out = await assignPickerFor(loaded.db, { channel: 'instagram', user, thread: loaded.thread })
  return NextResponse.json(out.body, { status: out.status })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const pre = requireInboxPermission(user, 'ig')
  if (pre) return pre
  const validation = await validateBody(request, AssignBodySchema)
  if (!validation.ok) return validation.response
  const loaded = await loadGatedThread(user, params.id)
  if (loaded.response) return loaded.response
  const out = await assignThread(loaded.db, {
    channel: 'instagram', user, thread: loaded.thread, assignee: validation.data.assignee,
  })
  return NextResponse.json(out.body, { status: out.status })
}
