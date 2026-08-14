import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
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

  // IDOR guard — the template must belong to a location the user can access.
  // 404 (not 403) so foreign ids aren't enumerable. Mirrors email/campaigns/[id].
  if (!template || assertLocationAccess(user, template.location_id)) notFound()

  return (
    <TemplateEditor
      template={template}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
