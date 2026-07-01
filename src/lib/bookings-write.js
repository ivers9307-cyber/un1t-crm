// Shared insert for event-type (consultation) bookings — used by the public
// /book route and the WhatsApp Flow completion so both write identical rows
// into `bookings` (see mig 002_events_module + mig 004 location_id).
export async function createEventBooking(db, { event, date, startTime, endTime, contact, source }) {
  const { data, error } = await db.from('bookings').insert({
    event_type_id: event.id,
    location_id: event.location_id,
    contact_id: contact.id,
    booking_date: date,
    start_time: startTime,
    end_time: endTime,
    customer_name: contact.name,
    customer_email: contact.email,
    customer_phone: contact.phone,
    status: 'confirmed',
    source: source || 'unknown',
  }).select('id').single()
  if (error) return { error }
  return { bookingId: data.id }
}
