// /events/[id]/checkin/scan?t=<token> — the page a per-attendee QR opens.
// Staff scan the attendee's QR with any phone camera; it lands here. Requires
// a staff session (so a member opening their own QR can't self-check-in), then
// the client posts the token to the scan endpoint and shows the result.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import ScanCheckinClient from '@/components/ScanCheckinClient'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function ScanCheckinPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // PAGEGATES.1 — coarse pre-check, then the event's own location: the same
  // decision POST /api/events/[id]/checkin/scan makes (membership 404, then
  // `races` there), so the scanner never opens where the scan would 403.
  if (!hasPermissionAtAnyLocation(user, 'races')) redirect('/')
  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (raceErr) throw raceErr
  if (!race) notFound()
  if (assertLocationAccess(user, race.location_id)) notFound()
  if (!hasPermissionForLocation(user, race.location_id, 'races')) redirect('/')

  const token = typeof searchParams?.t === 'string' ? searchParams.t : ''

  return (
    <div className="p-6 max-w-md mx-auto">
      <Link
        href={`/events/${params.id}/checkin`}
        className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4"
      >
        <ArrowLeft size={14} /> Check-in roster
      </Link>
      <ScanCheckinClient eventId={params.id} token={token} />
    </div>
  )
}
