import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import TimeOffManager from '@/components/TimeOffManager'

export const dynamic = 'force-dynamic'

export default async function TimeOffPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="p-8">
      <TimeOffManager user={user} />
    </div>
  )
}
