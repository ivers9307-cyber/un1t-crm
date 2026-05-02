// /communications/sms/broadcasts/new — composer for a new SMS
// broadcast. Renders the SMSBroadcastEditor with no `broadcast`
// prop so it bootstraps as a fresh draft. On first save the URL is
// rewritten to /communications/sms/broadcasts/[id] so the user can
// keep editing under a stable route.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import SMSBroadcastEditor from '@/components/SMSBroadcastEditor'

export const dynamic = 'force-dynamic'

export default async function NewSmsBroadcastPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'sms')) redirect('/communications')

  return (
    <SMSBroadcastEditor
      locationId={user.activeLocation?.id}
      locationSenderId={user.activeLocation?.twilio_alpha_sender_id}
      userId={user.id}
    />
  )
}
