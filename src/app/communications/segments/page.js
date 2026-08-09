// /communications/segments — moved from top-level /segments. Mig 085
// retargeting tags. Renders the same SegmentsGrid component; the
// /communications layout adds the header + tab strip.
//
// SEGPICK.1 — plus a second, deliberately separate group: the location's own
// saved audience filters (contact_segments, saved from /contacts). Only the
// tag cards used to render here, so a saved segment appeared nowhere in
// Communications and operators concluded the save had failed. The word
// "segment" is overloaded in this product; the two groups are kept apart and
// labelled rather than merged.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import SegmentsGrid from '@/components/SegmentsGrid'
import SavedSegmentsList from '@/components/SavedSegmentsList'

export const dynamic = 'force-dynamic'

export default async function SegmentsTabPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  const locationId = user.activeLocation?.id

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-semibold text-un1t-text mb-1">Saved segments</h2>
        {locationId
          ? <SavedSegmentsList locationId={locationId} />
          : <p className="text-sm text-un1t-subtle">Pick a location to see its saved segments.</p>}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-un1t-text mb-1">Tag audiences</h2>
        <p className="text-sm text-un1t-subtle mb-4">
          Tag-defined audiences for retargeting. Tags update automatically as orders complete and races run.
        </p>
        <SegmentsGrid />
      </section>
    </div>
  )
}
