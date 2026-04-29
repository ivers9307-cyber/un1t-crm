import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import WABroadcastEditor from '@/components/WABroadcastEditor'

export const dynamic = 'force-dynamic'

export default async function NewBroadcastPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: templates } = await db.from('whatsapp_templates')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .eq('status', 'APPROVED')
    .order('name')

  return (
    <WABroadcastEditor
      templates={templates || []}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
