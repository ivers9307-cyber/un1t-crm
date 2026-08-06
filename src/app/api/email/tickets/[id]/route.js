import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { loadTicketForUser } from '../_helpers'

// GET /api/email/tickets/[id] — one ticket and its thread (EMAIL-TICKET.4).
//
// 404 — never 403 — for a ticket that does not exist, sits at a location the
// caller cannot reach, OR sits on a mailbox they cannot see. All three are
// the same answer from outside, so an id can't be probed and the set of
// addresses a studio runs can't be enumerated.
//
// Unlike the conversations route this does NOT reset unread_count as a side
// effect of reading: marking read is its own POST (…/read), so opening a
// ticket to look at it is idempotent and a GET stays a GET.

// A ticket thread is short by construction (a long one is a sign it should
// have been split), but fetch newest-first and reverse anyway: ascending +
// limit is what froze the Instagram pane once a thread outgrew the cap.
const MESSAGE_LIMIT = 200

// html_body is deliberately absent — the thread renders text_body today
// (sandboxed HTML rendering is a later plan) and quoted HTML chains run to
// hundreds of KB. bcc_emails is absent too: it is stored for audit only and
// the spec pins "bcc_emails never appears in any client-facing payload".
const MESSAGE_COLUMNS = [
  'id', 'ticket_id', 'conversation_id', 'contact_id', 'location_id', 'direction',
  'from_email', 'to_email', 'cc_emails', 'subject', 'text_body', 'is_internal_note',
  'postmark_message_id', 'rfc_message_id', 'source', 'status', 'sent_at', 'created_at',
].join(', ')

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  if (!hasPermission(user, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket, mailbox } = loaded

  const [{ data: messagesDesc }, { data: contact }] = await Promise.all([
    db.from('email_inbox_messages')
      .select(MESSAGE_COLUMNS)
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_LIMIT),
    ticket.contact_id
      ? db.from('contacts')
        .select('id, name, first_name, email, pipeline_stage_slug')
        .eq('id', ticket.contact_id)
        .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return NextResponse.json({
    success: true,
    data: {
      // `mailbox` is the account this ticket arrived at, resolved through the
      // caller's visible set — so it is safe to render, and it is what the
      // reply goes back out from.
      ticket: { ...ticket, mailbox, contact: contact || null },
      messages: (messagesDesc || []).slice().reverse(),
    },
  })
}
