import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'

export const dynamic = 'force-dynamic'

export default async function SchedulePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="p-8">
      <ScheduleTabs user={user} />
    </div>
  )
}
