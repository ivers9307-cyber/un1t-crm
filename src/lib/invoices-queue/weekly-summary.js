// @ts-check
// INVWEEKLY.1 — the weekly invoices email: what is waiting at one studio.
//
// Sent Monday 08:00 studio time by /api/cron/invoice-weekly-summary, and only
// when something is waiting. It goes to the people who send invoices at the
// studio (see weeklySummaryRecipients), never to the address an invoice came
// from, which can be the supplier's. It reads the queue; it changes nothing
// and sends nothing to Xero.

import { REVIEW_REASONS, REVIEW_REASON_LABELS } from '@/lib/invoices-queue/readiness'
import { excludeTombstones } from '@/lib/staff-tombstone'
import { escapeHtml } from '@/lib/html-escape'
import { logWarn } from '@/lib/log'

const MODULE = 'invoice-weekly-summary'
export const AWAITING_STATUSES = ['received', 'quality_approved', 'extracted', 'data_approved']
const UNREAD = new Set(['received', 'quality_approved'])
const SET_ASIDE = ['duplicate_file', 'unreadable']
const PAGE = 1000
const MAX_PAGES = 5
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Count one studio's waiting rows the way the Invoices screen piles them:
 * Ready, Needs a look (with a count per reason), and the duplicates and
 * unreadable files set aside.
 *
 * @param {Array<{ status?: string, review_reasons?: string[]|null, prepared_at?: string|null, analysis_queued_at?: string|null }>} rows
 */
export function summariseAwaiting(rows) {
  const list = Array.isArray(rows) ? rows : []
  let ready = 0
  let needsALook = 0
  let setAside = 0
  let beingRead = 0
  /** @type {Record<string, number>} */
  const perReason = {}
  for (const r of list) {
    const reasons = Array.isArray(r?.review_reasons) ? r.review_reasons : []
    const unread = UNREAD.has(String(r?.status))
    if (unread && r?.analysis_queued_at) { beingRead++; continue }
    if (unread && SET_ASIDE.some((k) => reasons.includes(k))) { setAside++; continue }
    if (r?.status === 'extracted' && r?.prepared_at && reasons.length === 0) { ready++; continue }
    needsALook++
    for (const k of reasons) perReason[k] = (perReason[k] || 0) + 1
  }
  // One line per label, in the screen's order (two reasons can share a label).
  /** @type {Array<{ label: string, count: number }>} */
  const reasons = []
  for (const key of REVIEW_REASONS) {
    const count = perReason[key]
    if (!count) continue
    const label = /** @type {Record<string, string>} */ (REVIEW_REASON_LABELS)[key]
    const existing = reasons.find((x) => x.label === label)
    if (existing) existing.count += count
    else reasons.push({ label, count })
  }
  return { ready, needsALook, setAside, beingRead, reasons, waiting: ready + needsALook + beingRead }
}

/** The bookkeeper flag on a permissions object, and only when it is exactly true. @param {unknown} permissions */
const isBookkeeper = (permissions) =>
  !!permissions && typeof permissions === 'object' && /** @type {Record<string, unknown>} */ (permissions).bookkeeper === true

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * @param {{ locationName: string, summary: ReturnType<typeof summariseAwaiting>, notInvoiceThisWeek?: number, appUrl: string }} input
 * @returns {{ subject: string, html: string }}
 */
export function buildWeeklySummaryEmail({ locationName, summary, notInvoiceThisWeek = 0, appUrl }) {
  const parts = []
  if (summary.ready) parts.push(`${summary.ready} ready to send`)
  if (summary.needsALook) parts.push(`${summary.needsALook} need a look`)
  if (summary.beingRead) parts.push(`${summary.beingRead} being read`)
  const subject = `Invoices at ${locationName}: ${parts.join(', ')}`
  const link = `${String(appUrl || '').replace(/\/$/, '')}/invoices`

  const reasonRows = summary.reasons
    .map((r) => `<tr><td style="padding:2px 16px 2px 0">${escapeHtml(r.label)}</td><td style="padding:2px 0;text-align:right">${r.count}</td></tr>`)
    .join('')
  const lines = [
    summary.ready
      ? `<p style="margin:0 0 12px"><strong>${plural(summary.ready, 'invoice is', 'invoices are')} ready to send to Xero.</strong></p>`
      : '<p style="margin:0 0 12px"><strong>No invoices are ready to send yet.</strong></p>',
    summary.needsALook
      ? `<p style="margin:0 0 6px">${plural(summary.needsALook, 'invoice needs', 'invoices need')} a look first:</p><table style="border-collapse:collapse;margin:0 0 12px">${reasonRows}</table>`
      : '',
    summary.beingRead ? `<p style="margin:0 0 12px">${plural(summary.beingRead, 'invoice is', 'invoices are')} still being read.</p>` : '',
    summary.setAside || notInvoiceThisWeek
      ? `<p style="margin:0 0 12px;color:#666">Set aside: ${plural(summary.setAside, 'duplicate or unreadable file', 'duplicates and unreadable files')}${notInvoiceThisWeek ? `, and ${plural(notInvoiceThisWeek, 'email', 'emails')} this week that did not hold an invoice` : ''}.</p>`
      : '',
    `<p style="margin:16px 0 0"><a href="${escapeHtml(link)}">Open Invoices</a></p>`,
    '<p style="margin:16px 0 0;color:#666;font-size:12px">Nothing is sent to Xero until someone clicks send. This email is sent on Mondays when invoices are waiting.</p>',
  ]
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111"><h2 style="margin:0 0 12px;font-size:16px">Invoices at ${escapeHtml(locationName)}</h2>${lines.filter(Boolean).join('')}</div>`
  return { subject, html }
}

/**
 * Every waiting row of one studio (the few columns the summary needs).
 * @param {import('@/lib/supabase').Db} db
 * @param {string} locationId
 */
export async function loadAwaitingRows(db, locationId) {
  /** @type {any[]} */
  const out = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db
      .from('invoices_queue')
      .select('id, status, review_reasons, prepared_at, analysis_queued_at')
      .eq('location_id', locationId)
      .in('status', AWAITING_STATUSES)
      .order('id', { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) throw new Error(`could not read the invoice queue: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

/**
 * Emails set aside as "not an invoice" since `sinceIso`.
 * @param {import('@/lib/supabase').Db} db
 * @param {string} locationId
 * @param {string} sinceIso
 */
export async function countNotInvoiceSince(db, locationId, sinceIso) {
  const { count, error } = await db
    .from('invoices_queue')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('status', 'not_invoice')
    .gte('created_at', sinceIso)
  if (error) {
    logWarn(MODULE, 'could not count set-aside emails', { location_id: locationId, error: error.message })
    return 0
  }
  return count || 0
}

/**
 * Who gets a studio's weekly email: active staff assigned to the studio who
 * are a master, or who hold the bookkeeper flag there (the right to send
 * invoices in bulk). An owner without the flag is not emailed: ticking
 * Bookkeeper on their staff record adds them.
 *
 * @param {import('@/lib/supabase').Db} db
 * @param {string} locationId
 * @returns {Promise<string[]>} distinct lower-cased addresses
 */
export async function weeklySummaryRecipients(db, locationId) {
  const { data: assignments, error } = await db
    .from('profile_locations')
    .select('profile_id, permissions')
    .eq('location_id', locationId)
  if (error) throw new Error(`could not read the studio's staff: ${error.message}`)
  const flagged = new Set((assignments || []).filter((a) => isBookkeeper(a?.permissions)).map((a) => a.profile_id))
  const ids = (assignments || []).map((a) => a.profile_id).filter(Boolean)
  if (ids.length === 0) return []

  const { data: profiles, error: profErr } = await excludeTombstones(
    db.from('profiles').select('id, email, role, active, permissions').in('id', ids).eq('active', true),
  )
  if (profErr) throw new Error(`could not read staff profiles: ${profErr.message}`)

  /** @type {string[]} */
  const out = []
  for (const p of profiles || []) {
    const sends = p.role === 'master' || flagged.has(p.id) || isBookkeeper(p?.permissions)
    const email = String(p.email || '').trim().toLowerCase()
    if (sends && EMAIL_RE.test(email) && !out.includes(email)) out.push(email)
  }
  return out
}
