import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import WATemplateEditor from '@/components/WATemplateEditor'

export const dynamic = 'force-dynamic'

export default async function EditWATemplatePage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: template } = await db.from('whatsapp_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!template) notFound()

  return (
    <WATemplateEditor
      template={template}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
