// /communications/sms/broadcasts/[id] — edit / view a single SMS
// broadcast. Loads the row + recipients then hands off to
// SMSBroadcastEditor which handles the draft / sending / sent UI
// states.

import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import SMSBroadcastEditor from '@/components/SMSBroadcastEditor'

export const dynamic = 'force-dynamic'

export default async function SmsBroadcastDetailPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'sms')) redirect('/communications')

  const db = createServerClient()
  const { data: broadcast } = await db
    .from('sms_broadcasts')
    .select('*, locations:location_id(id, name, twilio_alpha_sender_id)')
    .eq('id', params.id)
    .single()

  if (!broadcast) notFound()

  // IDOR — same pattern as the API. The page-level RLS would also
  // block this but we surface a friendly 403 instead of an empty
  // result.
  const guard = assertLocationAccess(user, broadcast.location_id)
  if (guard) redirect('/communications/sms/broadcasts')

  const { data: recipients } = await db
    .from('sms_broadcast_recipients')
    .select('id, contact_id, status, twilio_message_sid, error_message, sent_at, failed_at')
    .eq('broadcast_id', params.id)
    .order('created_at', { ascending: false })
    .limit(500)

  return (
    <SMSBroadcastEditor
      broadcast={broadcast}
      recipients={recipients || []}
      locationId={broadcast.location_id}
      locationSenderId={broadcast.locations?.twilio_alpha_sender_id}
      userId={user.id}
    />
  )
}
