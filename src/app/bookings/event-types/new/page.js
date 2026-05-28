// Relocated from src/app/events/new/page.js (E2 of events expansion).
// See src/app/bookings/event-types/page.js header for context.

import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import EventForm from '@/components/EventForm'

export const dynamic = 'force-dynamic'

export default async function NewBookingTypePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">Create booking type</h2>
      <p className="text-sm text-un1t-subtle mb-6">Define a new bookable template that customers can reserve from the public booking page.</p>
      <EventForm locationId={user.activeLocation?.id} />
    </div>
  )
}
