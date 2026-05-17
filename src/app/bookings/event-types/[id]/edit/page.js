// Relocated from src/app/events/[id]/edit/page.js (E2 of events expansion).
// See src/app/bookings/event-types/page.js header for context.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
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

  if (!event) {
    return (
      <div className="p-8">
        <p className="text-un1t-light">Booking type not found.</p>
        <Link href="/bookings/event-types" className="text-blue-400 text-sm mt-2 inline-block">Back to Booking types</Link>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">Edit booking type</h2>
      <p className="text-sm text-un1t-light mb-6">Update {event.name}</p>
      <EventForm event={event} locationId={user.activeLocation?.id} />
    </div>
  )
}
