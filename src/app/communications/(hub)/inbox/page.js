// /communications/inbox — THE unified inbox (UIX-P1b): WhatsApp +
// Instagram in one queue. Deep links: ?c=<conversation_id> selects a
// thread; ?ch=ig marks the channel (default wa, which keeps every
// pre-existing WhatsApp deep link working).
//
// INBOX-SPLIT.1 (Richard, 2026-08-07) — email left this queue for its own
// surface at /communications/mail. ?ch=em was a live deep link (agent
// handoff notifications, saved links, the mobile app's older builds), so
// it REDIRECTS there rather than silently falling back to WhatsApp and
// showing the operator someone else's thread. It cannot carry ?c= across:
// that id is an `email_conversations` row, not an `email_tickets` one, and
// there is no id-preserving mapping — the ticket list is the honest
// landing spot.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { ADMIN_ROLES } from '@/lib/schemas'
import UnifiedInbox from '@/components/UnifiedInbox'

export const dynamic = 'force-dynamic'

export default async function InboxPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Before the whatsapp gate on purpose: someone holding only `email_inbox`
  // must still land on tickets rather than be bounced to /communications.
  if (searchParams?.ch === 'em') redirect('/communications/mail')
  if (!hasPermission(user, 'whatsapp')) redirect('/communications')

  return (
    <UnifiedInbox
      locationId={user.activeLocation?.id}
      userId={user.id}
      initialConversationId={searchParams?.c || null}
      initialChannel={searchParams?.ch === 'ig' ? 'ig' : 'wa'}
      canEditConsent={ADMIN_ROLES.includes(user.role)}
    />
  )
}
