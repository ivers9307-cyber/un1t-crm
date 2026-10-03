import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import { canUseCommunicationsHere } from '@/lib/communications-access'
import WATemplateEditor from '@/components/WATemplateEditor'

export const dynamic = 'force-dynamic'

export default async function NewWATemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // WATPLROLE.1 — POST /api/whatsapp/templates decides MANAGER_ROLES at the
  // location it creates at, which is this (the active) studio. Anyone else
  // goes back to the list instead of filling in a form whose submit is a 403.
  // GATES-2 — the layout is only the coarse gate now; keep its old rule for
  // this active-studio page.
  if (!canUseCommunicationsHere(user)) redirect('/')
  const locationId = user.activeLocation?.id
  // GATES-3 (b) — the route's rule: MANAGER_ROLES AND `whatsapp` here.
  if (!canManageWaTemplatesAt(user, locationId)) redirect('/communications/templates?channel=whatsapp')

  return (
    <WATemplateEditor
      locationId={locationId}
      userId={user.id}
      canManage
    />
  )
}
