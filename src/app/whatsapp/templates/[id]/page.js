import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import WATemplateEditor from '@/components/WATemplateEditor'

export const dynamic = 'force-dynamic'

export default async function EditWATemplatePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: template } = await db.from('whatsapp_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!template) notFound()

  const { data: events } = await db.from('whatsapp_template_events')
    .select('kind, from_value, to_value, reason, created_at')
    .eq('template_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)

  return (
    <WATemplateEditor
      template={template}
      locationId={user.activeLocation?.id}
      userId={user.id}
      events={events || []}
    />
  )
}
