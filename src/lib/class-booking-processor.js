// Decision-tree for one class_booking_requests row (run by the
// process-class-bookings cron). Prior-attendance books against the
// account's EXISTING balance (credits or an active membership); only a
// returner with nothing to book with goes to staff review — and a
// returner is never auto-granted a fresh trial. Brand-new leads: ensure a
// Glofox account + trial credit, book the class, send the
// booking_class_confirmed WhatsApp. Any failure → review.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, interpretBookingResult, fetchUserCredits, fetchUserBookingsResult, GLOFOX_BOOKING_MODEL } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } from '@/lib/automations/booking-whatsapp-confirm'
import { sendCtwaConversion, sendWebsiteConversion } from '@/lib/meta-capi'
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
        details: {
          event_id: request.glofox_event_id, class_name: request.class_name, class_time: classLabel(request.starts_at),
          // ISO start for the mobile queue's countdown chip (class_time is a label).
          starts_at: request.starts_at || null,
          mode: 'draft', source: 'start_funnel', reason,
          ...(request.payment_status === 'paid'
            ? { paid: true, amount_cents: request.amount_cents, currency: request.currency || 'EUR' }
            : {}),
        },
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
  // APPROVALS-STUDIO.1 — a review item is a customer waiting; ping the
  // approvers. Deduped per (request, recipient), so the reuse-existing
  // path above can't double-notify. Best-effort.
  try {
    const { notifyAgentApprovalRequest } = await import('@/lib/agent/approval-notify')
    await notifyAgentApprovalRequest(db, {
      requestId: approvalId,
      locationId: request.location_id,
      kind: 'class_booking',
      customerName: request.customer_name,
      summary: [request.class_name, classLabel(request.starts_at), `needs review: ${reason}`].filter(Boolean).join(' · '),
    })
  } catch (e) { logWarn('cbp', 'approval notify failed', { err: e }) }
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
    // glofox_membership_status: the attended-path balance gate reads it.
    .select('id, first_name, last_name, name, email, phone, wa_phone, glofox_member_id, glofox_membership_status, last_attended_at, ctwa_clid')
    .eq('id', request.contact_id).maybeSingle()
  if (!contact) {
    await setStatus(db, request.id, { status: 'failed', last_error: 'contact_missing' })
    return { outcome: 'failed', detail: 'contact_missing' }
  }
  const firstName = contact.first_name || (contact.name ? contact.name.split(' ')[0] : '') || 'there'

  // AGENT-FUNNEL-CREDITS.1 — prior attendance alone no longer blocks the
  // booking (Richard 2026-08-25). /start is aimed at new people, but a
  // returner who books through it is still a customer trying to book: if
  // the account holds a usable balance (class credits, or an active
  // membership), book against it. Review is reserved for the returner with
  // NOTHING to book with — the "do they get another free class?" decision
  // staff actually need to make. Rule 5's real invariant is unchanged: a
  // returner is NEVER granted a fresh trial automatically.
  const attendedLocally = !!contact.last_attended_at

  // Resolve identity WITHOUT creating an account: search Glofox by email +
  // link, so a repeat trainer's real account (and balance) is what we judge.
  let memberId = contact.glofox_member_id
  if (!memberId) {
    const search = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: false, attachTrial: false })
    if (search.status === 'needs_review') return routeToReview(db, request, 'account_ambiguous')
    if (search.status === 'failed') return routeToReview(db, request, 'account_failed')
    memberId = search.glofox_member_id || null // 'skipped' = no Glofox account exists
  }

  // Attendance: trust the local stamp when set; otherwise ask Glofox over a
  // WIDE window (contacts.last_attended_at can be stale/NULL for lapsed
  // trainers — the sync window is only ~30 days). An uncertain read still
  // fails safe to review: never auto-book a free class against an
  // unreadable signal.
  let attended = attendedLocally
  if (!attended && memberId) {
    const { ok: attendOk, bookings } = await fetchUserBookingsResult(creds, memberId, { windowDays: 365 * 5 })
    if (!attendOk) return routeToReview(db, request, 'attendance_check_failed')
    attended = bookings.some((b) => b.attended === true)
  }

  let grantedTrial = false
  if (attended) {
    // Attended before with no Glofox account at all → nothing to book with.
    if (!memberId) return routeToReview(db, request, 'prior_attendance')
    let credits = null
    try { credits = computeCreditsRemaining(await fetchUserCredits(creds, memberId)) } catch (e) { logWarn('cbp', 'credit check failed', { err: e }) }
    // computeCreditsRemaining is null for BOTH "no credits" and "membership
    // without per-class credit records" — the CRM's synced membership status
    // breaks the tie: an active membership is bookable (Glofox arbitrates,
    // and a rejection routes to review as booking_failed below). Zero /
    // null / unreadable with no active membership → staff.
    const activeMembership = contact.glofox_membership_status === 'active'
    if (!(credits > 0) && !activeMembership) return routeToReview(db, request, 'prior_attendance')
    // Fall through to the booking — consuming the EXISTING balance, never a
    // fresh trial.
  } else if (!memberId) {
    // Truly brand-new (not found in Glofox) → create + grant the trial credit.
    // Only a clean create/link is safe; 'needs_review'/'failed' → staff.
    const trialOverride = (request.trial_membership_id && request.trial_plan_code)
      ? { membershipId: request.trial_membership_id, planCode: request.trial_plan_code }
      : null
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true, trialOverride })
    if (!res.glofox_member_id || (res.status !== 'created' && res.status !== 'linked')) {
      return routeToReview(db, request, `account_${res.status || 'failed'}`)
    }
    memberId = res.glofox_member_id
    grantedTrial = res.status === 'created'
  }
  // Existing never-attended account, no live credit → review (staff grant the
  // trial + approve); an uncertain credit read also fails safe to review.
  // The attended path above did its own balance check.
  if (!attended && !grantedTrial) {
    let credits = null
    try { credits = computeCreditsRemaining(await fetchUserCredits(creds, memberId)) } catch (e) { logWarn('cbp', 'credit check failed', { err: e }) }
    if (credits == null || credits <= 0) return routeToReview(db, request, 'needs_credit_grant')
  }

  const result = await createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })
  // Success needs the created booking id — Glofox can 200 with a failure
  // body (YOU_HAVE_NO_CREDITS_LEFT), so HTTP ok alone is not enough.
  const { booked, bookingId, messageCode } = interpretBookingResult(result)
  // Glofox dedupes member+event server-side. A re-run (e.g. the reaper requeued
  // a row whose first attempt booked but died before persisting) returns
  // "already booked" — that's a SUCCESS, not a failure to push to staff review.
  const alreadyBooked = messageCode === 'YOU_HAVE_BOOKED_FOR_THIS_EVENT'
  if (!booked && !alreadyBooked) {
    return routeToReview(db, request, `booking_failed:${messageCode || `status_${result?.status}`}`)
  }
  // Persist the Glofox booking id so re-runs and the /approvals view can see
  // the real booking (null on the already-booked re-run path).
  await setStatus(db, request.id, { status: 'booked', last_error: null, glofox_booking_id: bookingId })
  try {
    await maybeSendBookingWhatsappConfirm({ db, locationId: request.location_id, contact, templateName: CLASS_CONFIRM_TEMPLATE, bodyParams: [firstName, request.class_name || 'your class', classLabel(request.starts_at)] })
  } catch (e) { logWarn('cbp', 'class confirm failed', { err: e }) }
  // CTWA attribution: a confirmed booking is the conversion the ad campaign
  // optimises on. No-ops unless the contact carries a ctwa_clid and the
  // location has settings.meta_ads.dataset_id.
  try {
    await sendCtwaConversion(db, { locationId: request.location_id, contactId: request.contact_id, eventName: 'Schedule', contentName: request.class_name || 'Class' })
  } catch (e) { logWarn('cbp', 'ctwa conversion failed', { err: e }) }
  // Website Schedule for non-CTWA contacts (the /start funnel). CTWA contacts
  // are covered by the business_messaging event above — don't double-fire the
  // same booking down both channels.
  try {
    if (!contact.ctwa_clid) {
      await sendWebsiteConversion(db, {
        locationId: request.location_id, eventName: 'Schedule',
        email: contact.email, phone: contact.phone,
        eventSourceUrl: 'https://www.un1tdublin.com/start',
        eventId: `classbooking-${request.id}`,
        contentName: request.class_name || 'Class',
      })
    }
  } catch (e) { logWarn('cbp', 'website conversion failed', { err: e }) }
  return { outcome: 'booked' }
}
