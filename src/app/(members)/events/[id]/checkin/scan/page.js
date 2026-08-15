// /events/[id]/checkin/scan?t=<token> — the page a per-attendee QR opens.
// Staff scan the attendee's QR with any phone camera; it lands here. Requires
// a staff session (so a member opening their own QR can't self-check-in), then
// the client posts the token to the scan endpoint and shows the result.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ScanCheckinClient from '@/components/ScanCheckinClient'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function ScanCheckinPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'races')) redirect('/')

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
