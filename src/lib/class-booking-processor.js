// Decision-tree for one class_booking_requests row (run by the
// process-class-bookings cron). Prior-attendance → staff review (never
// auto-book). Otherwise: ensure a Glofox account + class credit, book the
// class, send the booking_class_confirmed WhatsApp. Any failure → review.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, fetchUserCredits, GLOFOX_BOOKING_MODEL } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } from '@/lib/automations/booking-whatsapp-confirm'
import { logWarn } from '@/lib/log'

const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
function classLabel(startsAt) {
  if (!startsAt) return 'your class'
  const d = new Date(startsAt)
  return isNaN(d.getTime()) ? 'your class' : labelFmt.format(d)
}
const MAX_ATTEMPTS = 3 // keep in sync with the process-class-bookings cron

async function setStatus(db, id, fields) {
  try { await db.from('class_booking_requests').update(fields).eq('id', id) } catch (e) { logWarn('cbp', 'status update failed', { err: e }) }
}
async function routeToReview(db, request, reason) {
  let approvalId = null
  // Reuse an existing pending review item for this (contact, class) so a
  // re-submit/retry can't create a duplicate that staff approve twice.
  try {
    const { data: existing } = await db.from('agent_membership_requests')
      .select('id').eq('contact_id', request.contact_id).eq('kind', 'class_booking').eq('status', 'pending')
      .contains('details', { event_id: request.glofox_event_id }).limit(1).maybeSingle()
    approvalId = existing?.id || null
  } catch (e) { logWarn('cbp', 'review lookup failed', { err: e }) }

  if (!approvalId) {
    try {
      const { data: amr } = await db.from('agent_membership_requests').insert({
        location_id: request.location_id, contact_id: request.contact_id, kind: 'class_booking', status: 'pending',
        details: { event_id: request.glofox_event_id, class_name: request.class_name, class_time: classLabel(request.starts_at), mode: 'draft', source: 'start_funnel', reason },
      }).select('id').maybeSingle()
      approvalId = amr?.id || null
    } catch (e) { logWarn('cbp', 'review insert failed', { err: e }) }
  }

  if (!approvalId) {
    // Couldn't create OR find a review item — don't strand the row in
    // needs_review with no approval to act on (a silent dead-end). Retry under
    // the attempt cap, else mark failed so an operator query surfaces it.
    const next = (request.attempts || 0) + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued'
    await setStatus(db, request.id, { status: next, last_error: `review_unavailable:${reason}` })
    return { outcome: next === 'failed' ? 'failed' : 'needs_review', detail: `review_unavailable:${reason}` }
  }
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
    // last_name is REQUIRED: findOrCreateGlofoxMember's create path hard-guards on
    // first_name AND last_name — omitting it would fail every brand-new lead.
    .select('id, first_name, last_name, name, email, phone, wa_phone, glofox_member_id, last_attended_at')
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
    // createIfMissing + attachTrial grants the trial class credit on CREATE.
    // Only a clean create/link is safe to auto-book: 'needs_review' means the
    // email matched MULTIPLE Glofox accounts (guessed link) and 'failed' is an
    // error — both go to staff so we never book a free class against the wrong
    // person.
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true })
    if (!res.glofox_member_id || (res.status !== 'created' && res.status !== 'linked')) {
      return routeToReview(db, request, `account_${res.status || 'failed'}`)
    }
    memberId = res.glofox_member_id
    grantedTrial = res.status === 'created'
  }
  // If we didn't just grant a trial (i.e. an existing account), require a live
  // credit to auto-book. No credits (or an uncertain credit read) → staff
  // review, where they grant the trial + approve. We deliberately do NOT
  // auto-purchase a membership against an existing account from here.
  if (!grantedTrial) {
    let credits = null
    try { credits = computeCreditsRemaining(await fetchUserCredits(creds, memberId)) } catch (e) { logWarn('cbp', 'credit check failed', { err: e }) }
    if (credits == null || credits <= 0) return routeToReview(db, request, 'needs_credit_grant')
  }

  const result = await createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })
  if (!result?.ok) {
    const code = result?.body?.message_code || result?.body?.message || `status_${result?.status}`
    return routeToReview(db, request, `booking_failed:${code}`)
  }
  // Persist the Glofox booking id (best-effort across response shapes) so re-runs
  // and the /approvals view can see the real booking.
  const glofoxBookingId = result?.body?.id || result?.body?._id || result?.body?.booking_id || result?.body?.data?.id || null
  await setStatus(db, request.id, { status: 'booked', last_error: null, glofox_booking_id: glofoxBookingId })
  try {
    await maybeSendBookingWhatsappConfirm({ db, locationId: request.location_id, contact, templateName: CLASS_CONFIRM_TEMPLATE, bodyParams: [firstName, request.class_name || 'your class', classLabel(request.starts_at)] })
  } catch (e) { logWarn('cbp', 'class confirm failed', { err: e }) }
  return { outcome: 'booked' }
}
