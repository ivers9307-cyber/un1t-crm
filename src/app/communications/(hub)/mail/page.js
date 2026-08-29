// /communications/mail — THE email surface (MAIL-TRIAL.B; sole surface since
// RETIRE-TICKETS.1).
//
// WHAT THIS IS. Mail began as one half of a head-to-head trial against the
// ticket queue (mig 575's per-mailbox `surface` flag was the switch). The
// trial ended 2026-08-29: Mail won, the queue UI was deleted, and every
// account lists here (mig 578 retired the flag). /communications/tickets
// redirects here for everything that still points at it.
//
// 🔴 WHY THE ROUTE IS /mail AND NOT /inbox. `/communications/inbox` is already
// THE unified inbox — WhatsApp + Instagram in one queue (UIX-P1b) — and its
// page still carries INBOX-SPLIT.1's live `?ch=em` redirect for agent handoff
// notifications and older mobile builds. Taking that path would have deleted a
// working surface and a documented deep link. "Inbox" is also taken as a NAME
// for the same reason: two nav entries called Inbox is worse than a slightly
// duller word, so this one is "Mail" on screen. The `surface` VALUE stays
// 'inbox' — that is the data flag, not the route.
//
// ONE GATE HERE, `email_inbox` — the same key the ticket surface uses, because
// the trial is about how mail is WORKED, not about who may see it. Every
// /api/email/mail route re-checks it (they run on the service-role client, so
// their own checks are the real gate) and each individual account is gated by a
// row in email_mailbox_access on top. Holding the permission with no
// mail-surface mailbox is a normal state and renders an explained empty
// screen, never an error.
//
// NOTE the key is `email_inbox`, NOT the older `email` one — that gates
// marketing/campaign mail and is a different population of people.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import MailSurface from '@/components/mail/MailSurface'

export const dynamic = 'force-dynamic'

export default async function MailPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'email_inbox')) redirect('/communications')

  return (
    <MailSurface
      locationId={user.activeLocation?.id || null}
      locationName={user.activeLocation?.name || null}
      userId={user.id}
    />
  )
}
