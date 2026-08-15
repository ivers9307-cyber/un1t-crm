// EQUIP-MAINT.1 — /maintenance server entry.
//
// Gates the whole route on equipment_admin OR equipment_inspect (same
// posture as src/app/automations/page.js gating curated vs flows). The
// Equipment + Types tabs are setup surfaces and are only ever rendered
// for equipment_admin — an equipment_inspect-only visitor (the default
// for every staff role) reaches the Due stub only. This is enforced
// here (server-side, so the tab pills for the setup surfaces are never
// even sent to the client) in addition to the equipment_admin gate
// already on the mutating API routes.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import MaintenanceView from '@/components/maintenance/MaintenanceView'

export const dynamic = 'force-dynamic'

export default async function MaintenancePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canAdmin = hasPermission(user, 'equipment_admin')
  const canInspect = hasPermission(user, 'equipment_inspect')
  if (!canAdmin && !canInspect) redirect('/dashboard')

  return <MaintenanceView canAdmin={canAdmin} />
}
