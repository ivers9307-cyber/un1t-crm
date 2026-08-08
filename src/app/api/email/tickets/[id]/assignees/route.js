import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { loadTicketForUser, isElevatedAtLocation } from '../../_helpers'

// GET /api/email/tickets/[id]/assignees — who can this ticket be assigned TO
// (EMAIL-ASSIGN.1). Feeds the elevated reassign picker.
//
// The population mirrors the assign route's assigneeCanSee(): holders of a
// grant on the ticket's mailbox, plus owners at the ticket's location. A
// NULL-mailbox ticket (deleted address) is visible to elevated people only,
// so only owners are offered. Masters are deliberately absent — they are
// global admins, not queue workers, and a picker that lists head office on
// every studio's tickets is noise; a master can still claim.
//
// ELEVATED-ONLY (403): a non-elevated caller has no reassign control, and
// this list enumerates which colleagues hold which mailbox access — the
// per-account model treats that as need-to-know (see the grant editor's
// guardMasterOrOwner gate, #1264). The 403 sits behind loadTicketForUser's
// 404, so it reveals nothing about tickets the caller cannot already see.

const ASSIGNEE_LIMIT = 200

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  if (!isElevatedAtLocation(user, ticket.location_id)) {
    return NextResponse.json({ success: false, error: 'not_elevated' }, { status: 403 })
  }

  const ids = new Set()
  if (ticket.mailbox_id) {
    const { data: grants, error } = await db.from('email_mailbox_access')
      .select('profile_id')
      .eq('mailbox_id', ticket.mailbox_id)
      .limit(ASSIGNEE_LIMIT)
    if (error) return NextResponse.json({ success: false, error: 'assignees_lookup_failed' }, { status: 500 })
    for (const g of grants || []) if (g?.profile_id) ids.add(g.profile_id)
  }
  const { data: owners, error: ownersErr } = await db.from('profile_locations')
    .select('profile_id')
    .eq('location_id', ticket.location_id)
    .eq('role', 'owner')
    .limit(ASSIGNEE_LIMIT)
  if (ownersErr) return NextResponse.json({ success: false, error: 'assignees_lookup_failed' }, { status: 500 })
  for (const o of owners || []) if (o?.profile_id) ids.add(o.profile_id)

  let assignees = []
  if (ids.size > 0) {
    const { data: profiles, error: pErr } = await db.from('profiles')
      .select('id, full_name')
      .in('id', [...ids])
      .limit(ASSIGNEE_LIMIT)
    if (pErr) return NextResponse.json({ success: false, error: 'assignees_lookup_failed' }, { status: 500 })
    assignees = (profiles || []).map(p => ({ id: p.id, full_name: p.full_name || null }))
  }

  return NextResponse.json({ success: true, data: { assignees } })
}
