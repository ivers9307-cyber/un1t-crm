// The edit form now lives on the Set up tab (HOSTPORTAL.2); /edit only
// redirects there. The host check and the 404 run first, so another host's
// event id never gets a redirect that confirms the event exists.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent } from '@/lib/host-portal'

export const dynamic = 'force-dynamic'

export default async function HostEditEventRedirect(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const event = await loadHostEvent(createServerClient(), session.host.id, params.id, 'id, host_id')
  if (!event) notFound()
  redirect(`/host/events/${event.id}/setup`)
}
