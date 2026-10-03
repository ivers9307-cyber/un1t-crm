// QUALS.1 — Schedule › Qualifications. First aid, insurance, vetting and any
// other type the organisation tracks, with expiry dates. Owners and managers
// manage the studio's records; everyone else sees their own, read-only. The
// data comes from GET /api/qualifications (the page reads nothing itself, so
// no service-role client here and nothing for check:location-scoping).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ScheduleTabs from '@/components/ScheduleTabs'
import QualificationsManager from '@/components/QualificationsManager'

export const dynamic = 'force-dynamic'

export default async function QualificationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="px-4 py-6 sm:p-8 max-w-5xl">
      <ScheduleTabs user={user} />
      <h2 className="text-2xl font-bold mb-1">Qualifications</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        First aid, insurance, vetting and anything else your organisation tracks, with the date each one expires.
        Owners and managers record them. Owners get a weekly summary of anything expired or expiring in the next 30 days.
        A shift template can ask for one: the coach picker then flags anyone without it on the day, but never stops you
        assigning them.
      </p>
      <QualificationsManager locationId={user.activeLocation?.id || null} />
    </div>
  )
}
