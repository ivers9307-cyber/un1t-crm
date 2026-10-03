// Relocated from src/app/events/new/page.js (E2 of events expansion).
// See src/app/bookings/event-types/page.js header for context.

import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import EventForm from '@/components/EventForm'
import { canCreateEventType } from '@/lib/event-type-gates'

export const dynamic = 'force-dynamic'

export default async function NewBookingTypePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // EVENTTYPERLS.1 — POST /api/bookings/event-types creates only for a master
  // or MANAGER_ROLES at the studio it creates in (the active one, which the
  // form sends). Anyone else gets this panel, not a form the route refuses.
  if (!canCreateEventType(user)) {
    return (
      <div className="p-8">
        <p className="text-un1t-subtle">Only a manager at this studio can create booking types.</p>
        <Link href="/bookings/event-types" className="text-blue-400 text-sm mt-2 inline-block">Back to Booking types</Link>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">Create booking type</h2>
      <p className="text-sm text-un1t-subtle mb-6">Define a new bookable template that customers can reserve from the public booking page.</p>
      <EventForm locationId={user.activeLocation.id} />
    </div>
  )
}
