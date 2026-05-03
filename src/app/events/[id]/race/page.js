// /events/[id]/race?date=YYYY-MM-DD
//
// Race-day operator interface for timed events (mig 081). Server
// component does the auth + initial data fetch; the RaceControlPanel
// client component takes over and polls the race-board API every 2s
// to keep multiple operators in sync.
//
// Default date is today (Europe/Dublin local) so an operator opening
// the page on race day doesn't need to type the date. The query string
// override lets you preview a future event's start lineup or review a
// past event's results.

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import RaceControlPanel from '@/components/RaceControlPanel'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function todayInDublin() {
  // YYYY-MM-DD in Europe/Dublin. Done via formatToParts so DST flips
  // don't shift the date by an hour at midnight.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

export default async function RaceControlPage({ params, searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  const db = createServerClient()
  const { data: event } = await db
    .from('event_types')
    .select('id, name, location_id, is_timed_event, allowed_team_sizes, duration_minutes')
    .eq('id', params.id)
    .single()

  if (!event) {
    return (
      <div className="p-8 max-w-4xl">
        <h2 className="text-2xl font-bold mb-1">Event not found</h2>
        <p className="text-sm text-un1t-light">The event you tried to open doesn&apos;t exist or you don&apos;t have access.</p>
      </div>
    )
  }
  if (!event.is_timed_event) {
    return (
      <div className="p-8 max-w-4xl">
        <h2 className="text-2xl font-bold mb-1">Race timing not enabled</h2>
        <p className="text-sm text-un1t-light">
          This event isn&apos;t configured as a timed event. Edit the event type and turn on
          &ldquo;Track race times for this event&rdquo; to use the race-control UI.
        </p>
      </div>
    )
  }

  const guard = assertLocationAccess(user, event.location_id)
  if (guard) redirect('/')

  const date = (searchParams?.date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date))
    ? searchParams.date
    : todayInDublin()

  return (
    <div className="p-4 sm:p-6 max-w-7xl">
      <div className="mb-4">
        <h2 className="text-2xl font-bold">{event.name} — Race control</h2>
        <p className="text-sm text-un1t-light mt-0.5">
          {date} · auto-refreshes every 2 seconds
        </p>
      </div>
      <RaceControlPanel eventId={event.id} date={date} />
    </div>
  )
}
