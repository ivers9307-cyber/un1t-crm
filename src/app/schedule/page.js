import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function SchedulePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (user.role !== 'owner' && user.permissions?.schedule === false) {
    redirect('/')
  }

  return (
    <div className="p-8">
      <ScheduleTabs user={user} />
    </div>
  )
}
