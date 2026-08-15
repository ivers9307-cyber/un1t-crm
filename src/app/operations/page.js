// /operations — Operations hub index. Mirrors /team (HUBS.2d). Maintenance
// first (the daily surface), then the door/devices panel, displays,
// presentations. Checklists shares studio_management with the Studio tab
// so it never needs its own chain step.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function OperationsIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'equipment_admin') || hasPermission(user, 'equipment_inspect')) redirect('/maintenance')
  if (hasPermission(user, 'studio_management')) redirect('/studio-management')
  if (hasPermission(user, 'tv_displays')) redirect('/tv-displays')
  if (hasPermission(user, 'presentations')) redirect('/presentations')
  redirect('/')
}
