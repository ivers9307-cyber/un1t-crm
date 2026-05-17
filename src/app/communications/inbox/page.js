// /communications/inbox — WhatsApp conversations.
// Was /whatsapp/inbox. Same component, new home.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import WAInbox from '@/components/WAInbox'

export const dynamic = 'force-dynamic'

export default async function InboxPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'whatsapp')) redirect('/communications')

  return (
    <WAInbox
      locationId={user.activeLocation?.id}
      userId={user.id}
      initialConversationId={searchParams?.c || null}
    />
  )
}
