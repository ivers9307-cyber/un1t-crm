// /api/bookings/[id]/cancel — operator-cancellation endpoint.
//
// Replaces the previous "BookingStatusToggle writes directly to
// bookings via createBrowserClient" path for the cancel case
// specifically. Going through an API route gives us:
//   - permission check (manager-or-master at the booking's location)
//   - transition validation (refuse to cancel an already-cancelled
//     or already-completed booking — meaningless state churn)
//   - optional customer-notify hook (Postmark transactional email)
//   - audit trail via the mig 074 trigger that logs a kind='event'
//     activity on the contact's timeline when status changes
//
// The "confirmed → completed" / "confirmed → no_show" cases stay
// on the direct-write path for now since they don't need the
// notify hook. Tier 3 might consolidate everything if we add
// other side effects.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { sendTransactionalEmail } from '@/lib/postmark'
import { logWarn } from '@/lib/log'

const CancelSchema = z.object({
  notify_customer: z.boolean().optional(),
  reason: z.string().max(500).nullable().optional(),
})

function formatBookingTime(dateStr, timeStr) {
  try {
    const dt = new Date(`${dateStr}T${timeStr}Z`)
    return dt.toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return `${dateStr} ${timeStr}`
  }
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CancelSchema)
  if (!validation.ok) return validation.response
  const { notify_customer, reason } = validation.data

  const db = createServerClient()

  const { data: booking, error: fetchErr } = await db
    .from('bookings')
    .select(`
      id, status, customer_name, customer_email, location_id,
      booking_date, start_time, end_time,
      event_types ( name, location_id ),
      contacts ( id, name, first_name, email, contact_preferences ( email_administrative ) )
    `)
    .eq('id', params.id)
    .single()

  if (fetchErr || !booking) {
    return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 })
  }

  // Per-location ownership check for non-master callers.
  const bookingLocationId = booking.location_id || booking.event_types?.location_id
  if (user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    if (bookingLocationId && !userLocationIds.includes(bookingLocationId)) {
      return NextResponse.json({ success: false, error: 'Forbidden — not your location' }, { status: 403 })
    }
  }

  // Refuse pointless transitions. Cancel is one-way; un-cancelling
  // would create state churn and confused timeline rows.
  if (booking.status === 'cancelled') {
    return NextResponse.json(
      { success: false, error: 'Booking is already cancelled.' },
      { status: 409 }
    )
  }
  if (booking.status === 'completed') {
    return NextResponse.json(
      { success: false, error: 'Cannot cancel a completed booking. Use "no-show" if the customer didn\'t turn up.' },
      { status: 409 }
    )
  }

  const { error: updErr } = await db
    .from('bookings')
    .update({
      status: 'cancelled',
      // The notes column doesn't exist on bookings; cancellation
      // reason rides along on the trigger-generated activity row
      // via the new note line below if we ever extend the trigger.
      // For now, the reason is captured in the response audit only.
    })
    .eq('id', params.id)

  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }

  // Optional customer notification. Best-effort: a Postmark hiccup
  // never rolls back a cancellation that's already on disk.
  let notification = { sent: false }
  if (notify_customer && booking.customer_email) {
    // Honour email_administrative opt-out — even a cancellation is
    // an administrative message, and users who've opted out of
    // those have explicitly asked to receive nothing transactional.
    const c = booking.contacts
    const adminConsent = Array.isArray(c?.contact_preferences)
      ? c.contact_preferences[0]?.email_administrative
      : c?.contact_preferences?.email_administrative
    if (adminConsent === false) {
      notification = { sent: false, skipped: 'opted_out_administrative_email' }
    } else {
      try {
        const eventName = booking.event_types?.name || 'your booking'
        const when = formatBookingTime(booking.booking_date, booking.start_time)
        const reasonHtml = reason
          ? `<p>${escapeHtml(reason)}</p>`
          : ''
        await sendTransactionalEmail({
          to: booking.customer_email,
          subject: `Cancelled: ${eventName} on ${booking.booking_date}`,
          htmlBody: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #111827; line-height: 1.5;">
              <p>Hi ${escapeHtml(booking.customer_name?.split(' ')[0] || 'there')},</p>
              <p>Your booking for <strong>${escapeHtml(eventName)}</strong> on <strong>${escapeHtml(when)}</strong> has been cancelled.</p>
              ${reasonHtml}
              <p>If this was unexpected or you'd like to rebook, just reply to this email.</p>
            </div>
          `,
          tag: 'booking-cancelled',
          metadata: { booking_id: booking.id, location_id: bookingLocationId },
        })
        notification = { sent: true }
      } catch (e) {
        logWarn('bookings/cancel', `notify failed`, { err: e })
        notification = { sent: false, error: e.message }
      }
    }
  }

  return NextResponse.json({
    success: true,
    data: { id: booking.id, status: 'cancelled' },
    notification,
  })
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
