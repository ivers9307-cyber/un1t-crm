// /communications/instagram — operator Instagram DM inbox.
// Mirrors /communications/inbox (WhatsApp). Gated by the same 'whatsapp'
// messaging permission for now (DMs are the same operator capability).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import IGInbox from '@/components/IGInbox'

export const dynamic = 'force-dynamic'

export default async function InstagramInboxPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'whatsapp')) redirect('/communications')

  return (
    <IGInbox
      locationId={user.activeLocation?.id}
      initialConversationId={searchParams?.c || null}
    />
  )
}
