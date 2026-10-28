// UN1TDUN.1 — payment reminders at a un1t.online studio (Hatch Street).
//
// The Glofox studio is chased off the INVOICE_UPDATED webhook (dunning.js);
// un1t.online has no webhook, so here the un1t.online sync is the detector
// (runUn1tDunningStep, step 7d of un1t-online-sync.js, every 15 minutes) and
// the Churn Radar's "Send payment reminder" the manual path. un1t.online
// already emails the member about a failed payment, so the studio's chase is
// WhatsApp only (the overdue_payment_dunning_un1t template, first message a
// day after the failure). The CRM charges no card and calls no un1t.online
// write: this module only reads.
//
//   trouble   pickUn1tTrouble over the read seam's pastDue rows (FRESH mirror
//             rows only, retries netted): a MEMBERSHIP invoice (one on a
//             subscription) still open, the member not paused and not
//             cancelling at period end. Always re-read here, never taken
//             from a caller.
//   payment   the run's metadata.payment, in the Glofox shape the senders
//             already read ({ invoice_id, link, link_suffix, amount, ... })
//             plus platform: 'un1t_online'. `link` is OUR short link,
//             <studio customer host>/pay-link/<token>, which resolves the Stripe
//             hosted invoice page live on open (src/lib/un1t-pay-link.js);
//             the token is the WhatsApp URL button's suffix. The Stripe URL
//             is never stored.
//   enrol     maybeEnrolUn1tDunning: ONE run per invoice. A run that already
//             carries this invoice (active, completed or exited) is left
//             alone; otherwise enrolContacts with allowReenrol and the
//             invoice id as sourceRef (DUNNING.2: a later invoice re-runs).
//   exit      the sync exits an active un1t run whose invoice is no longer
//             open (exitDunningForContact, scoped to that invoice), and the
//             pre-send gate re-checks the mirror before every send.
//
// Every export is best-effort and never throws: a dunning miss must never
// fail a sync run or a radar click.
import { randomBytes } from 'node:crypto'
import { enrolContacts } from '@/lib/sequences'
import { setEnrollmentStatus } from '@/lib/sequences/enrollment-status'
import { exitDunningForContact } from '@/lib/dunning'
import { PRESEND_EXIT_REASON, paymentFromEnrollment } from '@/lib/dunning-payment'
import { un1tOnlineReads } from '@/lib/membership/reads/un1t-online'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { formatMoneyMinor } from '@/lib/money-format'
import { selectAll } from '@/lib/select-all'
import { logWarn } from '@/lib/log'
import { UN1T_PAY_PATH, UN1T_DUNNING_WA_TEMPLATE } from '@/lib/un1t-dunning-copy'

const LOG_MODULE = 'un1t-dunning'
export const UN1T_PLATFORM = 'un1t_online'
export { UN1T_PAY_PATH, UN1T_DUNNING_WA_TEMPLATE }
/** At most this many enrolments are attempted per sync run; the rest wait for the next run. */
export const UN1T_DUNNING_ENROL_CAP = 50
const TOKEN_BYTES = 24

// Results that mean "this member is already being chased about this debt".
const ALREADY_REASONS = new Set(['already_enrolled', 'active_run_other_invoice', 'not_reenrolled'])

/** A fresh pay-link token: 24 random bytes, base64url (32 characters). */
export function newUn1tPayToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

// A pause is a pause while paused_until is in the future. An unreadable value
// fails closed (treated as paused): never chase someone who may be paused.
function isPaused(pausedUntil, nowMs) {
  if (pausedUntil == null || pausedUntil === '') return false
  const ms = Date.parse(pausedUntil)
  return !Number.isFinite(ms) || ms > nowMs
}

/**
 * The debt to chase for one contact, from the seam's pastDue rows. Pure.
 * Rows come sorted by `since` ascending, so the first qualifying row is the
 * oldest debt; its NEWEST open invoice is the one chased (the current
 * payment). `amountCents` is that invoice's amount only when it is the row's
 * only open invoice (the row's amount is a sum); otherwise null and the caller
 * reads the invoice itself.
 *
 * @param {object[]} rows      pastDue() rows
 * @param {string} contactId
 * @param {number} [nowMs]
 * @returns {{ trouble: null|{ invoiceId, subscriptionId, un1tUserId, since, amountCents, currency, openInvoiceIds }, reason: string|null }}
 */
export function pickUn1tTrouble(rows, contactId, nowMs = Date.now()) {
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && contactId && r.contactId === contactId)
  let reason = 'not_behind'
  for (const r of mine) {
    if (!r.subscriptionId) { reason = 'not_membership_invoice'; continue }
    const open = Array.isArray(r.openInvoiceIds) ? r.openInvoiceIds.filter((id) => id != null && id !== '').map(String) : []
    if (open.length === 0) { reason = 'no_open_invoice'; continue }
    if (r.cancelAtPeriodEnd === true) { reason = 'cancelling'; continue }
    if (isPaused(r.pausedUntil, nowMs)) { reason = 'member_paused'; continue }
    return {
      trouble: {
        invoiceId: open[open.length - 1],
        subscriptionId: String(r.subscriptionId),
        un1tUserId: r.un1tUserId ?? null,
        since: r.since ?? null,
        amountCents: open.length === 1 && r.amountCents != null ? Number(r.amountCents) : null,
        currency: r.currency ? String(r.currency).toUpperCase() : null,
        openInvoiceIds: open,
      },
      reason: null,
    }
  }
  return { trouble: null, reason }
}

/**
 * Re-derive one contact's trouble from the mirror. When the chased invoice is
 * one of several open ones, its own amount is read from un1t_invoices at this
 * studio (a failed read just leaves the amount unknown).
 * @returns {Promise<{ ok: false } | { ok: true, trouble: object|null, reason: string|null }>}
 */
async function readUn1tTrouble(db, locationId, contactId, nowMs) {
  const res = await un1tOnlineReads.pastDue(db, locationId, { contactIds: [contactId] })
  if (!res?.success || !Array.isArray(res.data)) {
    logWarn(LOG_MODULE, 'past-due read failed', { locationId, contactId })
    return { ok: false }
  }
  const { trouble, reason } = pickUn1tTrouble(res.data, contactId, nowMs)
  if (trouble && trouble.amountCents == null && trouble.openInvoiceIds.length > 1) {
    const { data: inv, error } = await db
      .from('un1t_invoices')
      .select('amount_cents, currency')
      .eq('location_id', locationId)
      .eq('un1t_id', trouble.invoiceId)
      // Unique on (location_id, un1t_id) (mig 726, the sync's upsert key).
      .maybeSingle()
    if (error) logWarn(LOG_MODULE, 'invoice amount read failed', { locationId, contactId, code: error.code ?? null })
    else if (inv?.amount_cents != null) {
      trouble.amountCents = Number(inv.amount_cents)
      trouble.currency = inv.currency ? String(inv.currency).toUpperCase() : trouble.currency
    }
  }
  return { ok: true, trouble, reason }
}

/**
 * The run's metadata.payment for a un1t debt, in the Glofox shape
 * (dunning-payment.js) plus `platform`. `link_suffix` is a fresh random
 * token and `link` our short link on the studio's customer host.
 */
export async function un1tPaymentForRun(db, { locationId, trouble, now = new Date(), token = newUn1tPayToken() } = {}) {
  const base = await resolveCustomerBaseUrl(db, locationId)
  const currency = trouble?.currency || null
  return {
    invoice_id: trouble?.invoiceId || null,
    link: `${base}${UN1T_PAY_PATH}${token}`,
    link_suffix: token,
    amount: trouble?.amountCents != null && currency ? formatMoneyMinor(trouble.amountCents, currency) : '',
    currency,
    retriable: false,
    fetched_at: now.toISOString(),
    error: null,
    platform: UN1T_PLATFORM,
  }
}

async function readDunningLocation(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('membership_source, dunning_sequence_id, dunning_auto_enroll')
    .eq('id', locationId)
    .maybeSingle()
  if (error) {
    logWarn(LOG_MODULE, 'location read failed', { locationId, code: error.code ?? null })
    return { ok: false }
  }
  return { ok: true, loc: data || null }
}

/**
 * Start the studio's dunning sequence for a contact behind on a un1t.online
 * membership invoice. Best-effort, never throws.
 *
 * @param {object} db         service-role client
 * @param {string} locationId the un1t.online studio
 * @param {string} contactId
 * @param {object} [opts]
 * @param {boolean} [opts.manual]  the radar's "Send payment reminder": runs
 *   with dunning_auto_enroll off (as the Glofox manual path does) and enrols
 *   as 'churn_radar'
 * @param {Date} [opts.now]
 * @param {string} [opts.token]    the pay-link token (tests)
 * @returns {Promise<{ enrolled: number, reason?: string, invoice_id?: string, sequence_id?: string, sequence_name?: string, status?: string, error?: string }>}
 */
export async function maybeEnrolUn1tDunning(db, locationId, contactId, { manual = false, now = new Date(), token } = {}) {
  try {
    if (!contactId) return { enrolled: 0, reason: 'no_contact' }
    const { ok, loc } = await readDunningLocation(db, locationId)
    if (!ok) return { enrolled: 0, reason: 'location_unreadable' }
    if (loc?.membership_source !== UN1T_PLATFORM) return { enrolled: 0, reason: 'not_un1t_studio' }
    if (!manual && !loc.dunning_auto_enroll) return { enrolled: 0, reason: 'auto_enroll_off' }
    const seqId = loc.dunning_sequence_id || null
    if (!seqId) return { enrolled: 0, reason: 'no_dunning_sequence' }
    const { data: seq, error: seqErr } = await db
      .from('email_sequences')
      .select('id, name, status, location_id')
      .eq('id', seqId)
      .maybeSingle()
    if (seqErr) return { enrolled: 0, reason: 'sequence_unavailable' }
    if (!seq || seq.location_id !== locationId) return { enrolled: 0, reason: 'sequence_unavailable' }
    if (seq.status !== 'active') return { enrolled: 0, reason: 'sequence_paused', sequence_name: seq.name }

    const read = await readUn1tTrouble(db, locationId, contactId, now.getTime())
    if (!read.ok) return { enrolled: 0, reason: 'past_due_unreadable' }
    if (!read.trouble) return { enrolled: 0, reason: read.reason || 'not_behind' }
    const { trouble } = read

    // One automatic run per invoice. (sequence_id, contact_id) is a FULL
    // unique index (ENROLDEDUP.1), so there is at most one row: whatever its
    // status, if it already chased this invoice, the sync never starts another.
    // A manual click is refused only while that run is still active, so staff
    // can chase the same unpaid invoice again (enrol.js's cooldown still holds).
    const { data: existing, error: exErr } = await db
      .from('sequence_enrollments')
      .select('id, status, metadata')
      .eq('sequence_id', seqId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (exErr) {
      logWarn(LOG_MODULE, 'enrolment read failed', { locationId, contactId, code: exErr.code ?? null })
      return { enrolled: 0, reason: 'enrolment_unreadable' }
    }
    if (paymentFromEnrollment(existing)?.invoice_id === trouble.invoiceId && (!manual || existing.status === 'active')) {
      return { enrolled: 0, reason: 'already_enrolled', status: existing.status, invoice_id: trouble.invoiceId, sequence_id: seqId, sequence_name: seq.name }
    }

    const payment = await un1tPaymentForRun(db, { locationId, trouble, now, ...(token ? { token } : {}) })
    const res = await enrolContacts({
      sequenceId: seqId,
      contactIds: [contactId],
      sourceType: manual ? 'churn_radar' : 'invoice_past_due',
      sourceRef: trouble.invoiceId,
      allowReenrol: true,
      metadata: { payment },
    })
    if (res?.enrolled > 0) {
      return { enrolled: res.enrolled, invoice_id: trouble.invoiceId, sequence_id: seqId, sequence_name: seq.name }
    }
    // An active run on an older (still open) invoice keeps its own link, which
    // still works; a finished run inside the cooldown is not re-run (enrol.js).
    return {
      enrolled: 0,
      reason: existing?.status === 'active' ? 'active_run_other_invoice' : 'not_reenrolled',
      invoice_id: trouble.invoiceId,
      sequence_id: seqId,
      sequence_name: seq.name,
    }
  } catch (e) {
    logWarn(LOG_MODULE, 'maybeEnrolUn1tDunning threw', { locationId, contactId, err: e?.message })
    return { enrolled: 0, reason: 'threw', error: e?.message }
  }
}

const PROCEED = Object.freeze({ proceed: true })

/**
 * PRESEND.1 for a un1t run: immediately before a send, re-read the mirror
 * (fresh rows) and stop if this run's invoice is no longer open. Same rules as
 * the Glofox gate: it only ever ADDS a stop, and it FAILS OPEN (an unreadable
 * mirror, a throw, or a failed exit write all send). The caller
 * (dunningPresendGate) has already checked the run is transactional.
 */
export async function un1tDunningPresendGate(db, { enrollment, contact, sequence } = {}) {
  try {
    const v = paymentFromEnrollment(enrollment)?.invoice_id
    const invoiceId = typeof v === 'string' ? v.trim() : ''
    if (!invoiceId) return PROCEED
    const locationId = sequence?.location_id
    const contactId = enrollment?.contact_id || contact?.id
    if (!locationId || !contactId) return PROCEED

    const res = await un1tOnlineReads.pastDue(db, locationId, { contactIds: [contactId] })
    if (!res?.success || !Array.isArray(res.data)) {
      logWarn(LOG_MODULE, 'pre-send past-due read failed, sending anyway', { locationId, contactId })
      return PROCEED
    }
    const stillOpen = res.data.some((r) => (Array.isArray(r?.openInvoiceIds) ? r.openInvoiceIds : []).map(String).includes(invoiceId))
    if (stillOpen) return PROCEED

    try {
      await setEnrollmentStatus({ enrollmentId: enrollment.id, status: 'exited', reason: PRESEND_EXIT_REASON })
    } catch (e) {
      // Not recorded, so the run is still live: claiming a stop would skip
      // this send and then send the next step anyway (as the Glofox gate).
      logWarn(LOG_MODULE, 'pre-send exit failed, sending anyway', { locationId, contactId, err: e?.message })
      return PROCEED
    }
    return { proceed: false, reason: 'invoice no longer overdue' }
  } catch (e) {
    logWarn(LOG_MODULE, 'un1tDunningPresendGate threw', { contactId: contact?.id, err: e?.message })
    return PROCEED
  }
}

/**
 * Step 7d of the un1t.online sync: exit the runs whose invoice was settled,
 * then start runs for newly past-due members (auto-enrol on only).
 * Informational: the counts land in the run's counts.dunning; a failure is
 * recorded and logged and never changes the run's status. A failed past-due
 * read exits nothing and enrols nothing.
 *
 * @returns {Promise<{ skipped: 'membership_source' } | { enrolled, already, exited, skipped, reason?, error?, exit_error?, exit_failed?, over_cap? }>}
 */
export async function runUn1tDunningStep(db, { locationId } = {}) {
  const counts = { enrolled: 0, already: 0, exited: 0, skipped: 0 }
  try {
    const { ok, loc } = await readDunningLocation(db, locationId)
    if (!ok) return { ...counts, error: 'location_unreadable' }
    if (loc?.membership_source !== UN1T_PLATFORM) return { skipped: 'membership_source' }
    const seqId = loc.dunning_sequence_id || null
    if (!seqId) return { ...counts, reason: 'no_dunning_sequence' }

    const pd = await un1tOnlineReads.pastDue(db, locationId)
    if (!pd?.success || !Array.isArray(pd.data)) {
      logWarn(LOG_MODULE, 'sync step: past-due read failed; nothing exited or enrolled', { locationId })
      return { ...counts, error: 'past_due_unreadable' }
    }
    const rows = pd.data
    const open = new Set(rows.flatMap((r) => (Array.isArray(r?.openInvoiceIds) ? r.openInvoiceIds : [])).map(String))

    // Exits first, so a member who paid one invoice and failed the next is
    // free to start the next run below.
    let active = null
    try {
      active = await selectAll((from, to) => db
        .from('sequence_enrollments')
        .select('id, contact_id, metadata')
        .eq('sequence_id', seqId)
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(from, to))
    } catch (e) {
      logWarn(LOG_MODULE, 'sync step: active runs unreadable; no exits this run', { locationId, err: e?.message })
      counts.exit_error = 'runs_unreadable'
    }
    for (const run of active || []) {
      const payment = paymentFromEnrollment(run)
      if (payment?.platform !== UN1T_PLATFORM) continue
      const invoiceId = typeof payment.invoice_id === 'string' ? payment.invoice_id.trim() : ''
      if (!invoiceId || open.has(invoiceId)) continue
      const res = await exitDunningForContact(db, locationId, run.contact_id, 'invoice_paid', { invoiceId })
      counts.exited += res?.exited || 0
      if (res?.error) counts.exit_failed = (counts.exit_failed || 0) + 1
    }

    if (!loc.dunning_auto_enroll) return { ...counts, reason: 'auto_enroll_off' }

    const contactIds = [...new Set(rows.map((r) => r?.contactId).filter(Boolean))]
      .filter((cid) => pickUn1tTrouble(rows, cid).trouble)
    const toTry = contactIds.slice(0, UN1T_DUNNING_ENROL_CAP)
    if (contactIds.length > toTry.length) {
      counts.over_cap = contactIds.length - toTry.length
      logWarn(LOG_MODULE, 'more past-due members than the per-run cap; the rest wait for the next run', { locationId, cap: UN1T_DUNNING_ENROL_CAP })
    }
    for (const cid of toTry) {
      // Re-derives this contact's trouble itself: nothing from this loop is trusted.
      const res = await maybeEnrolUn1tDunning(db, locationId, cid)
      if (res.enrolled > 0) counts.enrolled += 1
      else if (ALREADY_REASONS.has(res.reason)) counts.already += 1
      else counts.skipped += 1
    }
    return counts
  } catch (e) {
    logWarn(LOG_MODULE, 'sync step threw', { locationId, err: e?.message })
    return { ...counts, error: e?.message || 'threw' }
  }
}
