import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { MANAGER_ROLES } from '@/lib/schemas'
import BoardList from '@/components/pipelines/BoardList'

export const dynamic = 'force-dynamic'

export default async function PipelinesSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) redirect('/')
  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/settings')

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">Pipelines</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Offer boards and their follow-ups. Built-in boards are set in code and can&apos;t be changed here.
      </p>
      <BoardList locationId={locationId} />
    </div>
  )
}
