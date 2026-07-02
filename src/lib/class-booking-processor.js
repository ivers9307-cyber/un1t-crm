// Decision-tree for one class_booking_requests row (run by the
// process-class-bookings cron). Prior-attendance → staff review (never
// auto-book). Otherwise: ensure a Glofox account + class credit, book the
// class, send the booking_class_confirmed WhatsApp. Any failure → review.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, fetchUserCredits, fetchUserBookingsResult, GLOFOX_BOOKING_MODEL } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } from '@/lib/automations/booking-whatsapp-confirm'
import { sendCtwaConversion } from '@/lib/meta-capi'
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

  // Cheap pre-gate: if we already know they've attended a class → review (rule 5).
  if (contact.last_attended_at) return routeToReview(db, request, 'prior_attendance')

  // Resolve identity WITHOUT creating an account: search Glofox by email + link.
  // Doing this BEFORE the attendance gate lets us check an EXISTING (possibly
  // lapsed) account's real history, so a repeat trainer is linked + sent to
  // review rather than auto-booked + granted a fresh trial.
  let memberId = contact.glofox_member_id
  if (!memberId) {
    const search = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: false, attachTrial: false })
    if (search.status === 'needs_review') return routeToReview(db, request, 'account_ambiguous')
    if (search.status === 'failed') return routeToReview(db, request, 'account_failed')
    memberId = search.glofox_member_id || null // 'skipped' = no Glofox account exists
  }

  // Existing account → authoritative WIDE attendance check. contacts.last_attended_at
  // can be stale/NULL for lapsed trainers (the sync window is only ~30 days), so
  // query the member's booking history directly over a wide window. Any prior
  // attendance → review (rule 5); an uncertain (failed) check also → review so we
  // never auto-book a free class against an unreadable signal.
  if (memberId) {
    const { ok: attendOk, bookings } = await fetchUserBookingsResult(creds, memberId, { windowDays: 365 * 5 })
    if (!attendOk) return routeToReview(db, request, 'attendance_check_failed')
    if (bookings.some((b) => b.attended === true)) return routeToReview(db, request, 'prior_attendance')
  }

  // Never attended. Ensure an account + a class credit.
  let grantedTrial = false
  if (!memberId) {
    // Truly brand-new (not found in Glofox) → create + grant the trial credit.
    // Only a clean create/link is safe; 'needs_review'/'failed' → staff.
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true })
    if (!res.glofox_member_id || (res.status !== 'created' && res.status !== 'linked')) {
      return routeToReview(db, request, `account_${res.status || 'failed'}`)
    }
    memberId = res.glofox_member_id
    grantedTrial = res.status === 'created'
  }
  // Existing account, no live credit → review (staff grant the trial + approve);
  // an uncertain credit read also fails safe to review.
  if (!grantedTrial) {
    let credits = null
    try { credits = computeCreditsRemaining(await fetchUserCredits(creds, memberId)) } catch (e) { logWarn('cbp', 'credit check failed', { err: e }) }
    if (credits == null || credits <= 0) return routeToReview(db, request, 'needs_credit_grant')
  }

  const result = await createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })
  const code = result?.body?.message_code || result?.body?.message || null
  // Glofox dedupes member+event server-side. A re-run (e.g. the reaper requeued
  // a row whose first attempt booked but died before persisting) returns
  // "already booked" — that's a SUCCESS, not a failure to push to staff review.
  const alreadyBooked = code === 'YOU_HAVE_BOOKED_FOR_THIS_EVENT'
  if (!result?.ok && !alreadyBooked) {
    return routeToReview(db, request, `booking_failed:${code || `status_${result?.status}`}`)
  }
  // Persist the Glofox booking id (best-effort across response shapes) so re-runs
  // and the /approvals view can see the real booking.
  const glofoxBookingId = result?.body?.id || result?.body?._id || result?.body?.booking_id || result?.body?.data?.id || null
  await setStatus(db, request.id, { status: 'booked', last_error: null, glofox_booking_id: glofoxBookingId })
  try {
    await maybeSendBookingWhatsappConfirm({ db, locationId: request.location_id, contact, templateName: CLASS_CONFIRM_TEMPLATE, bodyParams: [firstName, request.class_name || 'your class', classLabel(request.starts_at)] })
  } catch (e) { logWarn('cbp', 'class confirm failed', { err: e }) }
  // CTWA attribution: a confirmed booking is the conversion the ad campaign
  // optimises on. No-ops unless the contact carries a ctwa_clid and the
  // location has settings.meta_ads.dataset_id.
  try {
    await sendCtwaConversion(db, { locationId: request.location_id, contactId: request.contact_id, eventName: 'Schedule', contentName: request.class_name || 'Class' })
  } catch (e) { logWarn('cbp', 'ctwa conversion failed', { err: e }) }
  return { outcome: 'booked' }
}
