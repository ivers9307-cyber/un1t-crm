// /communications/tickets — EMAIL-TICKET.4, the operator ticket inbox.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// The email channel is a ticketing system now: a studio runs several inbound
// addresses (accounts@, sales@, …), each separately permissioned, and this is
// where staff work the queue. It eventually replaces the email pane inside the
// unified inbox.
//
// TWO GATES, and this page only owns the first. `email_inbox` gates the
// SURFACE (here, and again on every /api/email/tickets route — those run on
// the service-role client, so their own check is the real gate). A row in
// email_mailbox_access gates each individual ACCOUNT, resolved server-side per
// request. Holding the permission with no mailbox grant is a normal state and
// renders an explained empty inbox, never an error.
//
// NOTE the key is `email_inbox`, NOT the older `email` — that one gates
// marketing/campaign mail and is a different population of people.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import TicketInbox from '@/components/tickets/TicketInbox'

export const dynamic = 'force-dynamic'

export default async function TicketsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'email_inbox')) redirect('/communications')

  return (
    <TicketInbox
      locationId={user.activeLocation?.id || null}
      locationName={user.activeLocation?.name || null}
      userId={user.id}
    />
  )
}
