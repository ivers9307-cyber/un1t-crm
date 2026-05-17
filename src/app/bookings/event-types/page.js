// Relocated from src/app/events/page.js (E2 of events expansion).
// The /events URL space was freed for the new multi-kind events
// feature (race + workshop + seminar + open_day + masterclass);
// Calendly's bookable templates moved here, alongside the
// /bookings hub they already belong to. See next.config.js for
// the back-compat rewrite from old /events/* URLs.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus, Calendar, Clock, Users } from 'lucide-react'
import EventActions from '@/components/EventActions'
import CalendlyTabs from '@/components/CalendlyTabs'

export const dynamic = 'force-dynamic'

async function getEvents(locationId) {
  const db = createServerClient()
  const { data: events } = await db.from('event_types').select('*').eq('location_id', locationId).order('created_at', { ascending: false })

  // Get booking counts per event
  const eventIds = (events || []).map(e => e.id)
  let bookingCounts = {}
  if (eventIds.length > 0) {
    const { data: bookings } = await db.from('bookings')
      .select('event_type_id')
      .in('event_type_id', eventIds)
      .eq('status', 'confirmed')

    for (const b of (bookings || [])) {
      bookingCounts[b.event_type_id] = (bookingCounts[b.event_type_id] || 0) + 1
    }
  }

  return (events || []).map(e => ({ ...e, booking_count: bookingCounts[e.id] || 0 }))
}

function getAvailableDays(availability) {
  if (!availability) return 'Not set'
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return days.map((d, i) => availability[d] ? labels[i] : null).filter(Boolean).join(', ') || 'None'
}

export default async function BookingTypesPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const events = await getEvents(user.activeLocation?.id)

  // Active / inactive split. Defaults to active so operators land on
  // what's actually bookable; inactive (soft-deleted via the Delete
  // button in EventActions, or disabled via edit) is one click away
  // for re-enabling.
  const rawTab = searchParams?.tab
  const tab = rawTab === 'inactive' ? 'inactive' : 'active'
  const activeEvents   = events.filter((e) => e.active !== false)
  const inactiveEvents = events.filter((e) => e.active === false)
  const visible = tab === 'inactive' ? inactiveEvents : activeEvents
  const tabs = [
    { id: 'active',   label: 'Active',   count: activeEvents.length,   href: '/bookings/event-types' },
    { id: 'inactive', label: 'Inactive', count: inactiveEvents.length, href: '/bookings/event-types?tab=inactive' },
  ]

  return (
    <div className="p-8">
      <CalendlyTabs />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Booking types</h2>
          <p className="text-sm text-un1t-light mt-1">Bookable templates customers reserve from. Configure once, reuse on every booking page.</p>
        </div>
        <Link
          href="/bookings/event-types/new"
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus size={16} />
          New booking type
        </Link>
      </div>

      {/* Active / Inactive tab strip — same pattern as the Upcoming /
          Past tabs on /events. Server-rendered via ?tab= search param.
          Inactive booking types stay hidden from the public booking
          page (active=true filter on /api/public/bookings/[slug]) but
          are kept for historical bookings reporting context. */}
      <div className="flex items-center gap-1 mb-5 border-b border-un1t-gray">
        {tabs.map((t) => {
          const active = tab === t.id
          return (
            <Link
              key={t.id}
              href={t.href}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
                active
                  ? 'border-un1t-white text-un1t-white font-medium'
                  : 'border-transparent text-un1t-light hover:text-un1t-white'
              }`}
            >
              {t.label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                active ? 'bg-un1t-white/15 text-un1t-white' : 'bg-un1t-gray/40 text-un1t-light'
              }`}>{t.count}</span>
            </Link>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <Calendar size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">
            {tab === 'inactive' ? 'No inactive booking types' : 'No booking types yet'}
          </h3>
          <p className="text-sm text-un1t-light mb-4">
            {tab === 'inactive'
              ? 'Deleted or disabled types will appear here so you can re-enable them.'
              : 'Create your first bookable template to start accepting bookings'}
          </p>
          {tab === 'active' && (
            <Link
              href="/bookings/event-types/new"
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
            >
              <Plus size={16} />
              Create booking type
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {visible.map(event => (
            <div key={event.id} className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div
                    className="w-3 h-12 rounded-full shrink-0 mt-0.5"
                    style={{ backgroundColor: event.color }}
                  />
                  <div>
                    <div className="flex items-center gap-3">
                      <Link href={`/bookings/event-types/${event.id}`} className="text-lg font-semibold hover:text-blue-400 transition-colors">
                        {event.name}
                      </Link>
                      {!event.active && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400">Inactive</span>
                      )}
                    </div>
                    {event.description && (
                      <p className="text-sm text-un1t-light mt-1">{event.description}</p>
                    )}
                    <div className="flex items-center gap-4 mt-3 text-xs text-un1t-light">
                      <span className="flex items-center gap-1">
                        <Clock size={12} /> {event.duration_minutes} min
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar size={12} /> {getAvailableDays(event.availability)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={12} /> {event.booking_count} booking{event.booking_count !== 1 ? 's' : ''}
                      </span>
                      {event.custom_fields && event.custom_fields.length > 0 && (
                        <span>{event.custom_fields.length} custom field{event.custom_fields.length !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <EventActions slug={event.slug} eventId={event.id} eventName={event.name} />
                  <Link
                    href={`/bookings/event-types/${event.id}`}
                    className="text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors"
                  >
                    Manage
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
