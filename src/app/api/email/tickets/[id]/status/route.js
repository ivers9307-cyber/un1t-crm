import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { EMAIL_TICKET_STATUS_VALUES } from '@/lib/enums'
import { loadTicketForUser, statusTimestamps } from '../../_helpers'

const StatusSchema = z.object({
  // Mirrors the CHECK on email_tickets.status (mig 482) — validated here so a
  // bad value is a 400 with a readable message rather than a Postgres 23514.
  status: z.enum(EMAIL_TICKET_STATUS_VALUES),
})

// POST /api/email/tickets/[id]/status — move a ticket through its lifecycle
// (EMAIL-TICKET.4).
//
//   open    — needs the studio's attention
//   pending — replied, waiting on the member
//   solved  — handled; an inbound reply reopens it
//   closed  — terminal; an inbound reply mints a NEW ticket
//
// NOTHING CLOSES ITSELF. There is no cron, no sweep and no timer anywhere in
// this feature (Richard, 2026-08-06): a ticket ageing out is indistinguishable
// from a ticket being handled, and a queue that silently shrinks is how
// enquiries get lost. This route is the only way a ticket leaves the queue.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  if (!hasPermission(user, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

  const validation = await validateBody(request, StatusSchema)
  if (!validation.ok) return validation.response
  const { status } = validation.data

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const now = new Date().toISOString()
  const { data: updated, error } = await db.from('email_tickets')
    .update({ status, updated_at: now, ...statusTimestamps(status, ticket, now) })
    .eq('id', ticket.id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { ticket: updated } })
}
