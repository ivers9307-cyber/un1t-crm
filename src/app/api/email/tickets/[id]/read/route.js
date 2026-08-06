import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { loadTicketForUser } from '../../_helpers'

// POST /api/email/tickets/[id]/read — zero the unread badge
// (EMAIL-TICKET.4).
//
// Its own endpoint rather than a side effect of the detail GET, so opening a
// ticket to read it is an explicit, idempotent action and the GET stays free
// of writes. Same 404 rules as every other ticket route.
//
// updated_at is deliberately NOT bumped: reading a ticket is not a change to
// it, and bumping it would reorder any queue sorted on it.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  if (!hasPermission(user, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const { error } = await db.from('email_tickets')
    .update({ unread_count: 0 })
    .eq('id', ticket.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { unread_count: 0 } })
}
