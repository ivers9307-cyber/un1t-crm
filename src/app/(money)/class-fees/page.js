// /class-fees — FEES.1: the nightly late-cancellation and no-show fees at a
// un1t.online studio. Staff waive here before 17:00; outstanding fees
// (refused twice) are retried from the member's profile.
//
// FEES.5 — ?location=<id> opens that studio (the 23:00 email links with it)
// when the viewer holds class_fees there; otherwise the active studio, then
// the first studio where they hold it.
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionAtAnyLocation } from '@/lib/permissions'
import { canUseClassFees } from '@/lib/class-fees-access'
import ClassFeesReview from '@/components/ClassFeesReview'

export const dynamic = 'force-dynamic'

export default async function ClassFeesPage({ searchParams }) {
  const user = await getCurrentUser()
  const params = (await searchParams) || {}
  const requested = typeof params.location === 'string' ? params.location : null
  if (!user) redirect(`/login?redirect=${encodeURIComponent(requested ? `/class-fees?location=${requested}` : '/class-fees')}`)
  if (!hasPermissionAtAnyLocation(user, 'class_fees')) redirect('/dashboard')

  const studios = (user.locations || []).filter((l) => canUseClassFees(user, l.id))
  const activeId = user.activeLocation?.id ?? null
  const chosen = studios.find((l) => l.id === requested)
    ?? studios.find((l) => l.id === activeId)
    ?? studios[0]
    ?? null
  const locationId = chosen?.id ?? null
  const role = locationId ? user.rolesByLocation?.[locationId] : null
  const canEditSettings = user.profileRole === 'master' || role === 'owner'

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Class fees{chosen?.name ? ` · ${chosen.name}` : ''}</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Late cancellations and no-shows from un1t.online. Fees are charged to the member&apos;s default card at the charge time unless you waive them.
        </p>
        {studios.length > 1 && (
          <nav className="flex flex-wrap gap-2 mt-3 text-sm" aria-label="Studio">
            {studios.map((s) => (
              <Link
                key={s.id}
                href={`/class-fees?location=${s.id}`}
                className={`px-3 py-1 rounded-full border border-un1t-border ${s.id === locationId ? 'bg-un1t-border/40 text-un1t-text' : 'text-un1t-subtle hover:text-un1t-text'}`}
              >
                {s.name}
              </Link>
            ))}
          </nav>
        )}
      </header>
      {locationId
        ? <ClassFeesReview key={locationId} locationId={locationId} canEditSettings={canEditSettings} />
        : <p className="text-sm text-un1t-subtle">You don&apos;t have class fees at any studio.</p>}
    </div>
  )
}
