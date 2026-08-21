// SONOS.17 — studio music. Gated on the existing `device_control`
// permission (inherited from the retired Tapo devices page — it is already
// wired through the role templates and the nav union in layout.js, so
// repointing it beats minting an identical key).
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import SonosScheduleClient from '@/components/automations/SonosScheduleClient'

export const dynamic = 'force-dynamic'

export default async function SonosPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'device_control')) redirect('/automations')

  const location = user.activeLocation

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Studio music</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Scheduled Sonos playback for {location?.name || 'your studio'} — when the music starts, what plays, and how loud.
        </p>
      </div>
      <SonosScheduleClient locationName={location?.name || ''} />
    </div>
  )
}
