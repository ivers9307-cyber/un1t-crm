// Decision-tree for one class_booking_requests row (run by the
// process-class-bookings cron). Prior-attendance → staff review (never
// auto-book). Otherwise: ensure a Glofox account + class credit, book the
// class, send the booking_class_confirmed WhatsApp. Any failure → review.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, fetchUserCredits, GLOFOX_BOOKING_MODEL } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { maybeSendBookingWhatsappConfirm } from '@/lib/automations/booking-whatsapp-confirm'
import { logWarn } from '@/lib/log'

const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
function classLabel(startsAt) {
  if (!startsAt) return 'your class'
  const d = new Date(startsAt)
  return isNaN(d.getTime()) ? 'your class' : labelFmt.format(d)
}
async function setStatus(db, id, fields) {
  try { await db.from('class_booking_requests').update(fields).eq('id', id) } catch (e) { logWarn('cbp', 'status update failed', { err: e }) }
}
async function routeToReview(db, request, reason) {
  let approvalId = null
  try {
    const { data: amr } = await db.from('agent_membership_requests').insert({
      location_id: request.location_id, contact_id: request.contact_id, kind: 'class_booking', status: 'pending',
      details: { event_id: request.glofox_event_id, class_name: request.class_name, class_time: classLabel(request.starts_at), mode: 'draft', source: 'start_funnel', reason },
    }).select('id').maybeSingle()
    approvalId = amr?.id || null
  } catch (e) { logWarn('cbp', 'review insert failed', { err: e }) }
  await setStatus(db, request.id, { status: 'needs_review', last_error: reason, approval_request_id: approvalId })
  return { outcome: 'needs_review', detail: reason }
}

export async function processClassBookingRequest(db, request) {
  const creds = await glofoxCredentialsForLocation(db, request.location_id)
  if (missingGlofoxCredentialsForLocation(creds).length) {
    await setStatus(db, request.id, { status: 'failed', last_error: 'glofox_not_configured' })
    return { outcome: 'failed', detail: 'glofox_not_configured' }
  }
  const { data: contact } = await db.from('contacts')
    .select('id, first_name, name, email, phone, wa_phone, glofox_member_id, last_attended_at')
    .eq('id', request.contact_id).maybeSingle()
  if (!contact) {
    await setStatus(db, request.id, { status: 'failed', last_error: 'contact_missing' })
    return { outcome: 'failed', detail: 'contact_missing' }
  }
  const firstName = contact.first_name || (contact.name ? contact.name.split(' ')[0] : '') || 'there'

  if (contact.last_attended_at) return routeToReview(db, request, 'prior_attendance')

  let memberId = contact.glofox_member_id
  let grantedTrial = false
  if (!memberId) {
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true })
    if (res.status === 'failed' || !res.glofox_member_id) return routeToReview(db, request, 'account_failed')
    memberId = res.glofox_member_id
    grantedTrial = res.status === 'created'
  }
  // Existing account, no live credits, never attended → best-effort grant a trial.
  if (!grantedTrial) {
    try {
      const credits = computeCreditsRemaining(await fetchUserCredits(creds, memberId))
      if (credits == null || credits <= 0) {
        await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact: { ...contact, glofox_member_id: memberId }, source: 'booking_form', createIfMissing: false, attachTrial: true })
      }
    } catch (e) { logWarn('cbp', 'credit check/grant failed', { err: e }) }
  }

  const result = await createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })
  if (!result?.ok) {
    const code = result?.body?.message_code || result?.body?.message || `status_${result?.status}`
    return routeToReview(db, request, `booking_failed:${code}`)
  }
  await setStatus(db, request.id, { status: 'booked', last_error: null })
  try {
    await maybeSendBookingWhatsappConfirm({ db, locationId: request.location_id, contact, templateName: 'booking_class_confirmed', bodyParams: [firstName, request.class_name || 'your class', classLabel(request.starts_at)] })
  } catch (e) { logWarn('cbp', 'class confirm failed', { err: e }) }
  return { outcome: 'booked' }
}
