// /studio-management — operator surface for on-site studio actions.
//
// Today: remote unlock for any UniFi-controlled door at the active
// location. Future: alarm arm/disarm, camera live feeds, etc.
// Single permission key (`studio_management`) gates the whole route.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import StudioManagementPanel from '@/components/StudioManagementPanel'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function StudioManagementPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'studio_management')) redirect('/')

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Studio management</h2>
        <p className="text-sm text-un1t-light mt-1">
          On-site actions for {user.activeLocation?.name || 'your active location'}.
        </p>
      </div>
      <StudioManagementPanel />
    </div>
  )
}
