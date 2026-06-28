import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import WABroadcastEditor from '@/components/WABroadcastEditor'

export const dynamic = 'force-dynamic'

export default async function EditBroadcastPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: broadcast } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', params.id)
    .single()

  if (!broadcast) notFound()

  const { data: templates } = await db.from('whatsapp_templates')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .eq('status', 'APPROVED')
    .order('name')

  // Failed recipients — fetched separately (the embed above is capped at 1000
  // rows for a large drip). Name · number · failure reason, newest first.
  const { data: failedRecipients } = await db.from('whatsapp_broadcast_recipients')
    .select('id, error_message, failed_at, contacts(name, wa_phone, phone)')
    .eq('broadcast_id', params.id)
    .eq('status', 'failed')
    .order('failed_at', { ascending: false })
    .limit(200)
  const { count: failedCount } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', params.id)
    .eq('status', 'failed')

  return (
    <WABroadcastEditor
      broadcast={broadcast}
      templates={templates || []}
      locationId={user.activeLocation?.id}
      userId={user.id}
      failedRecipients={failedRecipients || []}
      failedCount={failedCount || 0}
    />
  )
}
