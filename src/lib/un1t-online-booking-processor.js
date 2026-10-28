// UN1TWRITE.22 — the un1t.online funnel: one class_booking_requests row at a
// un1t.online studio with funnel_enabled on (spec D 6.5, steps 1-8). Every
// step resumes from the ledger, so a crash after any send is re-run without
// a second create, trial or booking.
//
//   1 preflight   the class in un1t_events, scheduled and starting in the
//                 future (else class_unavailable), and in the latest pull
//                 (missing, cancelled or stale: un1t_class_no_longer_available,
//                 UN1TBOOK.20); the contact has an email (else no_email)
//   2-3 account   ensureUn1tAccount: find (own link, same-email sibling, API
//                 walk), else create with the request's recorded acceptance
//   4 credits     a balance, unlimited, or an active subscription in the
//                 mirror skips the trial; a failed read throws (retry)
//   5 trial       PAIDTRIALONLY.1: with the studio's paid trial reply set,
//                 no trial: the Flow customer is sent the reply, row failed;
//                 grantTrial: granted → book; ineligible → E's hand-off, else
//                 the trial-used email, row failed, a record-only card;
//                 needs_staff → its card; retry → throw
//   6 book        done / already booked → row booked, 'un1t:<id>'; refused →
//                 un1t_booking_failed:<code>; unclear → un1t_outcome_unknown;
//                 budget / in flight → throw
//   7 after       an account we created → the set-password step; an existing
//                 one → the booking confirmation, unless un1t.online sends its
//                 own; every outcome and skip goes in un1t_steps
//   8 tail        the CTWA / website Schedule conversions, as the Glofox tail
//
// A THROW is the queue's retry signal; it carries reviewOptions with the
// provider, so the card filed at the cap runs the un1t.online executor. Every
// card is filed with details.provider = 'un1t_online' and the executing
// contact. One writer per job: it bounds the permission cache and the
// writes_enabled snapshot to this request.

import { un1tEventIdOf } from './manual-timetable.js'
import { createUn1tWriter } from './un1t-online-write.js'
import { book as bookOp, grantTrial as grantTrialOp } from './un1t-online-write-ops.js'
import { ensureUn1tAccount as ensureAccountOp, runSetPasswordStep as setPasswordOp } from './un1t-online-account.js'
import { sendUn1tTrialUsedEmail as trialUsedEmailOp, sendUn1tAccountEmail } from './un1t-online-funnel-emails.js'
import { trialUsedHandoff as handoffOp } from './un1t-online-trial-used.js'
import { MEMBERSHIP_ACTIVE_STATUSES } from './un1t-online-map.js'
import { freshCutoff } from './un1t-online-freshness.js'
import { logError, logWarn } from './log'

export const UN1T_PROVIDER = 'un1t_online'
/** UN1TBOOK.20 — the card for a class removed in un1t.online before it was booked. */
export const UN1T_CLASS_GONE = 'un1t_class_no_longer_available'
const LOG = 'un1t-funnel'

/** The queue's retry signal, carrying the card options for the cap. */
export class Un1tFunnelRetry extends Error {
  constructor(code, { executingContactId = null } = {}) {
    super(`un1t_funnel_retry:${code ?? 'unknown'}`)
    this.name = 'Un1tFunnelRetry'
    this.code = code ?? null
    this.reviewReason = 'processing_error'
    this.reviewOptions = { provider: UN1T_PROVIDER, executingContactId }
  }
}

async function defaultRouteToReview(...args) {
  const { routeToReview } = await import('./class-booking-processor.js')
  return routeToReview(...args)
}
async function defaultConfirm(...args) {
  const { sendManualBookingConfirmEmail } = await import('./manual-booking-confirm.js')
  return sendManualBookingConfirmEmail(...args)
}
async function defaultCtwa(...args) {
  const { sendCtwaConversion } = await import('./meta-capi.js')
  return sendCtwaConversion(...args)
}
async function defaultFlowNotice(...args) {
  const { notifyFlowBookingOutcome } = await import('./whatsapp-flow/booking-notice.js')
  return notifyFlowBookingOutcome(...args)
}
async function defaultPaidTrialReply(...args) {
  const { readPaidTrialReply } = await import('./whatsapp-flow/booking-notice.js')
  return readPaidTrialReply(...args)
}
async function defaultWebsite(...args) {
  const { sendWebsiteConversion } = await import('./meta-capi.js')
  return sendWebsiteConversion(...args)
}

function depsOf(deps = {}) {
  return {
    writerFactory: deps.writerFactory ?? createUn1tWriter,
    ensureUn1tAccount: deps.ensureUn1tAccount ?? ensureAccountOp,
    grantTrial: deps.grantTrial ?? grantTrialOp,
    book: deps.book ?? bookOp,
    runSetPasswordStep: deps.runSetPasswordStep ?? setPasswordOp,
    sendManualBookingConfirmEmail: deps.sendManualBookingConfirmEmail ?? defaultConfirm,
    sendUn1tTrialUsedEmail: deps.sendUn1tTrialUsedEmail ?? trialUsedEmailOp,
    sendUn1tAccountEmail: deps.sendUn1tAccountEmail ?? sendUn1tAccountEmail,
    trialUsedHandoff: deps.trialUsedHandoff ?? handoffOp,
    routeToReview: deps.routeToReview ?? defaultRouteToReview,
    sendCtwaConversion: deps.sendCtwaConversion ?? defaultCtwa,
    sendWebsiteConversion: deps.sendWebsiteConversion ?? defaultWebsite,
    notifyFlowBookingOutcome: deps.notifyFlowBookingOutcome ?? defaultFlowNotice,
    readPaidTrialReply: deps.readPaidTrialReply ?? defaultPaidTrialReply,
    now: deps.now ?? (() => Date.now()),
  }
}

// The queue row: a judged write, never a silent one; a lost stamp is logged
// (at error level for 'booked', which nothing else would record).
async function stampRow(db, id, fields) {
  const log = fields?.status === 'booked' ? logError : logWarn
  try {
    const { error } = await db.from('class_booking_requests').update(fields).eq('id', id)
    if (error) log(LOG, 'queue row update failed', { requestId: id, err: error })
  } catch (err) {
    log(LOG, 'queue row update threw', { requestId: id, err })
  }
}

/** The landing row (copy, conversion URL) and the studio (name, address, zone), best-effort. */
export async function readStudioContextForApproval(db, locationId) {
  return readStudioContext(db, locationId)
}
async function readStudioContext(db, locationId) {
  const out = { blocks: null, publicPath: null, studioName: null, address: null, zone: null }
  try {
    const [{ data: page }, { data: loc }] = await Promise.all([
      db.from('landing_page_settings').select('public_path, blocks').eq('location_id', locationId).maybeSingle(),
      db.from('locations').select('name, address, timezone').eq('id', locationId).maybeSingle(),
    ])
    out.blocks = page?.blocks ?? null
    out.publicPath = page?.public_path ?? null
    out.studioName = loc?.name ?? null
    out.address = loc?.address ?? null
    out.zone = loc?.timezone ?? null
  } catch (err) {
    logWarn(LOG, 'studio context unreadable; defaults used', { locationId, err })
  }
  return out
}

/**
 * Step 7, shared with the approval executor (UN1TWRITE.23): after a confirmed
 * booking, the set-password step for an account we created, or the booking
 * confirmation for an existing one. Never throws over an email.
 * @returns {Promise<object>} the un1t_steps fields it settled
 */
export async function un1tAfterBooking(db, { request, contact, account, settings, studio, origin, writer }, deps = {}) {
  const d = depsOf(deps)
  const emailArgs = { blocks: studio.blocks, studioName: studio.studioName, address: studio.address, zone: studio.zone }
  // The set-password step decides from the ledger whether the CRM created this
  // account, so a re-run (a queue retry, an approval) that now finds the
  // account "existing" still sends the code it never got.
  try {
    const r = await d.runSetPasswordStep(db, {
      locationId: request.location_id, contact, un1tUserId: account.un1tUserId, request, settings, origin, emailArgs, writer,
    }, { sendUn1tAccountEmail: d.sendUn1tAccountEmail })
    // The step stands in for the confirmation only for the booking that made
    // the account, or when it sent something now. A later booking for an
    // account the CRM made weeks ago (its reset long done) still gets the
    // ordinary confirmation.
    const ranNow = r.explanation === 'sent' || ['done', 'unknown', 'refused', 'retry'].includes(r.forgotPassword)
    if (account.kind === 'created' || ranNow) {
      return { explanation: r.explanation, forgot_password: r.forgotPassword, ...(r.code ? { forgot_password_code: r.code } : {}), ...(r.help ? { help: r.help } : {}) }
    }
  } catch (err) {
    logWarn(LOG, 'set-password step failed; the booking stands', { requestId: request.id, err })
    if (account.kind === 'created') return { explanation: 'error', forgot_password: 'error' }
  }
  if (settings.sendsBookingConfirmation) return { confirmation: 'skipped_flag' }
  try {
    const r = await d.sendManualBookingConfirmEmail(db, {
      locationId: request.location_id, contact, className: request.class_name, startsAt: request.starts_at,
      ...emailArgs, requestId: request.id,
    })
    return { confirmation: r?.sent ? 'sent' : (r?.reason || 'not_sent') }
  } catch (err) {
    logWarn(LOG, 'booking confirmation threw', { requestId: request.id, err })
    return { confirmation: 'send_error' }
  }
}

/**
 * Steps 2-6 (the account, credits or a membership, the trial, the booking),
 * shared by the funnel processor and the approval executor (UN1TWRITE.23).
 * Each step resumes from the ledger. Never files a card or stamps the row:
 * the caller maps the answer.
 * trialMode 'normal' grants the trial when nothing else books; 'credits_only'
 * (approving un1t_trial_unverified) never buys: no credits is a card.
 * @returns {Promise<{ kind: 'booked', account: object, booking: object, executingContactId: string, steps: object }
 *   | { kind: 'card', reason: string, executingContactId?: string, steps: object }
 *   | { kind: 'retry', code: string, executingContactId?: string, steps: object }
 *   | { kind: 'trial_used', account: object, executingContactId: string, steps: object }>}
 */
export async function un1tBookOnce(db, { request, contact, organizationId, eventId, origin, originRef, actor, writer, trialMode = 'normal', paidTrialText = null }, deps = {}) {
  const d = depsOf(deps)
  const steps = {}
  const opDeps = { writerFactory: async () => writer }

  const account = await d.ensureUn1tAccount(db, {
    locationId: request.location_id, organizationId, contact, request, origin, originRef, actor,
  }, opDeps)
  steps.account = account.kind
  if (account.kind === 'retry') return { kind: 'retry', code: account.code, steps }
  if (account.kind === 'card') return { kind: 'card', reason: account.reason, steps }
  const executingContactId = account.executingContactId
  const un1tUserId = account.un1tUserId

  let ledger
  try {
    ledger = await writer.read(`/credits/ledgers/${encodeURIComponent(un1tUserId)}/${encodeURIComponent(writer.studioId)}`)
  } catch {
    return { kind: 'retry', code: 'credits_unreadable', executingContactId, steps }
  }
  const balance = typeof ledger?.balance === 'number' ? ledger.balance : null
  const hasCredits = ledger?.is_unlimited === true || (balance != null && balance >= 1)
  let hasMembership = false
  if (!hasCredits) {
    const { data: subs, error: sErr } = await db.from('un1t_subscriptions')
      .select('un1t_id').eq('location_id', request.location_id).eq('un1t_user_id', un1tUserId)
      .in('status', [...MEMBERSHIP_ACTIVE_STATUSES]).limit(1)
    if (sErr) return { kind: 'retry', code: 'subscriptions_unreadable', executingContactId, steps }
    hasMembership = Array.isArray(subs) && subs.length > 0
  }

  if (hasCredits || hasMembership) {
    steps.trial = hasCredits ? 'skipped_credits' : 'skipped_membership'
  } else if (paidTrialText) {
    // PAIDTRIALONLY.1 — the studio sells a paid trial instead: no free one.
    steps.trial = 'paid_trial_only'
    return { kind: 'paid_trial', executingContactId, steps }
  } else if (trialMode === 'credits_only') {
    steps.trial = 'unverified_no_credits'
    return { kind: 'card', reason: 'un1t_trial_unverified', executingContactId, steps }
  } else {
    const t = await d.grantTrial(db, {
      locationId: request.location_id, un1tUserId, contactId: executingContactId, origin, originRef, actor,
    }, opDeps)
    steps.trial = t.outcome === 'granted' ? `granted:${t.method}` : t.outcome === 'ineligible' ? `ineligible:${t.reason}` : t.outcome === 'retry' ? `retry:${t.code}` : t.reason
    if (t.outcome === 'retry') return { kind: 'retry', code: t.code, executingContactId, steps }
    if (t.outcome === 'needs_staff') return { kind: 'card', reason: t.reason, executingContactId, steps }
    if (t.outcome === 'ineligible') return { kind: 'trial_used', account, executingContactId, steps }
  }

  const b = await d.book(db, {
    locationId: request.location_id, contactId: executingContactId, un1tUserId, eventId, origin, originRef, actor,
  }, opDeps)
  steps.book = b.verdict === 'done' ? (b.alreadyBooked ? 'already_booked' : 'done') : `${b.verdict}${b.code ? `:${b.code}` : ''}`
  if (b.verdict === 'refused' && b.retryable) return { kind: 'retry', code: b.code, executingContactId, steps }
  if (b.verdict === 'refused') return { kind: 'card', reason: `un1t_booking_failed:${b.code ?? 'unknown'}`, executingContactId, steps, booking: b }
  if (b.verdict !== 'done') return { kind: 'card', reason: 'un1t_outcome_unknown', executingContactId, steps, booking: b }
  return { kind: 'booked', account, booking: b, executingContactId, steps }
}

/**
 * @param {object} db
 * @param {object} request a class_booking_requests row
 * @param {{ settings: object, studioName?: string|null, organizationId: string|null }} ctx readUn1tWriteSettings' answer
 * @returns {Promise<{ outcome: 'booked'|'needs_review'|'failed', detail?: string }>}
 */
export async function processUn1tClassBookingRequest(db, request, ctx, deps = {}) {
  // Mark the row as the un1t.online processor's before anything else, so a
  // job that dies mid-run is carded for the un1t.online executor by the
  // reaper (process-class-bookings) too.
  await stampRow(db, request.id, { un1t_steps: { at: new Date((deps.now ?? Date.now)()).toISOString() } })
  const holder = { executingContactId: null }
  try {
    return await runFunnel(db, request, ctx, deps, holder)
  } catch (err) {
    // Every throw is the queue's retry signal and must carry the provider,
    // or the card filed at the cap would run the Glofox executor (D-8).
    if (err instanceof Un1tFunnelRetry) throw err
    logWarn(LOG, 'funnel step failed; the queue retries', { requestId: request.id, err })
    const wrapped = new Un1tFunnelRetry(err?.code ?? err?.name ?? 'error', { executingContactId: holder.executingContactId })
    wrapped.cause = err
    throw wrapped
  }
}

async function runFunnel(db, request, ctx, deps, holder) {
  const d = depsOf(deps)
  const { settings, organizationId } = ctx
  const steps = { at: new Date(d.now()).toISOString() }
  let executingContactId = null
  const card = async (reason, { rowStatus, rowLastError } = {}) => {
    await stampRow(db, request.id, { un1t_steps: { ...steps, card: reason } })
    return d.routeToReview(db, request, reason, {
      provider: UN1T_PROVIDER, executingContactId,
      ...(rowStatus ? { rowStatus } : {}), ...(rowLastError ? { rowLastError } : {}),
    })
  }
  const retry = (code) => new Un1tFunnelRetry(code, { executingContactId })

  // 1. Preflight: the class, then the person.
  // 'un1t:<id>' from the listing; a bare uuid from a request filed before
  // HATCHSTART.1's prefix.
  const rawId = String(request.glofox_event_id || '')
  const eventId = un1tEventIdOf(rawId) ?? (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId) ? rawId : null)
  if (!eventId) return card('class_unavailable')
  const { data: event, error: evErr } = await db.from('un1t_events')
    .select('un1t_id, title, status, starts_at, synced_at').eq('location_id', request.location_id).eq('un1t_id', eventId).maybeSingle()
  if (evErr) throw retry('event_unreadable')
  // UN1TBOOK.20 — a class removed in un1t.online (cancelled, or not in the
  // latest pull: the mirror never deletes) only 404s there. Staff offer
  // another class; nothing reaches un1t.online and no trial is granted.
  if (!event || event.status === 'cancelled') return card(UN1T_CLASS_GONE)
  const startsMs = Date.parse(event.starts_at)
  if (event.status !== 'scheduled' || !Number.isFinite(startsMs) || startsMs <= d.now()) return card('class_unavailable')
  let cutoff
  try {
    cutoff = await freshCutoff(db, 'un1t_events', request.location_id)
  } catch {
    throw retry('event_freshness_unreadable')
  }
  if (cutoff && !(Date.parse(event.synced_at) >= Date.parse(cutoff))) return card(UN1T_CLASS_GONE)

  const { data: contact, error: cErr } = await db.from('contacts')
    .select('id, organization_id, first_name, last_name, name, email, phone, un1t_user_id, ctwa_clid')
    .eq('id', request.contact_id).maybeSingle()
  if (cErr) throw retry('contact_unreadable')
  if (!contact) {
    await stampRow(db, request.id, { status: 'failed', last_error: 'contact_missing' })
    return { outcome: 'failed', detail: 'contact_missing' }
  }
  if (typeof contact.email !== 'string' || !contact.email.trim()) return card('no_email')

  // PAIDTRIALONLY.1 — read before any write: an unreadable setting retries
  // rather than give a free trial the studio may have retired.
  let paidTrialText
  try {
    paidTrialText = await d.readPaidTrialReply(db, request.location_id)
  } catch {
    throw retry('paid_trial_reply_unreadable')
  }

  // One writer for the whole job.
  const writer = await d.writerFactory(db, request.location_id)
  const once = await un1tBookOnce(db, {
    request, contact, organizationId, eventId, origin: 'funnel', originRef: request.id, actor: null, writer, paidTrialText,
  }, deps)
  Object.assign(steps, once.steps)
  executingContactId = once.executingContactId ?? null
  holder.executingContactId = executingContactId
  if (once.kind === 'retry') throw retry(once.code)
  if (once.kind === 'card') return card(once.reason)
  if (once.kind === 'paid_trial') {
    const { closeWithPaidTrialReply } = await import('./class-booking-processor.js')
    return closeWithPaidTrialReply(db, request, paidTrialText, {
      stamp: (_db, id, fields) => stampRow(db, id, { ...fields, un1t_steps: steps }),
      notify: d.notifyFlowBookingOutcome,
    })
  }
  if (once.kind === 'trial_used') {
    const hand = await d.trialUsedHandoff(db, { request, contact, locationId: request.location_id }).catch(() => ({ handled: false }))
    if (hand?.handled) {
      await stampRow(db, request.id, { status: 'failed', last_error: 'trial_used_handed_to_mia', un1t_steps: { ...steps, trial_used: 'handed_to_mia' } })
      return { outcome: 'failed', detail: 'trial_used_handed_to_mia' }
    }
    const studio = await readStudioContext(db, request.location_id)
    let mail
    try {
      mail = await d.sendUn1tTrialUsedEmail(db, {
        locationId: request.location_id, contact, className: request.class_name, startsAt: request.starts_at,
        blocks: studio.blocks, studioName: studio.studioName || ctx.studioName, zone: studio.zone,
      })
    } catch {
      mail = { sent: false, reason: 'send_error' }
    }
    steps.trial_used_email = mail?.sent ? 'sent' : (mail?.reason || 'not_sent')
    await card('un1t_trial_used', { rowStatus: 'failed', rowLastError: 'trial_used_options_sent' })
    return { outcome: 'failed', detail: 'trial_used_options_sent' }
  }
  const { account, booking: b } = once

  const bookingRef = b.id ? `un1t:${b.id}` : null
  if (!bookingRef) logWarn(LOG, 'booked with no booking id; the next sync names it', { requestId: request.id, code: 'no_booking_id' })
  await stampRow(db, request.id, { status: 'booked', last_error: null, glofox_booking_id: bookingRef, un1t_steps: steps })

  // 7. Emails.
  const studio = await readStudioContext(db, request.location_id)
  Object.assign(steps, await un1tAfterBooking(db, {
    request, contact, account, settings, studio: { ...studio, studioName: studio.studioName || ctx.studioName }, origin: 'funnel', writer,
  }, deps))
  await stampRow(db, request.id, { un1t_steps: steps })

  // FLOWACK.1 — a booking made through the WhatsApp Flow is confirmed on the
  // customer's thread too (un1t.online sends no WhatsApp; a no-op for a
  // website row). A card is told by routeToReview. Never changes the outcome.
  try {
    await d.notifyFlowBookingOutcome(db, request, { outcome: 'booked' })
  } catch (err) { logWarn(LOG, 'flow outcome notice failed; the booking stands', { requestId: request.id, err }) }

  // 8. Conversions, as the Glofox tail.
  try {
    await d.sendCtwaConversion(db, { locationId: request.location_id, contactId: request.contact_id, eventName: 'Schedule', contentName: request.class_name || 'Class' })
  } catch (err) { logWarn(LOG, 'ctwa conversion failed', { err }) }
  try {
    if (!contact.ctwa_clid) {
      const { classFunnelConfigFromBlocks } = await import('./public-landing.js')
      await d.sendWebsiteConversion(db, {
        locationId: request.location_id, eventName: 'Schedule', email: contact.email, phone: contact.phone,
        eventSourceUrl: studio.publicPath ? classFunnelConfigFromBlocks(studio.blocks, studio.publicPath).eventSourceUrl : undefined,
        eventId: `classbooking-${request.id}`, contentName: request.class_name || 'Class',
        firstName: contact.first_name, lastName: contact.last_name, externalId: contact.id,
      })
    }
  } catch (err) { logWarn(LOG, 'website conversion failed', { err }) }

  return { outcome: 'booked', detail: bookingRef ?? 'booked' }
}
