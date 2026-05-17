import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import TemplateEditor from '@/components/TemplateEditor'

export const dynamic = 'force-dynamic'

export default async function EditTemplatePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: template } = await db.from('email_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!template) notFound()

  return (
    <TemplateEditor
      template={template}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
