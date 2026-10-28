// /class-fees — FEES.1: the nightly late-cancellation and no-show fees at the
// active un1t.online studio. Staff waive here before 17:00; outstanding fees
// (refused twice) are retried from the member's profile. The 23:00 email
// links here.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ClassFeesReview from '@/components/ClassFeesReview'

export const dynamic = 'force-dynamic'

export default async function ClassFeesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/class-fees')
  if (!hasPermission(user, 'class_fees')) redirect('/dashboard')
  const activeId = user.activeLocation?.id ?? null
  const role = activeId ? user.rolesByLocation?.[activeId] : null
  const canEditSettings = user.profileRole === 'master' || role === 'owner'

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Class fees</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Late cancellations and no-shows from un1t.online. Fees are charged to the member&apos;s default card at the charge time unless you waive them.
        </p>
      </header>
      {activeId
        ? <ClassFeesReview locationId={activeId} canEditSettings={canEditSettings} />
        : <p className="text-sm text-un1t-subtle">Choose a studio first.</p>}
    </div>
  )
}
