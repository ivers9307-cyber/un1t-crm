// Relocated from src/app/events/[id]/edit/page.js (E2 of events expansion).
// See src/app/bookings/event-types/page.js header for context.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { redirect } from 'next/navigation'
import EventForm from '@/components/EventForm'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function EditBookingTypePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const db = createServerClient()
  const { data: event } = await db.from('event_types').select('*').eq('id', params.id).single()

  // IDOR guard — a foreign-location row renders the SAME panel as a
  // missing one, so foreign ids aren't enumerable. Sibling of the detail
  // page's guard (found by the PAGE-SCOPE.1 scan).
  if (!event || assertLocationAccess(user, event.location_id)) {
    return (
      <div className="p-8">
        <p className="text-un1t-subtle">Booking type not found.</p>
        <Link href="/bookings/event-types" className="text-blue-400 text-sm mt-2 inline-block">Back to Booking types</Link>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">Edit booking type</h2>
      <p className="text-sm text-un1t-subtle mb-6">Update {event.name}</p>
      <EventForm event={event} locationId={user.activeLocation?.id} />
    </div>
  )
}
