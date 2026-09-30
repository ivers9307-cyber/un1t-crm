import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { MANAGER_ROLES } from '@/lib/schemas'
import WATemplateEditor from '@/components/WATemplateEditor'

export const dynamic = 'force-dynamic'

export default async function NewWATemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // WATPLROLE.1 — POST /api/whatsapp/templates decides MANAGER_ROLES at the
  // location it creates at, which is this (the active) studio. Anyone else
  // goes back to the list instead of filling in a form whose submit is a 403.
  const locationId = user.activeLocation?.id
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) redirect('/communications/templates?channel=whatsapp')

  return (
    <WATemplateEditor
      locationId={locationId}
      userId={user.id}
      canManage
    />
  )
}
