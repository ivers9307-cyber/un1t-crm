import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import TemplateEditor from '@/components/TemplateEditor'
import { canEditEmailTemplate } from '@/lib/communications-access'
import { uuidLike } from '@/lib/schemas'

export const dynamic = 'force-dynamic'

export default async function EditTemplatePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // A malformed id is a 404 before any read: Postgres would answer it with
  // a 22P02, which the read below throws as an error page.
  if (!uuidLike.safeParse(params.id).success) notFound()

  const db = createServerClient()
  // No rows is a legitimate answer here (a bad or deleted id → 404); a failed
  // read is not, so it is thrown (the error page), never reported as missing.
  const { data: template, error } = await db.from('email_templates')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (error) throw new Error(`Email template could not be read (${error.code || 'unknown'})`)

  // IDOR guard — the template must belong to a location the user can access.
  // 404 (not 403) so foreign ids aren't enumerable. Mirrors email/campaigns/[id].
  if (!template || assertLocationAccess(user, template.location_id)) notFound()
  // W0.11 — a template with no location belongs to the platform, not to any
  // tenant, and is master-only (the rule /api/templates/[id] applies to its
  // read and save). 404 for everyone else, so the id is never confirmed.
  // (C123 GATES-4 (c) 404'd it for everyone while PUT could not save it.)
  const isMaster = user.isMaster || user.role === 'master' || user.profileRole === 'master'
  if (!template.location_id && !isMaster) notFound()
  // GATES-2 — `email` at the TEMPLATE's studio, the rule /api/templates/[id]
  // applies to every load and save (the layout used to decide at the active
  // studio, which is the wrong one for another studio's template).
  if (!canEditEmailTemplate(user, template.location_id)) redirect('/communications/templates')

  return (
    <TemplateEditor
      template={template}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
