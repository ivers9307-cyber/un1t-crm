import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { createServerClient } from '@/lib/supabase'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { AssignBodySchema, assignThread, assignPickerFor } from '@/lib/inbox-assignment'

// /api/whatsapp/conversations/[id]/assign — who owns this thread (INBOXASSIGN.1).
//   GET  → { assigned_to, assignee_name, viewer_id, staff: [{ id, full_name }] }
//   POST { assignee: 'me' | null | <profile id> } → { assigned_to, assignee_name }
//
// The gate is the WhatsApp thread routes' own (INBOXLOC.1), spelled out in
// each handler: WhatsApp (web or mobile) at any studio before the read, then
// membership (404) and WhatsApp at the THREAD's studio once the row is read.
// Who may be named, the write and its checks live in
// src/lib/inbox-assignment.js, shared by all three channels. The webhook
// pages only the owner of an assigned thread.

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

async function readThread(db, id) {
  const { data, error } = await db.from('whatsapp_conversations')
    .select('id, location_id, assigned_to')
    .eq('id', id)
    .maybeSingle()
  return error ? null : data
}

export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const db = createServerClient()
  const thread = await readThread(db, params.id)
  if (!thread) return notFound()
  const guard = assertLocationAccessOr404(user, thread.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, thread.location_id)
  if (permHere) return permHere

  const out = await assignPickerFor(db, { channel: 'whatsapp', user, thread })
  return NextResponse.json(out.body, { status: out.status })
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, request, params }) => {
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, AssignBodySchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const thread = await readThread(db, params.id)
  if (!thread) return notFound()
  const guard = assertLocationAccessOr404(user, thread.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, thread.location_id)
  if (permHere) return permHere

  const out = await assignThread(db, { channel: 'whatsapp', user, thread, assignee: validation.data.assignee })
  return NextResponse.json(out.body, { status: out.status })
})
