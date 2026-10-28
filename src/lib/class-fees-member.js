// FEES.3 — the member side of class fees (Richard, 28 Oct 2026), each half
// switched on and off on its own in /class-fees settings:
//   - the NOTICE: at 23:00, once charging is on, each member with a fee due
//     gets an email (what happened, the amount, when it is charged). Never
//     while charging is paused: nobody is told about a fee that won't be taken.
//   - the APPEAL: a link (in the notice when both are on, or copied by staff
//     from the review page) to /fee-appeal/<token>. An appeal HOLDS the fee
//     (status 'appealed'): never charged until staff waive it or choose
//     "charge anyway".
// The token is a credential: only its sha256 is stored, the link is minted on
// the studio's customer host, and the page shows the fee and nothing else.

import { createHash, randomBytes } from 'node:crypto'
import {
  classFeeSettingsFrom,
  renderFeeNotice,
  noticeTimeLabel,
  classFeeKindLabel,
  APPEALABLE_STATUSES,
} from './class-fees.js'
import { getLocationZone } from './location-time.js'
import { resolveCustomerBaseUrl } from './tenant-host.js'
import { getLocationBranding } from './location-branding.js'
import { sendTransactionalEmail } from './postmark.js'
import { TRANSACTIONAL_CONSENT_SELECT, transactionalEmailSuppression } from './transactional-consent.js'
import { escapeHtml } from './html-escape.js'
import { logError, logInfo, logWarn } from './log'

const LOG_MODULE = 'class-fees'
export const APPEAL_REASONS = Object.freeze(['illness', 'injury', 'emergency', 'other'])
const NOTICE_BATCH = 200
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/

export const hashAppealToken = (token) => createHash('sha256').update(String(token)).digest('hex')

/** A new appeal token and its stored hash. */
export function newAppealToken() {
  const token = randomBytes(24).toString('base64url')
  return { token, hash: hashAppealToken(token) }
}

async function appealUrlFor(db, locationId, token) {
  return `${await resolveCustomerBaseUrl(db, locationId)}/fee-appeal/${token}`
}

function dbError(what, error) {
  return Object.assign(new Error(`class fees: ${what} failed (${error?.code ?? 'no code'})`), { code: error?.code ?? null })
}

/** Store a fresh token hash on a fee still in `statuses`. → the token, or null. */
async function mintToken(db, { locationId, feeId, statuses }) {
  const { token, hash } = newAppealToken()
  const { data, error } = await db
    .from('class_fees')
    .update({ appeal_token_hash: hash })
    .eq('id', feeId)
    .eq('location_id', locationId)
    .in('status', statuses)
    .select('id')
  if (error) throw dbError('appeal token write', error)
  return data?.length ? token : null
}

/** Plain text → escaped HTML paragraphs, the link clickable. Pure. */
export function noticeHtml(text, appealUrl) {
  return text.split(/\n{2,}/).map((para) => {
    let html = escapeHtml(para).replace(/\n/g, '<br>')
    if (appealUrl) {
      const safe = escapeHtml(appealUrl)
      html = html.split(safe).join(`<a href="${safe}">${safe}</a>`)
    }
    return `<p>${html}</p>`
  }).join('\n')
}

/**
 * Email each member whose fee is due and not yet told. Only while the notice
 * is switched on and charging is on. Never throws for one member's failure;
 * a fee whose email failed is tried again the next night if it is still due.
 * @returns {Promise<{ sent: number, skipped: number, failed: number }>}
 */
export async function sendMemberNotices(db, { locationId, location, settings, zone, nowMs = Date.now() }) {
  const out = { sent: 0, skipped: 0, failed: 0 }
  if (!settings.noticeEnabled || settings.chargingPaused) return out
  const { data: fees, error } = await db
    .from('class_fees')
    .select('id, contact_id, kind, class_title, starts_at, amount_cents, charge_due_at')
    .eq('location_id', locationId)
    .eq('status', 'pending')
    .eq('penalty', 'fee')
    .is('notice_sent_at', null)
    .gt('charge_due_at', new Date(nowMs).toISOString())
    .order('starts_at')
    .limit(NOTICE_BATCH)
  if (error) throw dbError('notice read', error)
  if (!fees?.length) return out

  const contactIds = [...new Set(fees.map((f) => f.contact_id).filter(Boolean))]
  const contacts = new Map()
  for (let i = 0; i < contactIds.length; i += 100) {
    const { data, error: cErr } = await db
      .from('contacts')
      .select(`${TRANSACTIONAL_CONSENT_SELECT}, email, first_name`)
      .in('id', contactIds.slice(i, i + 100))
      .limit(100)
    if (cErr) throw dbError('notice contact read', cErr)
    for (const c of data || []) contacts.set(c.id, c)
  }

  for (const fee of fees) {
    const contact = contacts.get(fee.contact_id)
    const suppressed = transactionalEmailSuppression(contact)
    if (!contact?.email || suppressed) {
      out.skipped++
      if (suppressed) logInfo(LOG_MODULE, 'fee notice not sent: suppressed', { locationId, feeId: fee.id, code: suppressed })
      continue
    }
    try {
      const token = settings.appealsEnabled ? await mintToken(db, { locationId, feeId: fee.id, statuses: ['pending'] }) : null
      const appealUrl = token ? await appealUrlFor(db, locationId, token) : null
      const { subject, text } = renderFeeNotice(fee, { settings, zone, firstName: contact.first_name, studioName: location?.name, appealUrl })
      await sendTransactionalEmail({
        to: contact.email, subject, htmlBody: noticeHtml(text, appealUrl),
        contactId: contact.id, locationId, tag: 'class-fee-notice',
      })
      const { error: upErr } = await db
        .from('class_fees')
        .update({ notice_sent_at: new Date(nowMs).toISOString() })
        .eq('id', fee.id)
        .eq('location_id', locationId)
      // The email went out: a lost stamp only risks a second notice tomorrow.
      if (upErr) logError(LOG_MODULE, 'fee notice sent but not stamped', { locationId, feeId: fee.id, code: upErr.code ?? null })
      out.sent++
    } catch (err) {
      out.failed++
      logError(LOG_MODULE, 'fee notice failed', { locationId, feeId: fee.id, code: err?.code ?? err?.name ?? 'send_failed' })
    }
  }
  return out
}

/**
 * Staff: a fresh appeal link for one fee, to send the member themselves.
 * → { ok: true, url } | { ok: false, reason: 'not_found'|'appeals_off'|'not_appealable' }
 */
export async function issueAppealLink(db, { locationId, feeId }) {
  const { data: loc, error: lErr } = await db.from('locations').select('id, settings').eq('id', locationId).maybeSingle()
  if (lErr) throw dbError('location read', lErr)
  if (!classFeeSettingsFrom(loc?.settings).appealsEnabled) return { ok: false, reason: 'appeals_off' }
  const { data: fee, error } = await db
    .from('class_fees')
    .select('id, status, penalty')
    .eq('id', feeId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw dbError('fee read', error)
  if (!fee) return { ok: false, reason: 'not_found' }
  if (fee.penalty !== 'fee' || !APPEALABLE_STATUSES.includes(fee.status)) return { ok: false, reason: 'not_appealable' }
  const token = await mintToken(db, { locationId, feeId, statuses: APPEALABLE_STATUSES })
  if (!token) return { ok: false, reason: 'not_appealable' }
  return { ok: true, url: await appealUrlFor(db, locationId, token) }
}

const APPEAL_COLUMNS = 'id, location_id, kind, class_title, starts_at, amount_cents, charge_due_at, status, appealed_at'

async function feeByToken(db, token) {
  if (!TOKEN_RE.test(String(token ?? ''))) return null
  const { data, error } = await db
    .from('class_fees')
    .select(APPEAL_COLUMNS)
    .eq('appeal_token_hash', hashAppealToken(token))
    .maybeSingle()
  if (error) throw dbError('appeal read', error)
  return data ?? null
}

/**
 * The public page's view of one appeal link. Nothing about the member is
 * returned; an unknown or malformed token is 'not_found' with no branding.
 * @returns {Promise<{ state: 'open'|'appealed'|'closed'|'off'|'not_found', fee?: object, branding?: object }>}
 */
export async function loadAppeal(db, token) {
  const fee = await feeByToken(db, token)
  if (!fee) return { state: 'not_found' }
  const { data: loc, error } = await db.from('locations').select('id, name, settings').eq('id', fee.location_id).maybeSingle()
  if (error) throw dbError('location read', error)
  const branding = await getLocationBranding(db, fee.location_id)
  const zone = await getLocationZone(db, fee.location_id)
  const view = {
    what: classFeeKindLabel(fee.kind),
    classTitle: fee.class_title || 'Class',
    classTime: noticeTimeLabel(fee.starts_at, zone),
    amount: `€${(fee.amount_cents / 100).toFixed(2).replace(/\.00$/, '')}`,
    chargeTime: fee.charge_due_at ? noticeTimeLabel(fee.charge_due_at, zone) : null,
    studioName: loc?.name || null,
  }
  const brand = { companyName: branding?.companyName || loc?.name || null, logoUrl: branding?.logoUrl || null }
  if (!classFeeSettingsFrom(loc?.settings).appealsEnabled) return { state: 'off', fee: view, branding: brand }
  if (fee.status === 'appealed') return { state: 'appealed', fee: view, branding: brand }
  if (!APPEALABLE_STATUSES.includes(fee.status)) return { state: 'closed', fee: view, branding: brand }
  return { state: 'open', fee: view, branding: brand }
}

/**
 * The member's appeal: holds the fee (compare-and-set from a status still
 * appealable). → { ok: true } | { ok: false, reason }
 */
export async function submitAppeal(db, { token, reason, text, nowMs = Date.now() }) {
  if (!APPEAL_REASONS.includes(reason)) return { ok: false, reason: 'bad_reason' }
  const fee = await feeByToken(db, token)
  if (!fee) return { ok: false, reason: 'not_found' }
  const { data: loc, error: lErr } = await db.from('locations').select('id, settings').eq('id', fee.location_id).maybeSingle()
  if (lErr) throw dbError('location read', lErr)
  if (!classFeeSettingsFrom(loc?.settings).appealsEnabled) return { ok: false, reason: 'appeals_off' }
  if (fee.status === 'appealed') return { ok: true, already: true }
  if (!APPEALABLE_STATUSES.includes(fee.status)) return { ok: false, reason: 'closed' }
  const { data, error } = await db
    .from('class_fees')
    .update({
      status: 'appealed',
      appeal_reason: reason,
      appeal_text: typeof text === 'string' && text.trim() ? text.trim().slice(0, 1000) : null,
      appealed_at: new Date(nowMs).toISOString(),
      next_attempt_at: null,
    })
    .eq('id', fee.id)
    .eq('location_id', fee.location_id)
    .eq('status', fee.status)
    .select('id')
  if (error) throw dbError('appeal write', error)
  if (!data?.length) return { ok: false, reason: 'closed' }
  logInfo(LOG_MODULE, 'fee appealed', { locationId: fee.location_id, feeId: fee.id })
  return { ok: true }
}

/**
 * Staff: charge an appealed fee after all. It goes back to pending, due now,
 * so the next hourly run charges it (with its own card check and key).
 * → { ok: true } | { ok: false, reason: 'not_found'|'not_appealed' }
 */
export async function chargeAppealedFee(db, { locationId, feeId, nowMs = Date.now() }) {
  const { data: fee, error } = await db
    .from('class_fees')
    .select('id, status')
    .eq('id', feeId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw dbError('fee read', error)
  if (!fee) return { ok: false, reason: 'not_found' }
  if (fee.status !== 'appealed') return { ok: false, reason: 'not_appealed' }
  const { data, error: upErr } = await db
    .from('class_fees')
    .update({ status: 'pending', charge_due_at: new Date(nowMs).toISOString(), next_attempt_at: null })
    .eq('id', feeId)
    .eq('location_id', locationId)
    .eq('status', 'appealed')
    .select('id')
  if (upErr) throw dbError('charge-anyway write', upErr)
  if (!data?.length) return { ok: false, reason: 'not_appealed' }
  logWarn(LOG_MODULE, 'appealed fee sent back to charging by staff', { locationId, feeId })
  return { ok: true }
}
