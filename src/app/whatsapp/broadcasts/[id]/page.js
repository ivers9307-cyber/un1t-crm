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

  return (
    <WABroadcastEditor
      broadcast={broadcast}
      templates={templates || []}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
