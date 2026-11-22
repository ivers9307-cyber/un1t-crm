import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, requireWebWhatsAppInboxAnywhere, requireWebWhatsAppInboxAt } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { AssignBodySchema, assignThread, assignPickerFor } from '@/lib/inbox-assignment'

// /api/instagram/conversations/[id]/assign — who owns this thread (INBOXASSIGN.1).
//   GET  → { assigned_to, assignee_name, viewer_id, staff: [{ id, full_name }] }
//   POST { assignee: 'me' | null | <profile id> } → { assigned_to, assignee_name }
//
// The gate is every other Instagram thread route's (INBOX-PERM.1): the web
// `whatsapp` key (Instagram has none of its own), checked coarsely at any
// studio, then membership of the thread's studio (404), then the key AT the
// thread's studio (SECGAPS.1, the WhatsApp routes' INBOXLOC.1 rule). Who may be NAMED is judged at the thread's studio in
// src/lib/inbox-assignment.js, the same code path as WhatsApp and mail.
// The Instagram agent pages only the owner of an assigned thread.

async function loadGatedThread(db, user, id) {
  const perm = requireWebWhatsAppInboxAnywhere(user)
  if (perm) return { response: perm }
  const { data: thread, error } = await db.from('instagram_conversations')
    .select('id, location_id, assigned_to')
    .eq('id', id)
    .maybeSingle()
  if (error || !thread) {
    return { response: NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 }) }
  }
  const guard = assertLocationAccessOr404(user, thread.location_id)
  if (guard) return { response: guard }
  const permHere = requireWebWhatsAppInboxAt(user, thread.location_id)
  if (permHere) return { response: permHere }
  return { db, thread }
}

// withAuth only signs the caller in; the channel permission and the thread's
// studio (404) are judged below in their old order.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const loaded = await loadGatedThread(db, user, params?.id)
  if (loaded.response) return loaded.response
  const out = await assignPickerFor(loaded.db, { channel: 'instagram', user, thread: loaded.thread })
  return NextResponse.json(out.body, { status: out.status })
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const pre = requireWebWhatsAppInboxAnywhere(user)
  if (pre) return pre
  const validation = await validateBody(request, AssignBodySchema)
  if (!validation.ok) return validation.response
  const loaded = await loadGatedThread(db, user, params?.id)
  if (loaded.response) return loaded.response
  const out = await assignThread(loaded.db, {
    channel: 'instagram', user, thread: loaded.thread, assignee: validation.data.assignee,
  })
  return NextResponse.json(out.body, { status: out.status })
})
