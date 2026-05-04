// /communications/segments — moved from top-level /segments. Mig 085
// retargeting tags. Renders the same SegmentsGrid component; the
// /communications layout adds the header + tab strip.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import SegmentsGrid from '@/components/SegmentsGrid'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SegmentsTabPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  return (
    <div>
      <p className="text-sm text-un1t-light mb-4">
        Tag-defined audiences for retargeting. Tags update automatically as orders complete and races run.
      </p>
      <SegmentsGrid />
    </div>
  )
}
