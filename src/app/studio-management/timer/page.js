// /studio-management/timer — coach control for the class interval timer shown
// on the studio TV. Gated by the dedicated `class_timer` permission
// (CLASS-TIMER-PERM.1 — split off `studio_management` so coaches on shift can
// run the timer without holding door unlock). CLASS-TIMER PR1.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import TimerControlClient from '@/components/TimerControlClient'

export const dynamic = 'force-dynamic'

export default async function StudioTimerPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'class_timer')) redirect('/')

  const locationId = user.activeLocation?.id
  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Class timer</h2>
        <p className="mt-1 text-sm text-un1t-subtle">
          Start an interval timer on the studio TV for {user.activeLocation?.name || 'your active location'}.
        </p>
      </div>
      {locationId
        ? <TimerControlClient locationId={locationId} />
        : <p className="text-sm text-un1t-subtle">No active location selected.</p>}
    </div>
  )
}
