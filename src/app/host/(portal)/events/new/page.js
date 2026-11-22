// HOST-PORTAL.3 — host self-serve "create an event" page. Server component behind
// the (portal) gate; the getCurrentHost redirect is belt-and-braces (the layout
// already gates). The form itself POSTs the host-scoped /api/host/events route.

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import { listVenueStudios } from '@/lib/event-venue-studio'
import GuardedLink from '@/components/host/GuardedLink'
import HostEventForm from '@/components/host/HostEventForm'
import { HOST_H1 } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

export default async function HostNewEventPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')
  const db = createServerClient()
  const brand = await resolveHostOrgBrand(db, session.host)
  const studios = await listVenueStudios(db, session.host.organization_id)

  return (
    <div>
      <GuardedLink href="/host/events" className="text-xs text-host-hint hover:text-host-text">← Back</GuardedLink>
      <h1 className={`mt-3 ${HOST_H1}`}>Create an event</h1>
      <p className="text-host-hint mt-1 text-sm">
        Draft your event, then publish it when it is ready. It goes on sale as soon as you publish.
      </p>

      <div className="mt-8">
        <HostEventForm mode="create" brandName={brand.name} studios={studios} />
      </div>
    </div>
  )
}
