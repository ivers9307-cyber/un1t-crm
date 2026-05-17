// Relocated from src/app/events/[id]/page.js (E2 of events expansion).
// See src/app/bookings/event-types/page.js header for context.

import { createServerClient } from '@/lib/supabase'
import Link from 'next/link'
import { ArrowLeft, Edit } from 'lucide-react'
import EventActions from '@/components/EventActions'
import BookingStatusToggle from '@/components/BookingStatusToggle'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

async function getEvent(id) {
  const db = createServerClient()
  const { data: event } = await db.from('event_types').select('*').eq('id', id).single()

  const { data: bookings } = await db.from('bookings')
    .select('*, contacts(id, name, email)')
    .eq('event_type_id', id)
    .order('booking_date', { ascending: true })
    .order('start_time', { ascending: true })

  return { event, bookings: bookings || [] }
}

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${h12}:${m} ${ampm}`
}

export default async function BookingTypeDetailPage(props) {
  const params = await props.params;
  const { event, bookings } = await getEvent(params.id)

  if (!event) {
    return (
      <div className="p-8">
        <p className="text-un1t-light">Booking type not found.</p>
        <Link href="/bookings/event-types" className="text-blue-400 text-sm mt-2 inline-block">Back to Booking types</Link>
      </div>
    )
  }

  const upcoming = bookings.filter(b => b.status === 'confirmed' && b.booking_date >= new Date().toISOString().split('T')[0])

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/bookings/event-types" className="text-un1t-light hover:text-un1t-white transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <div className="w-3 h-8 rounded-full" style={{ backgroundColor: event.color }} />
            <h2 className="text-2xl font-bold">{event.name}</h2>
            {!event.active && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400">Inactive</span>
            )}
          </div>
          {event.description && <p className="text-sm text-un1t-light mt-1 ml-6">{event.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <EventActions slug={event.slug} eventId={event.id} eventName={event.name} />
          <Link
            href={`/bookings/event-types/${event.id}/edit`}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors"
          >
            <Edit size={12} />
            Edit
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light">Duration</p>
          <p className="text-xl font-bold mt-1">{event.duration_minutes} min</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light">Buffer</p>
          <p className="text-xl font-bold mt-1">{event.buffer_minutes} min</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light">Total Bookings</p>
          <p className="text-xl font-bold mt-1">{bookings.length}</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light">Upcoming</p>
          <p className="text-xl font-bold mt-1 text-blue-400">{upcoming.length}</p>
        </div>
      </div>

      {/* Bookings List */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg">
        <div className="p-5 border-b border-un1t-gray">
          <h3 className="font-semibold">Bookings</h3>
        </div>

        {bookings.length === 0 ? (
          <p className="p-8 text-center text-sm text-un1t-light">No bookings yet. Share the booking link to start receiving bookings.</p>
        ) : (
          <div className="divide-y divide-un1t-gray">
            {bookings.map(booking => (
              <div key={booking.id} className="px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="text-center min-w-[50px]">
                    <p className="text-xs text-un1t-light">
                      {new Date(booking.booking_date + 'T00:00:00').toLocaleDateString('en-IE', { month: 'short' })}
                    </p>
                    <p className="text-lg font-bold">
                      {new Date(booking.booking_date + 'T00:00:00').getDate()}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {booking.contacts?.name || booking.customer_name}
                    </p>
                    <p className="text-xs text-un1t-light">
                      {formatTime(booking.start_time)} — {formatTime(booking.end_time)} · {booking.customer_email}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {booking.contacts?.id && (
                    <Link
                      href={`/contacts/${booking.contacts.id}`}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      View Contact
                    </Link>
                  )}
                  <BookingStatusToggle bookingId={booking.id} currentStatus={booking.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
