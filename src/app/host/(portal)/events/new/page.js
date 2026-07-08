// HOST-PORTAL.3 — host self-serve "create an event" page. Server component behind
// the (portal) gate; the getCurrentHost redirect is belt-and-braces (the layout
// already gates). The form itself POSTs the host-scoped /api/host/events route.

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import HostEventForm from '@/components/host/HostEventForm'

export const dynamic = 'force-dynamic'

export default async function HostNewEventPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  return (
    <div>
      <a href="/host" className="text-xs text-white/45 hover:text-white">← Back</a>
      <h1 className="mt-3 text-2xl font-bold">Create an event</h1>
      <p className="text-white/60 mt-1 text-sm">
        Draft your event, then submit it to UN1T for review before it goes live.
      </p>

      <div className="mt-8">
        <HostEventForm mode="create" />
      </div>
    </div>
  )
}
