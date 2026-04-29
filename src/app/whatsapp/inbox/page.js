import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import WAInbox from '@/components/WAInbox'

export const dynamic = 'force-dynamic'

export default async function InboxPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <WAInbox
      locationId={user.activeLocation?.id}
      userId={user.id}
      initialConversationId={searchParams?.c || null}
    />
  )
}
