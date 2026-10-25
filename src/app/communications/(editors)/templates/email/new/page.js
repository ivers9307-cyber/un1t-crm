import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import TemplateEditor from '@/components/TemplateEditor'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function NewTemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // GATES-2 — POST /api/templates creates at the active studio and needs
  // `email` there; nobody else is handed a form whose save is a 403.
  if (!hasPermission(user, 'email')) redirect('/communications/templates')

  return (
    <TemplateEditor
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
