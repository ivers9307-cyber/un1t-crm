// FEES.1 — the class-fees I/O: find the night's offences, email the review
// contacts, charge what is due, and the staff actions (waive, retry).
// The rules are pure in class-fees.js; the un1t.online charge is
// chargeClassFee (un1t-online-write-ops.js), the ONLY place a fee is charged.
//
// Every class_fees state change is a compare-and-set on the status it was
// read in (`.eq('status', prev)` + `.select('id')`), so a waive racing the
// 17:00 claim, or two runs on one row, can never both win: the loser sees
// zero rows and does nothing.

import { createUn1tWriter } from './un1t-online-write.js'
import { chargeClassFee } from './un1t-online-write-ops.js'
import { readUn1tWriteSettings } from './un1t-online-settings.js'
import {
  classFeeSettingsFrom,
  classifyBooking,
  penaltyFor,
  buildFeeRow,
  patchAfterCharge,
  localHourIn,
  CLASS_FEE_DEFAULTS,
  WAIVABLE_STATUSES,
  RETRYABLE_STATUSES,
  OPEN_FEE_STATUSES,
  classFeeKindLabel,
} from './class-fees.js'
import { getLocationZone, dateKeyIn, addDaysIn, dayStartMsIn, formatInZone } from './location-time.js'
import { loadForgivenessFacts, decideForgiveness, forgivenessReason } from './class-fees-forgiveness.js'
import { exemptContactIds, waiveFeesOfExempt, EXEMPT_REASON } from './class-fees-exemptions.js'
import { selectAll } from './select-all.js'
import { sendTransactionalEmail } from './postmark.js'
import { escapeHtml } from './html-escape.js'
import { getAppUrl } from './app-url.js'
import { logError, logInfo, logWarn } from './log'

const LOG_MODULE = 'class-fees'
const ID_CHUNK = 100
// One run charges at most this many fees per studio; the rest wait an hour.
const CHARGE_BATCH = 40

const FEE_COLUMNS =
  'id, location_id, contact_id, un1t_user_id, un1t_booking_id, un1t_event_id, class_title, starts_at, class_day, kind, cancelled_at, minutes_before_start, penalty, amount_cents, currency, charge_description, status, attempts, charge_due_at, next_attempt_at, charge_started_at, charged_at, un1t_transaction_id, failure_code, failure_message, waived_by, waived_reason, waived_at, waive_rule, notice_sent_at, appeal_reason, appeal_text, appealed_at, created_at, updated_at'

const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/** The studio's fee settings and zone. Throws on a read failure. */
export async function readClassFeeContext(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id, name, organization_id, membership_source, settings')
    .eq('id', locationId)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`class fees: location read failed (${error.code ?? 'no code'})`), { code: error.code })
  if (!data) throw new Error('class fees: location not found')
  const zone = await getLocationZone(db, locationId)
  return {
    location: { id: data.id, name: data.name, organizationId: data.organization_id, membershipSource: data.membership_source },
    settings: classFeeSettingsFrom(data.settings),
    zone,
  }
}

/** un1t.online's own late-cancel window (hours) for the studio, or null. */
async function readWindowHours(writer) {
  if (!writer?.studioId) return null
  try {
    const studio = await writer.read(`/studios/${encodeURIComponent(writer.studioId)}`)
    const h = Number(studio?.default_cancelation_window_hours)
    return Number.isFinite(h) && h > 0 ? h : null
  } catch (err) {
    logWarn(LOG_MODULE, 'could not read the un1t.online cancel window', { locationId: writer.locationId, code: err?.code ?? 'window_read_failed' })
    return null
  }
}

// ── detection ──────────────────────────────────────────────────────────────

/**
 * The offences among classes that started yesterday or today (studio time)
 * and before `nowMs`. New ones are inserted (pending or recorded); a fee
 * already on file is never touched (ignoreDuplicates), so a re-run is safe.
 * Yesterday is re-read so a class after the 23:00 run, a no-show marked late,
 * or a missed run is caught the next night.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, inserted: number, undecided: Array<object>,
 *   windowHours: number|null, classes: number }>}
 */
export async function detectClassFees(db, { locationId, nowMs = Date.now() }, deps = {}) {
  const { writerFactory = createUn1tWriter } = deps
  const ctx = await readClassFeeContext(db, locationId)
  const { settings, zone } = ctx
  const writer = await writerFactory(db, locationId)
  const windowHours = await readWindowHours(writer)

  // FEES.3 — while charging is paused nothing at the studio may be left due:
  // a pending fee written by older code (before previews existed) becomes a
  // preview too, so un-pausing can never charge the dry run.
  if (settings.chargingPaused) {
    const { error: pvErr } = await db
      .from('class_fees')
      .update({ status: 'preview' })
      .eq('location_id', locationId)
      .eq('status', 'pending')
      .select('id')
    if (pvErr) throw Object.assign(new Error(`class fees: preview sweep failed (${pvErr.code ?? 'no code'})`), { code: pvErr.code })
  }

  const today = dateKeyIn(nowMs, zone)
  const fromMs = dayStartMsIn(addDaysIn(today, -1, zone), zone)
  const events = await selectAll((from, to) => db
    .from('un1t_events')
    .select('un1t_id, title, status, starts_at')
    .eq('location_id', locationId)
    .gte('starts_at', new Date(fromMs).toISOString())
    .lte('starts_at', new Date(nowMs).toISOString())
    .order('starts_at')
    .order('un1t_id')
    .range(from, to))
  const eventById = new Map(events.map((e) => [e.un1t_id, e]))

  const bookings = []
  for (const ids of chunk([...eventById.keys()], ID_CHUNK)) {
    const rows = await selectAll((from, to) => db
      .from('un1t_bookings')
      .select('un1t_id, un1t_user_id, contact_id, event_id, status, credit_charged, cancelled_at')
      .eq('location_id', locationId)
      .in('event_id', ids)
      .order('un1t_id')
      .range(from, to))
    bookings.push(...rows)
  }

  // Cancels staff made from the CRM are never fined.
  const cancelledIds = bookings.filter((b) => /^cancel/i.test(String(b.status ?? ''))).map((b) => b.un1t_id)
  const staffCancelled = new Set()
  for (const ids of chunk(cancelledIds, ID_CHUNK)) {
    const { data, error } = await db
      .from('un1t_write_events')
      .select('target')
      .eq('location_id', locationId)
      .eq('op', 'cancel')
      .eq('stage', 'done')
      .eq('origin', 'staff')
      .in('target', ids)
      .limit(ID_CHUNK)
    if (error) throw Object.assign(new Error(`class fees: staff-cancel read failed (${error.code ?? 'no code'})`), { code: error.code })
    for (const r of data || []) staffCancelled.add(r.target)
  }

  const userIds = [...new Set(bookings.map((b) => b.un1t_user_id).filter(Boolean))]
  const clientByUser = new Map()
  for (const ids of chunk(userIds, ID_CHUNK)) {
    const { data, error } = await db
      .from('un1t_clients')
      .select('un1t_user_id, credit_unlimited')
      .eq('location_id', locationId)
      .in('un1t_user_id', ids)
      .limit(ID_CHUNK)
    if (error) throw Object.assign(new Error(`class fees: client read failed (${error.code ?? 'no code'})`), { code: error.code })
    for (const c of data || []) clientByUser.set(c.un1t_user_id, c)
  }

  const rows = []
  const undecided = []
  for (const b of bookings) {
    const event = eventById.get(b.event_id)
    if (!event || !b.un1t_user_id) continue
    const classified = classifyBooking(b, event, { windowHours, nowMs, staffCancelled: staffCancelled.has(b.un1t_id) })
    if (!classified) continue
    if (classified.undecided) {
      undecided.push({ bookingId: b.un1t_id, contactId: b.contact_id ?? null, classTitle: event.title ?? null, startsAt: event.starts_at })
      continue
    }
    const row = buildFeeRow({
      locationId, contactId: b.contact_id, booking: b, event, classified,
      penalty: penaltyFor(b, clientByUser.get(b.un1t_user_id)), settings, zone, nowMs,
    })
    if (row) rows.push(row)
  }

  // FEES.2 — automatic forgiveness: a forgiven fee is written as waived, with
  // the rule that forgave it, so staff can see it on the History tab.
  const forgiven = await forgive(db, { locationId, zone, settings, rows, nowMs })

  let inserted = 0
  for (const part of chunk(rows, 200)) {
    const { data, error } = await db
      .from('class_fees')
      .upsert(part, { onConflict: 'location_id,un1t_booking_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw Object.assign(new Error(`class fees: insert failed (${error.code ?? 'no code'})`), { code: error.code })
    inserted += (data || []).length
  }

  if (windowHours == null) {
    logWarn(LOG_MODULE, 'no un1t.online cancel window; late cancels were not judged this run', { locationId })
  }
  return { ok: true, inserted, forgiven, undecided, windowHours, classes: events.length, today, zone, settings, location: ctx.location }
}

/** Mark the forgiven fee rows (in place) and count them. */
async function forgive(db, { locationId, zone, settings, rows, nowMs }) {
  const all = rows.filter((r) => r.penalty === 'fee')
  if (!all.length) return 0
  // FEES.4 — an exempt member is never charged: waived first, by name.
  const exempt = await exemptContactIds(db, locationId, all.map((r) => r.contact_id))
  const at0 = new Date(nowMs).toISOString()
  let exempted = 0
  for (const r of all) {
    if (!r.contact_id || !exempt.has(r.contact_id)) continue
    Object.assign(r, { status: 'waived', waive_rule: 'exempt', waived_reason: EXEMPT_REASON, waived_at: at0, waived_by: null })
    exempted++
  }
  const fees = all.filter((r) => r.waive_rule !== 'exempt')
  if (!fees.length) return exempted
  const offences = fees.map((r) => ({
    bookingId: r.un1t_booking_id, un1tUserId: r.un1t_user_id, eventId: r.un1t_event_id,
    kind: r.kind, startsAt: r.starts_at, cancelledAt: r.cancelled_at,
  }))
  const rules = settings.forgiveness
  const facts = await loadForgivenessFacts(db, { locationId, rules, offences })
  const decided = decideForgiveness({ offences, facts, rules, zone })
  const at = new Date(nowMs).toISOString()
  let n = 0
  for (const r of fees) {
    const rule = decided.get(r.un1t_booking_id)
    if (!rule) continue
    Object.assign(r, { status: 'waived', waive_rule: rule, waived_reason: forgivenessReason(rule), waived_at: at, waived_by: null })
    n++
  }
  return n + exempted
}

/**
 * FEES.4 — the fees of members exempted since they were found are waived,
 * never claimed. → the fees still to charge.
 */
async function dropExempt(db, locationId, fees, nowMs) {
  const exempt = await exemptContactIds(db, locationId, fees.map((f) => f.contact_id))
  if (!exempt.size) return fees
  await waiveFeesOfExempt(db, { locationId, contactIds: [...exempt], nowMs })
  return fees.filter((f) => !f.contact_id || !exempt.has(f.contact_id))
}

// ── the nightly email ─────────────────────────────────────────────────────

const euro = (cents) => `€${(Number(cents || 0) / 100).toFixed(2)}`

/**
 * The review email for one studio. Pure: { subject, htmlBody }.
 * Never names a member in the subject; the body names them for staff.
 */
export function buildReviewEmail({ studioName, dayLabel, dueFees, recorded, undecided, outstandingCount, reviewUrl, chargeLabel, forgiven = 0, dryRun = false, noticesSent = 0 }) {
  const total = dueFees.reduce((s, f) => s + (f.amount_cents || 0), 0)
  const subject = dryRun
    ? `Class fees for ${dayLabel} (dry run): ${dueFees.length} would be charged`
    : `Class fees for ${dayLabel}: ${dueFees.length} to charge at ${chargeLabel}`
  const rows = dueFees.map((f) => `<tr><td style="padding:4px 8px">${escapeHtml(f.member_name || 'Member')}</td><td style="padding:4px 8px">${escapeHtml(classFeeKindLabel(f.kind))}</td><td style="padding:4px 8px">${escapeHtml(f.charge_description || '')}</td><td style="padding:4px 8px;text-align:right">${escapeHtml(euro(f.amount_cents))}</td></tr>`).join('')
  const htmlBody = [
    dryRun
      ? `<p>${escapeHtml(studioName)} (dry run, charging paused): ${dueFees.length} fee(s) totalling ${escapeHtml(euro(total))} would be charged. Nothing is charged and no member is emailed while charging is paused.</p>`
      : `<p>${escapeHtml(studioName)}: ${dueFees.length} fee(s) totalling ${escapeHtml(euro(total))} will be charged at ${escapeHtml(chargeLabel)} unless waived.</p>`,
    noticesSent ? `<p>${noticesSent} member(s) were emailed about their fee.</p>` : '',
    dueFees.length ? `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` : '<p>No fees to charge tonight.</p>',
    recorded ? `<p>${recorded} pack credit(s) kept by un1t.online (recorded only, nothing charged).</p>` : '',
    forgiven ? `<p>${forgiven} fee(s) forgiven automatically by the studio's rules (see History).</p>` : '',
    undecided ? `<p>${undecided} booking(s) are still marked booked after the class. Mark them attended or no-show in un1t.online; they are never charged while undecided.</p>` : '',
    outstandingCount ? `<p>${outstandingCount} fee(s) are outstanding after two refused charges.</p>` : '',
    `<p><a href="${escapeHtml(reviewUrl)}">Review and waive fees</a></p>`,
  ].join('\n')
  return { subject, htmlBody }
}

/** Send the nightly review email. Never throws; returns { sent, reason? }. */
export async function sendReviewEmail(db, { locationId, location, settings, zone, nowMs, undecidedCount, forgivenCount = 0, noticesSent = 0 }) {
  if (!settings.reviewEmails.length) return { sent: false, reason: 'no_recipients' }
  try {
    // A paused night lists its previews (yesterday and today only: a preview
    // is never charged, so older ones would repeat every night).
    const dryRun = settings.chargingPaused
    let dueQ = db
      .from('class_fees')
      .select('id, contact_id, kind, amount_cents, charge_description')
      .eq('location_id', locationId)
      .eq('status', dryRun ? 'preview' : 'pending')
    if (dryRun) dueQ = dueQ.gte('class_day', addDaysIn(dateKeyIn(nowMs, zone), -1, zone))
    const { data: due, error } = await dueQ
      .order('starts_at')
      .limit(500)
    if (error) throw error
    const { count: recorded } = await db
      .from('class_fees')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('status', 'recorded')
      .eq('class_day', dateKeyIn(nowMs, zone))
    const { count: outstanding } = await db
      .from('class_fees')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('status', 'outstanding')
    const names = await contactNames(db, locationId, (due || []).map((f) => f.contact_id))
    const dueFees = (due || []).map((f) => ({ ...f, member_name: names.get(f.contact_id) ?? null }))
    const { subject, htmlBody } = buildReviewEmail({
      studioName: location.name || 'Studio',
      dayLabel: formatInZone(nowMs, zone, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, ''),
      dueFees,
      recorded: recorded || 0,
      undecided: undecidedCount || 0,
      forgiven: forgivenCount || 0,
      dryRun,
      noticesSent,
      outstandingCount: outstanding || 0,
      reviewUrl: `${getAppUrl()}/class-fees`,
      chargeLabel: `${String(settings.chargeHour).padStart(2, '0')}:00 tomorrow`,
    })
    let sent = 0
    for (const to of settings.reviewEmails) {
      try {
        await sendTransactionalEmail({ to, subject, htmlBody, locationId, tag: 'class-fees-review' })
        sent++
      } catch (err) {
        logError(LOG_MODULE, 'review email failed', { locationId, code: err?.code ?? err?.name ?? 'send_failed' })
      }
    }
    return { sent: sent > 0, recipients: sent }
  } catch (err) {
    logError(LOG_MODULE, 'review email could not be built', { locationId, code: err?.code ?? 'build_failed' })
    return { sent: false, reason: 'build_failed' }
  }
}

/** contact id → display name, scoped to the studio's organisation reads. */
export async function contactNames(db, locationId, contactIds) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  const out = new Map()
  for (const part of chunk(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('contacts')
      .select('id, first_name, last_name')
      .in('id', part)
      .limit(ID_CHUNK)
    if (error) {
      logWarn(LOG_MODULE, 'contact names unreadable', { locationId, code: error.code ?? null })
      continue
    }
    for (const c of data || []) out.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || null)
  }
  return out
}

// ── charging ───────────────────────────────────────────────────────────────

/**
 * Claim one fee for an attempt: a compare-and-set from the status (and, for a
 * resume, the claim time) it was read in. → the claimed row or null.
 */
async function claimFee(db, fee, { nowIso }) {
  const resume = fee.status === 'charging'
  const attempts = resume ? Math.max(1, fee.attempts) : fee.attempts + 1
  let q = db
    .from('class_fees')
    .update({ status: 'charging', charge_started_at: nowIso, attempts })
    .eq('id', fee.id)
    .eq('location_id', fee.location_id)
    .eq('status', fee.status)
    .eq('attempts', fee.attempts)
  if (resume) q = fee.charge_started_at ? q.eq('charge_started_at', fee.charge_started_at) : q.is('charge_started_at', null)
  const { data, error } = await q.select(FEE_COLUMNS)
  if (error) throw Object.assign(new Error(`class fees: claim failed (${error.code ?? 'no code'})`), { code: error.code })
  return data && data.length === 1 ? { row: data[0], resume } : null
}

// The status a resumed attempt was claimed from: its first attempt came from
// pending, every later one from a retry.
const resumedFrom = (fee) => (fee.attempts <= 1 ? 'pending' : 'retry_scheduled')

/**
 * Charge one claimed fee and write the outcome. Never throws for a
 * un1t.online answer; a database error on the outcome write is logged (the
 * row stays `charging` and the next run resumes the same key, which
 * un1t.online answers with the same transaction).
 */
async function chargeClaimed(db, claimed, { prevStatus, origin, actor, settings, zone, nowMs }, deps) {
  const fee = claimed.row
  let r
  try {
    r = await chargeClassFee(db, {
      locationId: fee.location_id, contactId: fee.contact_id, un1tUserId: fee.un1t_user_id, feeId: fee.id,
      attempt: fee.attempts, amountCents: fee.amount_cents, description: fee.charge_description,
      origin, actor, resume: claimed.resume,
    }, deps)
  } catch (err) {
    // Nothing was sent (settings or ledger unreadable, or a programming error).
    logError(LOG_MODULE, 'charge threw before sending', { locationId: fee.location_id, feeId: fee.id, code: err?.code ?? err?.name ?? 'threw' })
    r = { verdict: 'refused', code: err?.code ?? 'charge_threw', message: null, retryable: true }
  }
  const from = claimed.resume ? resumedFrom(fee) : prevStatus
  const patch = patchAfterCharge(r, { prevStatus: from, origin, nowMs, settings, zone })
  const { releaseAttempt, ...cols } = patch
  if (releaseAttempt) {
    if (claimed.resume) {
      // A resume that sent nothing stays in doubt for the next run.
      cols.status = 'charging'
      cols.charge_started_at = fee.charge_started_at
    } else {
      cols.attempts = fee.attempts - 1
    }
  }
  const { data, error } = await db
    .from('class_fees')
    .update(cols)
    .eq('id', fee.id)
    .eq('location_id', fee.location_id)
    .eq('status', 'charging')
    .select('id, status')
  if (error || !data?.length) {
    logError(LOG_MODULE, 'charge outcome not recorded; the next run resumes the same key', {
      locationId: fee.location_id, feeId: fee.id, verdict: r?.verdict ?? null, code: error?.code ?? 'zero_rows',
    })
  }
  return { feeId: fee.id, verdict: r?.verdict ?? 'unknown', status: cols.status, code: r?.code ?? null, message: r?.message ?? null }
}

/**
 * Charge every fee due at the studio: pending past its due time, a retry past
 * its date, and any charge left in doubt for over 15 minutes (resumed with the
 * same key). Gated by the fee switch, the pause switch and un1t.online writes.
 */
export async function chargeDueClassFees(db, { locationId, nowMs = Date.now(), settings, zone }, deps = {}) {
  const nowIso = new Date(nowMs).toISOString()
  const staleIso = new Date(nowMs - CLASS_FEE_DEFAULTS.staleChargingMs).toISOString()
  const { data, error } = await db
    .from('class_fees')
    .select(FEE_COLUMNS)
    .eq('location_id', locationId)
    .eq('penalty', 'fee')
    .or(`and(status.eq.pending,charge_due_at.lte.${nowIso}),and(status.eq.retry_scheduled,next_attempt_at.lte.${nowIso}),and(status.eq.charging,charge_started_at.lt.${staleIso})`)
    .order('created_at')
    .order('id')
    .limit(CHARGE_BATCH)
  if (error) throw Object.assign(new Error(`class fees: due read failed (${error.code ?? 'no code'})`), { code: error.code })
  const outcomes = []
  for (const fee of await dropExempt(db, locationId, data || [], nowMs)) {
    const claimed = await claimFee(db, fee, { nowIso })
    if (!claimed) continue
    outcomes.push(await chargeClaimed(db, claimed, { prevStatus: fee.status, origin: 'fee_run', actor: null, settings, zone, nowMs }, deps))
  }
  const count = (v) => outcomes.filter((o) => o.status === v).length
  return { attempted: outcomes.length, charged: count('charged'), retry_scheduled: count('retry_scheduled'), outstanding: count('outstanding'), in_doubt: count('charging') }
}

// ── staff actions ──────────────────────────────────────────────────────────

/**
 * Waive one fee. → { ok, status } | { ok: false, reason: 'not_found'|'not_waivable' }.
 * not_found when the fee is not at this studio (the route answers 404).
 */
export async function waiveClassFee(db, { locationId, feeId, actorId, reason }) {
  const { data: fee, error } = await db
    .from('class_fees')
    .select('id, status')
    .eq('id', feeId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`class fees: read failed (${error.code ?? 'no code'})`), { code: error.code })
  if (!fee) return { ok: false, reason: 'not_found' }
  if (!WAIVABLE_STATUSES.includes(fee.status)) return { ok: false, reason: 'not_waivable', status: fee.status }
  const { data, error: upErr } = await db
    .from('class_fees')
    .update({ status: 'waived', waived_by: actorId, waived_reason: String(reason).slice(0, 500), waived_at: new Date().toISOString(), next_attempt_at: null })
    .eq('id', feeId)
    .eq('location_id', locationId)
    .eq('status', fee.status)
    .select('id')
  if (upErr) throw Object.assign(new Error(`class fees: waive failed (${upErr.code ?? 'no code'})`), { code: upErr.code })
  if (!data?.length) return { ok: false, reason: 'not_waivable' }
  logInfo(LOG_MODULE, 'fee waived', { locationId, feeId })
  return { ok: true, status: 'waived' }
}

/**
 * The profile's "Retry charge": one attempt for each of the contact's
 * retryable fees at this studio, each with its own description.
 */
export async function retryContactFees(db, { locationId, contactId, actor, nowMs = Date.now() }, deps = {}) {
  const ctx = await readClassFeeContext(db, locationId)
  const { data, error } = await db
    .from('class_fees')
    .select(FEE_COLUMNS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
    .eq('penalty', 'fee')
    .in('status', RETRYABLE_STATUSES)
    .order('starts_at')
    .limit(50)
  if (error) throw Object.assign(new Error(`class fees: retry read failed (${error.code ?? 'no code'})`), { code: error.code })
  const nowIso = new Date(nowMs).toISOString()
  const outcomes = []
  for (const fee of await dropExempt(db, locationId, data || [], nowMs)) {
    const claimed = await claimFee(db, fee, { nowIso })
    if (!claimed) continue
    outcomes.push(await chargeClaimed(db, claimed, {
      prevStatus: fee.status, origin: 'staff', actor, settings: ctx.settings, zone: ctx.zone, nowMs,
    }, deps))
  }
  return { outcomes }
}

/** The open fees of one contact at one studio (the profile card). */
export async function contactOpenFees(db, { locationId, contactId }) {
  const { data, error } = await db
    .from('class_fees')
    .select(FEE_COLUMNS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
    .eq('penalty', 'fee')
    .in('status', OPEN_FEE_STATUSES)
    .order('starts_at', { ascending: false })
    .limit(100)
  if (error) throw Object.assign(new Error(`class fees: contact read failed (${error.code ?? 'no code'})`), { code: error.code })
  return data || []
}

export { FEE_COLUMNS, localHourIn }
