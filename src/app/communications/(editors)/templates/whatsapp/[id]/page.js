import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import WATemplateEditor from '@/components/WATemplateEditor'
import { canUseCommunicationsForRecord } from '@/lib/communications-access'

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

  // IDOR guard — the template must belong to a location the user can access.
  // 404 (not 403) so foreign ids aren't enumerable. Mirrors email/campaigns/[id].
  // Runs BEFORE the events query below so a foreign id fetches nothing else.
  if (!template || assertLocationAccess(user, template.location_id)) notFound()
  // GATES-2 — the layout's area rule, judged at the TEMPLATE's studio (the
  // layout now only checks the area at SOME studio).
  if (!canUseCommunicationsForRecord(user, template.location_id)) redirect('/communications/templates')

  const { data: events } = await db.from('whatsapp_template_events')
    .select('kind, from_value, to_value, reason, created_at')
    .eq('template_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)

  return (
    <WATemplateEditor
      template={template}
      // WATPLPUT.1 — the TEMPLATE's studio, not the active one: the editor
      // reads its group suggestions and signs header uploads (on that
      // studio's own number) with it.
      locationId={template.location_id}
      userId={user.id}
      events={events || []}
      // WATPLROLE.1 — resubmit, edit and delete decide MANAGER_ROLES at the
      // TEMPLATE's location (not the active studio's role); so does the editor.
      // GATES-3 (b) — with `whatsapp` there too (canManageWaTemplatesAt).
      canManage={canManageWaTemplatesAt(user, template.location_id)}
    />
  )
}
