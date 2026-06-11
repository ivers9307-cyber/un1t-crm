// /communications/inbox — THE unified inbox (UIX-P1b): WhatsApp +
// Instagram in one queue. Deep links: ?c=<conversation_id> selects a
// thread; ?ch=ig marks it as an Instagram conversation (default wa,
// which keeps every pre-existing WhatsApp deep link working).

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
