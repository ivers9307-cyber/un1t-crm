// TRIALABANDON.1 — the abandoned €39 checkout sweep. Every 2 minutes (an arm
// of the process-trial-purchases cron, heartbeat 'trial-checkout-abandoned-sweep')
// it does two things, for Stillorgan (Revolut) and Hatch Street (un1t.online)
// rows alike:
//
//   1. STOP ON PURCHASE. Anyone in a 'paid_trial_checkout_abandoned' sequence
//      who has since paid for a trial at that studio leaves it
//      (exit_reason 'trial_purchased'). A purchase is a paid trial_purchases
//      row, or at a un1t.online studio a paid-trial transaction in the mirror
//      (a trial bought in the app, which never touches trial_purchases).
//   2. ENROL. Each abandoned trial_purchases row of the last 72 hours that has
//      not been judged yet is offered, once, to the studio's active sequences
//      of that trigger, and stamped with what happened.
//
// ABANDONED means: status 'payment_failed' or 'expired'; or 'failed' with
// last_error 'checkout_not_opened'; or still 'awaiting_payment' an hour after
// it was created (ABANDON_WAIT_MS). 'help_requested', 'needs_review' and
// 'handled' rows are never abandoned: staff hold those.
//
// One person, one studio, one judgement: their unjudged abandoned rows are
// taken together. They are enrolled only when ALL hold:
//   - no trial_purchases row of theirs at that studio, created at or after
//     the oldest of those rows, is a purchase or in staff's hands;
//   - no 'enrolled' stamp of theirs at that studio in the last 14 days;
//   - they are not mid-checkout right now (an 'awaiting_payment' row younger
//     than the wait: judged on a later tick, nothing stamped);
//   - the studio's own eligibility read says they could still buy: no trial
//     history at a Glofox studio (stillorganTrialHistory), no active
//     membership and no paid-trial transaction at a un1t.online studio.
//
// A read that fails is "cannot tell", never "no purchase": that person is
// held (nothing stamped, judged again next tick) and the run reports not ok,
// so the heartbeat is not stamped. A failure of the sweep's own first reads
// places nobody. Every other outcome stamps abandon_followup_at +
// abandon_followup_outcome on the rows (mig 835), so a row is judged once and
// a studio that switches a sequence on later greets only checkouts abandoned
// from then on. The stamp is written AFTER the enrolment: enrolment is
// idempotent (one row per person per sequence), so a death in between is a
// retry, never a lost follow-up.
//
// This sweep sends nothing. The steps are sent by the sequence runner, which
// gates email and WhatsApp on the studio's MARKETING consent.

import { triggerSequencesForTrialCheckoutAbandoned } from '@/lib/sequences/triggers'
import { stillorganTrialHistory, hatchActiveMembership } from '@/lib/trial-eligibility'
import { paidTrialProductIdsFor } from '@/lib/paid-trial-products'
import { TRIAL_STUDIOS } from '@/lib/trial-studios'
import { ABANDONED_TRIGGER, isPurchaseRow, trialCheckoutFromEnrollment, exitEnrolmentForPurchase } from '@/lib/trial-abandoned-purchase'
import { logError } from '@/lib/log'

const MODULE = 'trial-checkout-abandoned'
export { ABANDONED_TRIGGER }
/** How long an unpaid checkout is left alone before it counts as abandoned. */
export const ABANDON_WAIT_MS = 60 * 60_000
/** Only rows created this recently are ever followed up. */
export const ABANDON_WINDOW_MS = 72 * 3_600_000
/** One follow-up per person per studio in this long. */
export const ABANDON_REPEAT_MS = 14 * 24 * 3_600_000
/** People judged per tick (each costs a handful of eligibility reads). */
export const MAX_CONTACTS_PER_TICK = 50
const PAGE = 500
const MAX_PAGES = 20
const IN_CHUNK = 100

const ROW_COLS = 'id, location_id, contact_id, status, payment_status, last_error, payment_provider, payment_checkout_token, landing_path, created_at, abandon_followup_at, abandon_followup_outcome'
const STAFF_STATUSES = new Set(['needs_review', 'help_requested', 'handled'])

const ms = (iso) => Date.parse(iso || '')
const keyOf = (locationId, contactId) => `${locationId}:${contactId}`

/** Pure: is this row an abandoned checkout at `nowMs`? */
export function isAbandonedCheckout(row, nowMs = Date.now()) {
  if (!row) return false
  if (row.status === 'payment_failed' || row.status === 'expired') return true
  if (row.status === 'failed') return row.last_error === 'checkout_not_opened'
  if (row.status !== 'awaiting_payment') return false
  const created = ms(row.created_at)
  return Number.isFinite(created) && nowMs - created >= ABANDON_WAIT_MS
}

// Still inside the wait: the buyer may be paying right now.
function isMidCheckout(row, nowMs) {
  if (row?.status !== 'awaiting_payment') return false
  const created = ms(row.created_at)
  return !Number.isFinite(created) || nowMs - created < ABANDON_WAIT_MS
}

function emptyCounts() {
  return {
    ok: true, locations: 0, candidates: 0, checked: 0, enrolled: 0, not_enrolled: 0, no_sequence: 0,
    purchased: 0, ineligible: 0, recent: 0, waiting: 0, held: 0, failed: 0, exited: 0, deferred: 0,
  }
}

// Every trial_purchases row of the last 14 days, oldest first (the repeat rule
// needs 14 days; candidates and blockers sit in the last 72 hours of it).
async function readRecentRows(db, nowMs) {
  const rows = []
  const since = new Date(nowMs - ABANDON_REPEAT_MS).toISOString()
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db
      .from('trial_purchases')
      .select(ROW_COLS)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) return { ok: false, code: error.code ?? null }
    rows.push(...(data || []))
    if ((data || []).length < PAGE) return { ok: true, rows }
  }
  // More rows than the sweep reads: "cannot tell", never a partial answer.
  return { ok: false, code: 'too_many_rows' }
}

// contact id -> ms of their newest paid-trial transaction in the un1t.online
// mirror since `sinceIso` (a trial bought in the app). { ok: false } when the
// product set or the transactions cannot be read.
async function readUn1tBuyers(db, locationId, sinceIso, productIdsFor) {
  try {
    const productIds = await productIdsFor(db, locationId)
    const buyers = new Map()
    if (!productIds || productIds.size === 0) return { ok: true, buyers }
    const { data, error } = await db
      .from('un1t_transactions')
      .select('id, contact_id, remote_created_at')
      .eq('location_id', locationId)
      .in('product_id', [...productIds])
      .gt('amount_cents', 0)
      .eq('refunded', false)
      .not('contact_id', 'is', null)
      .gte('remote_created_at', sinceIso)
      .order('remote_created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(0, 999)
    if (error) {
      logError(MODULE, 'un1t paid-trial transactions unreadable', { locationId, code: error.code ?? null })
      return { ok: false }
    }
    for (const t of data || []) {
      const at = ms(t.remote_created_at)
      if (!t?.contact_id || !Number.isFinite(at)) continue
      if (!(buyers.get(t.contact_id) >= at)) buyers.set(t.contact_id, at)
    }
    return { ok: true, buyers }
  } catch (e) {
    logError(MODULE, 'un1t paid-trial products unreadable', { locationId, errName: e?.name ?? null })
    return { ok: false }
  }
}

async function stamp(db, ids, outcome, nowMs, out) {
  if (ids.length === 0) return true
  try {
    const { error } = await db
      .from('trial_purchases')
      .update({ abandon_followup_at: new Date(nowMs).toISOString(), abandon_followup_outcome: outcome })
      .in('id', ids)
      .is('abandon_followup_at', null)
    if (!error) return true
    logError(MODULE, 'follow-up stamp failed; the rows are judged again next tick', { outcome, rows: ids.length, code: error.code ?? null })
  } catch (e) {
    logError(MODULE, 'follow-up stamp threw; the rows are judged again next tick', { outcome, rows: ids.length, errName: e?.name ?? null })
  }
  out.failed++
  out.ok = false
  return false
}

/**
 * @param {object} db service-role client
 * @param {{ nowMs?: number, trigger?: Function, glofoxHistory?: Function, un1tMembership?: Function, productIdsFor?: Function }} [opts]
 */
export async function sweepAbandonedTrialCheckouts(db, {
  nowMs = Date.now(),
  trigger = triggerSequencesForTrialCheckoutAbandoned,
  glofoxHistory = stillorganTrialHistory,
  un1tMembership = hatchActiveMembership,
  productIdsFor = paidTrialProductIdsFor,
} = {}) {
  const out = emptyCounts()
  const unreadable = (what, code) => {
    logError(MODULE, `${what} unreadable; nobody is enrolled or exited this run`, { code: code ?? null })
    out.ok = false
    return out
  }

  // ── The sweep's own reads. Any failure places nobody. ──
  const { data: sequences, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id, status')
    .eq('trigger_type', ABANDONED_TRIGGER)
    .order('id', { ascending: true })
    .range(0, 999)
  if (seqErr) return unreadable('sequences', seqErr.code)
  const seqLocation = new Map((sequences || []).filter((s) => s?.id && s.location_id).map((s) => [s.id, s.location_id]))
  const activeLocations = new Set((sequences || []).filter((s) => s?.status === 'active' && s.location_id).map((s) => s.location_id))
  out.locations = activeLocations.size

  const recent = await readRecentRows(db, nowMs)
  if (!recent.ok) return unreadable('trial purchases', recent.code)
  const rows = recent.rows

  const sequenceLocations = [...new Set(seqLocation.values())]
  const sourceOf = new Map()
  if (sequenceLocations.length > 0) {
    const { data: locs, error: locErr } = await db
      .from('locations')
      .select('id, membership_source')
      .in('id', sequenceLocations)
      .order('id', { ascending: true })
      .range(0, 999)
    if (locErr) return unreadable('locations', locErr.code)
    for (const l of locs || []) sourceOf.set(l.id, l.membership_source)
  }

  // Each person's rows at a studio, and their newest purchase there.
  const byPerson = new Map()
  const purchaseAt = new Map()
  for (const r of rows) {
    if (!r?.contact_id || !r.location_id) continue
    const key = keyOf(r.location_id, r.contact_id)
    if (!byPerson.has(key)) byPerson.set(key, [])
    byPerson.get(key).push(r)
    if (isPurchaseRow(r)) {
      const at = ms(r.created_at)
      if (Number.isFinite(at) && !(purchaseAt.get(key) >= at)) purchaseAt.set(key, at)
    }
  }
  // The un1t.online mirror, per studio, read at most once a tick.
  const un1tCache = new Map()
  const un1tBuyersAt = async (locationId) => {
    if (!un1tCache.has(locationId)) {
      un1tCache.set(locationId, await readUn1tBuyers(db, locationId, new Date(nowMs - ABANDON_REPEAT_MS).toISOString(), productIdsFor))
    }
    return un1tCache.get(locationId)
  }

  // ── 1. Stop on purchase ──
  if (seqLocation.size > 0) {
    const buyers = new Map(purchaseAt)
    for (const locationId of sequenceLocations) {
      if (sourceOf.get(locationId) !== 'un1t_online') continue
      const un1t = await un1tBuyersAt(locationId)
      if (!un1t.ok) { out.ok = false; continue }
      for (const [contactId, at] of un1t.buyers) {
        const key = keyOf(locationId, contactId)
        if (!(buyers.get(key) >= at)) buyers.set(key, at)
      }
    }
    const buyerContacts = [...new Set([...buyers.keys()].map((k) => k.slice(k.indexOf(':') + 1)))]
    const sequenceIds = [...seqLocation.keys()]
    for (let i = 0; i < buyerContacts.length; i += IN_CHUNK) {
      const { data: live, error: liveErr } = await db
        .from('sequence_enrollments')
        .select('id, sequence_id, contact_id, enrolled_at, metadata')
        .in('sequence_id', sequenceIds)
        .in('contact_id', buyerContacts.slice(i, i + IN_CHUNK))
        .in('status', ['active', 'paused'])
        .order('id', { ascending: true })
        .range(0, 999)
      if (liveErr) {
        logError(MODULE, 'live enrolments unreadable; nobody exited from this batch', { code: liveErr.code ?? null })
        out.ok = false
        continue
      }
      for (const e of live || []) {
        const bought = buyers.get(keyOf(seqLocation.get(e.sequence_id), e.contact_id))
        if (bought === undefined) continue
        // Only a purchase made at or after the checkout they were enrolled for.
        const since = ms(trialCheckoutFromEnrollment(e)?.created_at)
        if (Number.isFinite(since) && bought < since) continue
        const res = await exitEnrolmentForPurchase(db, e.id, nowMs)
        if (!res.ok) { out.failed++; out.ok = false } else if (res.exited) out.exited++
      }
    }
  }

  // ── 2. Enrol ──
  const windowStart = nowMs - ABANDON_WINDOW_MS
  const isCandidate = (r) => !r.abandon_followup_at && ms(r.created_at) >= windowStart && isAbandonedCheckout(r, nowMs)
  const orphans = rows.filter((r) => r && !r.contact_id && isCandidate(r)).map((r) => r.id)
  out.candidates += orphans.length
  await stamp(db, orphans, 'no_contact', nowMs, out)

  let judged = 0
  for (const mine of byPerson.values()) {
    const candidates = mine.filter(isCandidate)
    if (candidates.length === 0) continue
    out.candidates += candidates.length
    const ids = candidates.map((r) => r.id)
    const { location_id: locationId, contact_id: contactId } = candidates[0]

    if (!activeLocations.has(locationId)) {
      if (await stamp(db, ids, 'no_active_sequence', nowMs, out)) out.no_sequence++
      continue
    }
    if (mine.some((r) => isMidCheckout(r, nowMs))) { out.waiting++; continue }
    if (judged >= MAX_CONTACTS_PER_TICK) { out.deferred++; continue }
    judged++
    out.checked++

    const oldest = Math.min(...candidates.map((r) => ms(r.created_at)))
    const later = mine.filter((r) => ms(r.created_at) >= oldest)
    if (later.some(isPurchaseRow)) {
      if (await stamp(db, ids, 'purchased', nowMs, out)) out.purchased++
      continue
    }
    if (later.some((r) => STAFF_STATUSES.has(r.status))) {
      if (await stamp(db, ids, 'staff_handling', nowMs, out)) out.ineligible++
      continue
    }
    if (mine.some((r) => r.abandon_followup_outcome === 'enrolled' && ms(r.abandon_followup_at) >= nowMs - ABANDON_REPEAT_MS)) {
      if (await stamp(db, ids, 'recent_followup', nowMs, out)) out.recent++
      continue
    }

    // The studio's own eligibility read. Unknown holds this person.
    const hold = (what) => {
      logError(MODULE, `${what}; this person is held until the next tick`, { locationId, contactId })
      out.held++
      out.ok = false
    }
    let verdict = null
    try {
      if (sourceOf.get(locationId) === 'un1t_online') {
        const membership = await un1tMembership(db, { locationId, contactId })
        if (!membership?.ok) { hold('membership unreadable'); continue }
        const un1t = await un1tBuyersAt(locationId)
        if (!un1t.ok) { hold('un1t purchases unreadable'); continue }
        if (membership.active) verdict = 'active_member'
        else if (un1t.buyers.get(contactId) >= oldest) verdict = 'purchased'
      } else {
        const { data: contact, error: cErr } = await db
          .from('contacts')
          .select('id, glofox_member_id, glofox_membership_status, glofox_membership_plan')
          .eq('id', contactId)
          .maybeSingle()
        if (cErr) { hold('contact unreadable'); continue }
        // The contact is gone (erased): there is nobody to follow up.
        if (!contact) verdict = 'no_contact'
        else {
          const history = await glofoxHistory(db, { locationId, contact })
          if (!history?.ok) { hold('trial history unreadable'); continue }
          if (history.hadTrial) verdict = 'had_trial'
        }
      }
    } catch (e) {
      hold(`eligibility threw (${e?.name ?? 'Error'})`)
      continue
    }
    if (verdict) {
      if (await stamp(db, ids, verdict, nowMs, out)) {
        if (verdict === 'purchased') out.purchased++
        else out.ineligible++
      }
      continue
    }

    // Enrol on their newest abandoned row, then stamp.
    const newest = candidates.reduce((a, b) => (ms(b.created_at) > ms(a.created_at) ? b : a))
    const checkout = {
      purchase_id: newest.id,
      studio: TRIAL_STUDIOS.find((s) => s.publicPath === newest.landing_path)?.key ?? null,
      provider: newest.payment_provider ?? null,
      created_at: newest.created_at,
      // An open Revolut checkout, or (HATCHTRACK.1) a Hatch Street row still
      // awaiting payment: the page gives that same row a checkout again from
      // its id alone (POST /api/public/trial-purchases/[id]/checkout).
      resumable: newest.status === 'awaiting_payment' && (
        newest.payment_provider === 'un1t_online'
        || (newest.payment_status === 'pending' && newest.payment_provider === 'revolut' && Boolean(newest.payment_checkout_token))
      ),
    }
    let res
    try {
      res = await trigger(db, { contactId, locationId, purchaseId: newest.id, checkout })
    } catch (e) {
      logError(MODULE, 'trigger threw', { locationId, contactId, errName: e?.name ?? null })
      res = null
    }
    if (!res?.ok) {
      // Not stamped: the offer is made again next tick.
      out.failed++
      out.ok = false
      continue
    }
    const enrolled = (res.enrolled || 0) > 0
    if (await stamp(db, ids, enrolled ? 'enrolled' : 'not_enrolled', nowMs, out)) {
      if (enrolled) out.enrolled += res.enrolled
      else out.not_enrolled++
    }
  }
  return out
}
