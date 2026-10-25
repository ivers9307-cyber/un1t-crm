import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { todayStrIn, zoneOfLocation } from '@/lib/location-time'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Calendar, Clock, Mail } from 'lucide-react'
import BookingStatusToggle from '@/components/BookingStatusToggle'
import BookingSkipReminderToggle from '@/components/BookingSkipReminderToggle'
import BookingOutcomeButtons from '@/components/BookingOutcomeButtons'
import BookingOutcomeBulk from '@/components/BookingOutcomeBulk'
import CalendlyTabs from '@/components/CalendlyTabs'
import { listNeedsOutcome } from '@/lib/booking-outcomes'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

// TZ.7: booking_date is the studio's calendar day, so "today" is its clock.
async function getBookings(db, filter, locationId, today) {
  let query = db.from('bookings')
    .select('*, event_types(name, color, slug), contacts(id, name, email)')
    .eq('location_id', locationId)
    .order('booking_date', { ascending: filter === 'upcoming' })
    .order('start_time', { ascending: true })

  if (filter === 'upcoming') {
    query = query.gte('booking_date', today).eq('status', 'confirmed')
  } else if (filter === 'past') {
    query = query.lt('booking_date', today)
  } else if (filter === 'cancelled') {
    query = query.in('status', ['cancelled', 'no_show'])
  }

  const { data } = await query.limit(100)
  return data || []
}

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${h12}:${m} ${ampm}`
}

export default async function BookingsPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'bookings')) redirect('/')

  const filter = searchParams.filter || 'upcoming'
  // The list is one studio's (location_id = the active location), so its zone
  // is the active location's (timezone is on CLIENT_LOCATION_COLUMNS).
  const zone = zoneOfLocation(user.activeLocation)
  const nowMs = Date.now()
  const today = todayStrIn(zone, nowMs)
  const locationId = user.activeLocation?.id
  const db = createServerClient()

  // BOOKINGOUTCOME.1 — confirmed bookings here whose end has passed. Read on
  // every filter for the tab's count; a failed read shows no count and, on
  // its own tab, says so (never "nothing to record").
  let needs = { bookings: [], truncated: false }
  let needsFailed = false
  try {
    needs = await listNeedsOutcome(db, locationId, zone, { nowMs })
  } catch (err) {
    needsFailed = true
    logError('bookings-page', 'needs-outcome read failed', { message: err?.message })
  }
  const isNeedsOutcome = filter === 'needs_outcome'
  const bookings = isNeedsOutcome ? needs.bookings : await getBookings(db, filter, locationId, today)
  const needsCount = needsFailed ? null : needs.bookings.length

  const filters = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'needs_outcome', label: 'Needs outcome', count: needsCount ? `${needsCount}${needs.truncated ? '+' : ''}` : null },
    { key: 'all', label: 'All' },
    { key: 'past', label: 'Past' },
    { key: 'cancelled', label: 'Cancelled' },
  ]

  return (
    <div className="p-8">
      <CalendlyTabs />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Bookings</h2>
          <p className="text-sm text-un1t-subtle mt-1">Confirmed reservations across every event type at this location.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6">
        {filters.map(f => (
          <Link
            key={f.key}
            href={`/bookings?filter=${f.key}`}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
              filter === f.key
                ? 'bg-un1t-text text-un1t-bg'
                : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30'
            }`}
          >
            {f.label}
            {f.count && (
              <span className={`ml-1.5 px-1.5 rounded-full text-[10px] font-semibold ${filter === f.key ? 'bg-un1t-bg text-un1t-text' : 'bg-yellow-500/10 text-yellow-700'}`}>{f.count}</span>
            )}
          </Link>
        ))}
      </div>

      {isNeedsOutcome && needsFailed && (
        <div role="alert" className="mb-4 text-sm text-red-700 bg-red-500/10 border border-red-500/40 rounded-lg p-3">
          Could not load the bookings that need an outcome. Reload the page to try again.
        </div>
      )}
      {isNeedsOutcome && bookings.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-4 bg-un1t-surface border border-un1t-border rounded-lg px-5 py-3">
          <p className="text-sm text-un1t-subtle">
            {bookings.length === 1 ? '1 booking has' : `${bookings.length}${needs.truncated ? '+' : ''} bookings have`} ended without an outcome. Record who showed up.
          </p>
          <BookingOutcomeBulk bookingIds={bookings.map(b => b.id)} />
        </div>
      )}

      {/* Bookings List */}
      {isNeedsOutcome && needsFailed ? null : bookings.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center">
          <Calendar size={40} className="mx-auto mb-4 text-un1t-subtle" />
          <h3 className="text-lg font-semibold mb-2">No bookings found</h3>
          <p className="text-sm text-un1t-subtle">
            {filter === 'upcoming'
              ? 'No upcoming bookings. Share your event links to start receiving bookings.'
              : isNeedsOutcome
                ? 'Every past booking has an outcome.'
                : 'No bookings match this filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg divide-y divide-un1t-border">
          {bookings.map(booking => {
            const isPast = booking.booking_date < today
            const isToday = booking.booking_date === today

            return (
              <div key={booking.id} className="px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Date block */}
                  <div className={`text-center min-w-[52px] ${isPast ? 'opacity-50' : ''}`}>
                    <p className="text-xs text-un1t-subtle">
                      {new Date(booking.booking_date + 'T00:00:00').toLocaleDateString('en-IE', { month: 'short' })}
                    </p>
                    <p className="text-xl font-bold">
                      {new Date(booking.booking_date + 'T00:00:00').getDate()}
                    </p>
                    {isToday && <span className="text-[10px] text-blue-400 font-medium">TODAY</span>}
                  </div>

                  {/* Event colour bar */}
                  <div
                    className="w-1 h-10 rounded-full"
                    style={{ backgroundColor: booking.event_types?.color || '#6B7280' }}
                  />

                  {/* Details */}
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">
                        {booking.contacts?.name || booking.customer_name}
                      </p>
                      <span className="text-xs text-un1t-subtle">·</span>
                      <span className="text-xs text-un1t-subtle">{booking.event_types?.name || 'Event'}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-un1t-subtle">
                      <span className="flex items-center gap-1">
                        <Clock size={11} /> {formatTime(booking.start_time)} — {formatTime(booking.end_time)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Mail size={11} /> {booking.customer_email}
                      </span>
                      {booking.customer_phone && (
                        <span>{booking.customer_phone}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {booking.contacts?.id && (
                    <Link
                      href={`/contacts/${booking.contacts.id}`}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Contact
                    </Link>
                  )}
                  {isNeedsOutcome ? (
                    <BookingOutcomeButtons bookingId={booking.id} />
                  ) : (
                    <>
                      <BookingSkipReminderToggle
                        bookingId={booking.id}
                        skipReminder={booking.skip_reminder}
                        reminderSentAt={booking.reminder_sent_at}
                        bookingDate={booking.booking_date}
                        zone={zone}
                      />
                      <BookingStatusToggle bookingId={booking.id} currentStatus={booking.status} />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
