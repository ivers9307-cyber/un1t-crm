// src/lib/recon/finalize.js
//
// RCOV.P1 — the weekly cycle's last step. The Friday cron pulls,
// sweeps and seeds; the */5min drain works the hunt queue; and when
// the queue is EMPTY and this week's cron pull exists without a
// report yet, this compiles report v2 from live state, emails it,
// audits a recon_runs {trigger:'report'} row, and stamps the weekly
// heartbeat (strict Phase-0 health rule: only when the source cron
// run was clean AND the email sent).
import { renderCoverageReportHtml, sendCoverageReport } from './report-email'
import { getAppUrl } from '@/lib/app-url'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr } from '@/lib/dublin-time'

const CHUNK = 300 // house cap for .in()/bulk payloads (cf. coverage.js/statuses.js)
const LINE_DISPLAY_CAP = 200 // deliberate display cap for a report email, not a pagination boundary
const RECENT_CRON_MS = 48 * 3600 * 1000

async function hasPendingHunts(db) {
  const { data } = await db
    .from('recon_bank_lines')
    .select('id')
    .not('hunt_queued_at', 'is', null)
    .limit(1)
    .maybeSingle()
  return !!data
}

async function latestCronRun(db) {
  const { data } = await db
    .from('recon_runs')
    .select('id, started_at')
    .eq('trigger', 'cron')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

async function reportAlreadySent(db, sinceIso) {
  const { data } = await db
    .from('recon_runs')
    .select('id')
    .eq('trigger', 'report')
    .gt('started_at', sinceIso)
    .limit(1)
    .maybeSingle()
  return !!data
}

async function loadConnections(db) {
  const { data, error } = await db
    .from('xero_connections')
    .select('location_id, location:location_id(id, name)')
  if (error) throw new Error(`connections load failed: ${error.message}`)
  return data || []
}

// That location's own latest cron run within the last 48h — the
// per-location stats source for its section. Returns null when none
// (the caller records an error and skips the location entirely).
async function locationCronRun(db, locationId) {
  const { data } = await db
    .from('recon_runs')
    .select('id, status, started_at, stats')
    .eq('location_id', locationId)
    .eq('trigger', 'cron')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

// One query across ALL locations' found hunts since the (global) cron
// run started, then bucketed by location in JS — cheaper than one
// query per connection, and hunts are line-scoped (joined via
// bank_line_id) rather than location-scoped so there's no location_id
// column to filter on server-side.
async function foundHuntsByLocation(db, sinceIso) {
  const { data, error } = await db
    .from('recon_hunts')
    .select('id, finished_at, evidence, submitted_queue_id, bank_line_id, line:bank_line_id(location_id, line_date, description, amount)')
    .eq('outcome', 'found')
    .gte('finished_at', sinceIso)
  if (error) throw new Error(`found-hunts lookup failed: ${error.message}`)

  const byLocation = new Map()
  for (const h of data || []) {
    const locationId = h.line?.location_id
    if (!locationId) continue
    const bucket = byLocation.get(locationId) || []
    bucket.push({
      line_date: h.line.line_date,
      description: h.line.description,
      amount: h.line.amount,
      supplier_name: h.evidence?.verdict?.supplier_name ?? null,
      deduped: !!h.evidence?.deduped,
    })
    byLocation.set(locationId, bucket)
  }
  return byLocation
}

async function queueStatusesById(db, ids, selectCols) {
  const byId = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db
      .from('invoices_queue')
      .select(selectCols)
      .in('id', ids.slice(i, i + CHUNK))
    if (error) throw new Error(`queue lookup failed: ${error.message}`)
    for (const row of data || []) byId.set(row.id, row)
  }
  return byId
}

async function inReviewSection(db, locationId) {
  const { data, error } = await db
    .from('recon_bank_lines')
    .select('id, invoices_queue_id, line_date, description, amount')
    .eq('location_id', locationId)
    .eq('status', 'submitted')
    .not('invoices_queue_id', 'is', null)
    .order('line_date', { ascending: true })
    .limit(LINE_DISPLAY_CAP) // deliberate display cap for a report email — well under the guardrails rule's 1000-row threshold, no disable needed
  if (error) throw new Error(`in-review lines lookup failed: ${error.message}`)
  const lines = data || []
  if (lines.length === 0) return []

  const queueIds = lines.map((l) => l.invoices_queue_id)
  const byId = await queueStatusesById(db, queueIds, 'id, status')
  return lines.map((l) => ({
    line_date: l.line_date,
    description: l.description,
    amount: l.amount,
    queue_status: byId.get(l.invoices_queue_id)?.status ?? null,
  }))
}

async function needsAttentionSection(db, locationId) {
  const { data, error } = await db
    .from('recon_bank_lines')
    .select('id, invoices_queue_id, line_date, description, amount')
    .eq('location_id', locationId)
    .eq('status', 'needs_attention')
    .order('line_date', { ascending: true })
    .limit(LINE_DISPLAY_CAP) // deliberate display cap for a report email — well under the guardrails rule's 1000-row threshold, no disable needed
  if (error) throw new Error(`needs-attention lines lookup failed: ${error.message}`)
  const lines = data || []
  if (lines.length === 0) return []

  const queueIds = lines.filter((l) => l.invoices_queue_id != null).map((l) => l.invoices_queue_id)
  const byId = queueIds.length > 0 ? await queueStatusesById(db, queueIds, 'id, reject_reason') : new Map()
  return lines.map((l) => ({
    line_date: l.line_date,
    description: l.description,
    amount: l.amount,
    reject_reason: (l.invoices_queue_id != null ? byId.get(l.invoices_queue_id)?.reject_reason : null) ?? null,
  }))
}

async function uncoveredSection(db, locationId) {
  const { data, error } = await db
    .from('recon_bank_lines')
    .select('id, line_date, description, reference, amount')
    .eq('location_id', locationId)
    .in('status', ['uncovered', 'not_found'])
    .order('line_date', { ascending: true })
    .limit(LINE_DISPLAY_CAP) // deliberate display cap for a report email — well under the guardrails rule's 1000-row threshold, no disable needed
  if (error) throw new Error(`uncovered lines lookup failed: ${error.message}`)
  return (data || []).map((l) => ({
    line_date: l.line_date, description: l.description, reference: l.reference, amount: l.amount,
  }))
}

export async function maybeFinalizeWeekly(db) {
  try {
    if (await hasPendingHunts(db)) {
      return { finalized: false, reason: 'hunts_pending' }
    }

    const lastCron = await latestCronRun(db)
    if (!lastCron || (Date.now() - new Date(lastCron.started_at).getTime()) > RECENT_CRON_MS) {
      return { finalized: false, reason: 'no_recent_cron' }
    }

    if (await reportAlreadySent(db, lastCron.started_at)) {
      return { finalized: false, reason: 'already_reported' }
    }

    const connections = await loadConnections(db)
    const foundByLocation = await foundHuntsByLocation(db, lastCron.started_at)

    const sections = []
    const errors = []
    let allClean = true

    for (const conn of connections) {
      const locationId = conn.location_id
      const locationName = conn.location?.name || locationId
      const run = await locationCronRun(db, locationId)
      if (!run) {
        errors.push({ locationName, error: 'no cron run this cycle' })
        allClean = false
        continue
      }

      const accounts = run.stats?.accounts || []
      const anomalies = run.stats?.anomalies || []
      const stats = accounts.reduce((acc, a) => ({
        pulled: acc.pulled + (a.pulled || 0),
        new: acc.new + (a.new || 0),
        covered: acc.covered + (a.covered || 0),
      }), { pulled: 0, new: 0, covered: 0 })

      if (run.status !== 'ok' || anomalies.length > 0) allClean = false

      // Sequential (not Promise.all) — keeps from() call order deterministic
      // for tests and matches the house convention elsewhere in this module.
      const inReview = await inReviewSection(db, locationId)
      const needsAttention = await needsAttentionSection(db, locationId)
      const uncovered = await uncoveredSection(db, locationId)

      sections.push({
        locationName,
        stats,
        anomalies,
        found: foundByLocation.get(locationId) || [],
        inReview,
        needsAttention,
        uncovered,
      })
    }

    if (errors.length > 0) allClean = false

    const html = renderCoverageReportHtml({ appUrl: getAppUrl(), dateStr: dublinTodayStr(), sections, errors })

    try {
      await sendCoverageReport({ html, dateStr: dublinTodayStr() })
    } catch (e) {
      // No report row on email failure — retried next tick.
      return { finalized: false, reason: 'email_failed', error: String(e?.message || e) }
    }

    const totalFound = sections.reduce((n, s) => n + s.found.length, 0)
    const totalNeedsAttention = sections.reduce((n, s) => n + s.needsAttention.length, 0)

    await db.from('recon_runs').insert({
      trigger: 'report',
      status: allClean ? 'ok' : 'error',
      finished_at: new Date().toISOString(),
      stats: { locations: sections.length, found: totalFound, needsAttention: totalNeedsAttention, errors },
    })

    if (allClean) {
      await stampHeartbeat('receipt-coverage-weekly')
    }

    return { finalized: true, sections: sections.length }
  } catch (e) {
    console.error('[maybeFinalizeWeekly] error', e)
    return { finalized: false, reason: 'error', error: String(e?.message || e) }
  }
}
