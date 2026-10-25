// Relocated from src/app/events/[id]/page.js (E2 of events expansion).
// See src/app/bookings/event-types/page.js header for context.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { todayStrIn, getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import Link from 'next/link'
import { ArrowLeft, Edit } from 'lucide-react'
import EventActions from '@/components/EventActions'
import { canManageEventType } from '@/lib/event-type-gates'
import BookingStatusToggle from '@/components/BookingStatusToggle'
import { hasPermissionForLocation } from '@/lib/permissions'
import { selectAll } from '@/lib/select-all'
import { summarizeBookingOutcomes } from '@/lib/booking-outcomes'

export const dynamic = 'force-dynamic'

// Named columns (BOOKINGOUTCOME.1): pipeline_stage_slug feeds the "now
// members" count; nothing else of the contact row is needed here.
const BOOKING_COLUMNS =
  'id, status, booking_date, start_time, end_time, customer_name, customer_email, contacts(id, name, email, pipeline_stage_slug)'

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
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: event } = await db.from('event_types').select('*').eq('id', params.id).single()

  // IDOR guard — the booking type must belong to a location the user can
  // access. A foreign row renders the SAME panel as a missing one (so
  // foreign ids aren't enumerable) and its bookings are never fetched.
  if (!event || assertLocationAccess(user, event.location_id)) {
    return (
      <div className="p-8">
        <p className="text-un1t-subtle">Booking type not found.</p>
        <Link href="/bookings/event-types" className="text-blue-400 text-sm mt-2 inline-block">Back to Booking types</Link>
      </div>
    )
  }

  // Paged under the 1,000-row cap with a stable order, so the counts below
  // are over every booking of this type. A failed read says so on the page.
  let bookings = []
  let bookingsFailed = false
  try {
    bookings = await selectAll((from, to) => db.from('bookings')
      .select(BOOKING_COLUMNS)
      .eq('event_type_id', params.id)
      .order('booking_date', { ascending: true })
      .order('start_time', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to))
  } catch {
    bookingsFailed = true
  }

  // TZ.7: booking_date is the booking type's studio's calendar day. Display
  // only: an unreadable zone splits on the default zone's day.
  const zone = await getLocationZone(db, event.location_id).catch(() => DEFAULT_TZ)
  const today = todayStrIn(zone)
  const upcoming = bookings.filter(b => b.status === 'confirmed' && b.booking_date >= today)
  // BOOKINGOUTCOME.1 — who showed up. "Awaiting outcome" = still confirmed
  // and its end (a wall clock in the studio zone) has passed.
  const outcomes = summarizeBookingOutcomes(bookings, zone, Date.now())
  // The Needs outcome tab lists the ACTIVE studio's bookings, so link to it
  // only when this booking type is there.
  const outcomeTabHere = user.activeLocation?.id === event.location_id

  // ROLEUI.1 — Edit and Delete show exactly when /api/bookings/event-types/[id]
  // would act: a master, or MANAGER_ROLES at THIS booking type's location.
  const canManage = canManageEventType(user, event.location_id)
  // C134 WEBBOOKINGWRITES.1 — the status pill writes through
  // POST /api/bookings/[id]/status: the WEB `bookings` key at the booking's
  // studio (this booking type's). Without it the pill is a plain label.
  const canEditBookings = hasPermissionForLocation(user, event.location_id, 'bookings')

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/bookings/event-types" className="text-un1t-subtle hover:text-un1t-text transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <div className="w-3 h-8 rounded-full" style={{ backgroundColor: event.color }} />
            <h2 className="text-2xl font-bold">{event.name}</h2>
            {!event.active && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-700">Inactive</span>
            )}
          </div>
          {event.description && <p className="text-sm text-un1t-subtle mt-1 ml-6">{event.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <EventActions slug={event.slug} eventId={event.id} eventName={event.name} canDelete={canManage} />
          {canManage && (
            <Link
              href={`/bookings/event-types/${event.id}/edit`}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors"
            >
              <Edit size={12} />
              Edit
            </Link>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-xs text-un1t-subtle">Duration</p>
          <p className="text-xl font-bold mt-1">{event.duration_minutes} min</p>
        </div>
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-xs text-un1t-subtle">Buffer</p>
          <p className="text-xl font-bold mt-1">{event.buffer_minutes} min</p>
        </div>
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-xs text-un1t-subtle">Total Bookings</p>
          <p className="text-xl font-bold mt-1">{bookings.length}</p>
        </div>
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-xs text-un1t-subtle">Upcoming</p>
          <p className="text-xl font-bold mt-1 text-blue-400">{upcoming.length}</p>
        </div>
      </div>

      {/* Outcomes (BOOKINGOUTCOME.1) */}
      {bookingsFailed ? (
        <div role="alert" className="mb-6 text-sm text-red-700 bg-red-500/10 border border-red-500/40 rounded-lg p-3">
          Could not load the bookings for this booking type. Reload the page to try again.
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 mb-6">
          <h3 className="font-semibold mb-3">Outcomes</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <div data-outcome="total">
              <p className="text-xs text-un1t-subtle">Total booked</p>
              <p className="text-xl font-bold mt-1">{outcomes.total}</p>
            </div>
            <div data-outcome="showed">
              <p className="text-xs text-un1t-subtle">Showed</p>
              <p className="text-xl font-bold mt-1 text-green-700">{outcomes.showed}</p>
              {outcomes.showRate != null && <p className="text-xs text-un1t-subtle">{outcomes.showRate}% showed</p>}
            </div>
            <div data-outcome="no_show">
              <p className="text-xs text-un1t-subtle">No-show</p>
              <p className="text-xl font-bold mt-1">{outcomes.noShow}</p>
            </div>
            <div data-outcome="cancelled">
              <p className="text-xs text-un1t-subtle">Cancelled</p>
              <p className="text-xl font-bold mt-1">{outcomes.cancelled}</p>
            </div>
            <div data-outcome="awaiting">
              <p className="text-xs text-un1t-subtle">Awaiting outcome</p>
              <p className="text-xl font-bold mt-1">{outcomes.awaiting}</p>
              {outcomes.awaiting > 0 && outcomeTabHere && (
                <Link href="/bookings?filter=needs_outcome" className="text-xs text-blue-700 hover:underline">Record outcomes</Link>
              )}
            </div>
            <div data-outcome="members">
              <p className="text-xs text-un1t-subtle">Now members</p>
              <p className="text-xl font-bold mt-1">{outcomes.nowMembers}</p>
            </div>
          </div>
        </div>
      )}

      {/* Bookings List */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg">
        <div className="p-5 border-b border-un1t-border">
          <h3 className="font-semibold">Bookings</h3>
        </div>

        {bookingsFailed ? (
          <p className="p-8 text-center text-sm text-un1t-subtle">Bookings could not be loaded.</p>
        ) : bookings.length === 0 ? (
          <p className="p-8 text-center text-sm text-un1t-subtle">No bookings yet. Share the booking link to start receiving bookings.</p>
        ) : (
          <div className="divide-y divide-un1t-border">
            {bookings.map(booking => (
              <div key={booking.id} className="px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="text-center min-w-[50px]">
                    <p className="text-xs text-un1t-subtle">
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
                    <p className="text-xs text-un1t-subtle">
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
                  <BookingStatusToggle bookingId={booking.id} currentStatus={booking.status} canEdit={canEditBookings} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
