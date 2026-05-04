// /segments — operator view of every tag-defined audience with
// active counts. Click a card to broadcast to that segment via the
// existing email/WhatsApp/SMS broadcast composer (mig 085).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import SegmentsGrid from '@/components/SegmentsGrid'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SegmentsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-white">Segments</h1>
        <p className="text-sm text-un1t-light mt-1">
          Tag-defined audiences for retargeting. Tags update automatically as orders complete and races run.
        </p>
      </header>
      <SegmentsGrid />
    </div>
  )
}
