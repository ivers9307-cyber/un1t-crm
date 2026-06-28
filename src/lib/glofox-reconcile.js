// GLOFOX-RECONCILE.1 — orchestration for clearing stale PAST_DUE invoices.
//
// The churn radar reads glofox_invoices.status='PAST_DUE', a table fed by
// INVOICE_UPDATED webhooks that CREATE late-cancel / no-show fee rows as
// PAST_DUE. When a fee is later forgiven / cancelled / written off in Glofox,
// no webhook flips our local copy, so the row goes stale and the radar shows a
// member owing money they don't (verified 2026-06-28). The Glofox
// TransactionsList report is the source of truth.
//
// The pure decision logic lives in glofox-arrears.js (indexReportByInvoice +
// reconcileOpenPastDue); this module does the IO — fetch the open PAST_DUE
// rows + the report, then (on commit) clear the rows Glofox no longer shows as
// owed, recording reconciled_at / reconciled_reason so the change is auditable.

import { fetchPaymentsReport } from './glofox'
import { indexReportByInvoice, reconcileOpenPastDue, OWED_STATUSES, isCountedOwedRow } from './glofox-arrears'

const JAN_1_2026 = 1767225600 // unix seconds — never ask Glofox for the whole of time
const PAGE = 1000
const HARD_LIMIT = 50_000
const DAY_SEC = 86_400

/**
 * Page every open OWED invoice for a location — PAST_DUE plus PENDING
 * custom-charge fees (OWED-PENDING.1); pending subscription renewals are
 * dropped. PostgREST caps at 1000 rows, so paginate.
 */
async function fetchOpenPastDue(db, locationId) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('glofox_invoices')
      .select('id, invoice_date, amount_cents, glofox_user_id, contact_id, status, line_item_subtypes')
      .eq('location_id', locationId)
      .in('status', OWED_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`glofox_invoices read failed: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE || rows.length >= HARD_LIMIT) break
  }
  return rows.filter(isCountedOwedRow)
}

/**
 * Reconcile one location's open PAST_DUE invoices against the live Glofox
 * report. DRY by default; pass `commit: true` to clear the stale rows.
 *
 * @param {object} db          service-role Supabase client
 * @param {object} creds       glofoxCredentialsForLocation() result
 * @param {string} locationId
 * @param {{ commit?: boolean, nowMs?: number, absentAgeDays?: number,
 *           reportFetcher?: Function, reportFloorSec?: number }} [opts]
 *   reportFetcher — injectable (defaults to fetchPaymentsReport) for tests.
 * @returns {Promise<{ ok, locationId, scanned, cleared, kept, byReason,
 *                     sample, dryRun, written?, errors? }>}
 */
export async function runArrearsReconcile(db, creds, locationId, opts = {}) {
  const {
    commit = false,
    nowMs = Date.now(),
    absentAgeDays = 2,
    reportFetcher = fetchPaymentsReport,
    reportFloorSec = JAN_1_2026,
  } = opts

  const pastDueRows = await fetchOpenPastDue(db, locationId)
  const scanned = pastDueRows.length
  if (scanned === 0) {
    return { ok: true, locationId, scanned: 0, cleared: 0, kept: 0, byReason: {}, sample: [], dryRun: !commit }
  }

  // Report window: cover back to the oldest open PAST_DUE (minus a margin),
  // floored so we never request the whole of time. End = now.
  let minMs = Infinity
  for (const r of pastDueRows) {
    const ms = Date.parse(r.invoice_date)
    if (Number.isFinite(ms) && ms < minMs) minMs = ms
  }
  const startSec = Number.isFinite(minMs)
    ? Math.max(reportFloorSec, Math.floor(minMs / 1000) - 7 * DAY_SEC)
    : reportFloorSec
  const endSec = Math.floor(nowMs / 1000)

  const report = await reportFetcher(creds, { start: startSec, end: endSec })
  if (!report || !report.ok) {
    throw new Error(`Glofox report fetch failed (status ${report?.status ?? 'n/a'})`)
  }
  const details = report.body?.TransactionsList?.details
  if (!Array.isArray(details)) {
    throw new Error('Glofox report returned no TransactionsList.details array')
  }

  const idx = indexReportByInvoice(details)
  const decisions = reconcileOpenPastDue(pastDueRows, idx, nowMs, { absentAgeDays })
  const clears = decisions.filter((d) => d.action === 'clear')

  const byReason = {}
  for (const d of clears) byReason[d.reason] = (byReason[d.reason] || 0) + 1
  const summary = {
    ok: true,
    locationId,
    scanned,
    cleared: clears.length,
    kept: scanned - clears.length,
    byReason,
    sample: clears.slice(0, 20),
    dryRun: !commit,
  }
  if (!commit || clears.length === 0) return summary

  // Commit: group by (newStatus, reason) so each UPDATE is one status+reason,
  // and clear in chunks. Records reconciled_at/reason for auditability.
  const nowIso = new Date(nowMs).toISOString()
  const groups = new Map() // `${status}|${reason}` -> ids[]
  for (const d of clears) {
    const key = `${d.newStatus}|${d.reason}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(d.id)
  }
  const errors = []
  let written = 0
  const CHUNK = 500
  for (const [key, ids] of groups) {
    const sep = key.indexOf('|')
    const status = key.slice(0, sep)
    const reason = key.slice(sep + 1)
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const { data, error } = await db
        .from('glofox_invoices')
        .update({ status, reconciled_at: nowIso, reconciled_reason: reason, updated_at: nowIso })
        .in('id', chunk)
        .select('id')
      if (error) { errors.push(error.message); continue }
      written += Array.isArray(data) ? data.length : 0
    }
  }
  summary.written = written
  if (errors.length) summary.errors = errors
  return summary
}
