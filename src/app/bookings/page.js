import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Calendar, Clock, User, Mail } from 'lucide-react'
import BookingStatusToggle from '@/components/BookingStatusToggle'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

async function getBookings(filter, locationId) {
  const db = createServerClient()
  const today = new Date().toISOString().split('T')[0]

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

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-IE', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default async function BookingsPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const filter = searchParams.filter || 'upcoming'
  const bookings = await getBookings(filter, user.activeLocation?.id)

  const filters = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'all', label: 'All' },
    { key: 'past', label: 'Past' },
    { key: 'cancelled', label: 'Cancelled' },
  ]

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Bookings</h2>
          <p className="text-sm text-un1t-light mt-1">All bookings across your events</p>
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
                ? 'bg-white text-black'
                : 'border border-un1t-gray text-un1t-light hover:text-white hover:border-white/30'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {/* Bookings List */}
      {bookings.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <Calendar size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No bookings found</h3>
          <p className="text-sm text-un1t-light">
            {filter === 'upcoming' ? 'No upcoming bookings. Share your event links to start receiving bookings.' : 'No bookings match this filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
          {bookings.map(booking => {
            const isPast = booking.booking_date < today
            const isToday = booking.booking_date === today

            return (
              <div key={booking.id} className="px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Date block */}
                  <div className={`text-center min-w-[52px] ${isPast ? 'opacity-50' : ''}`}>
                    <p className="text-xs text-un1t-light">
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
                      <span className="text-xs text-un1t-light">·</span>
                      <span className="text-xs text-un1t-light">{booking.event_types?.name || 'Event'}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-un1t-light">
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

                <div className="flex items-center gap-3">
                  {booking.contacts?.id && (
                    <Link
                      href={`/contacts/${booking.contacts.id}`}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Contact
                    </Link>
                  )}
                  <BookingStatusToggle bookingId={booking.id} currentStatus={booking.status} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
