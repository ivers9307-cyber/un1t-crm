// src/lib/recon/finalize.js
//
// RCOV.P1 — the weekly cycle's last step. The Friday cron pulls,
// sweeps and seeds; the */5min drain works the hunt queue; and when
// the queue is EMPTY and this week's cron pull exists without a
// report yet, this compiles report v2 from live state, emails it,
// audits a recon_runs {trigger:'report'} row, and stamps the weekly
// heartbeat (strict Phase-0 health rule: only when the source cron
// run was clean AND the email sent).
//
// W0.7 — ONE REPORT PER ORGANISATION. xero_connections spans every
// tenant, so sections are bucketed by the connection's
// locations.organization_id and each organisation's report goes
// through sendCoverageReportForOrg (→ sendOpsAlert → that org's
// org_settings.ops_alert_emails, push fallback to the location's
// admins). The old single combined email to env
// RECEIPT_COVERAGE_REPORT_TO put tenant B's bank lines in tenant A's
// inbox; that env var is retired.
import { renderCoverageReportHtml, sendCoverageReportForOrg } from './report-email'
import { getAppUrl } from '@/lib/app-url'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logError } from '@/lib/log'

const CHUNK = 300 // house cap for .in()/bulk payloads (cf. coverage.js/statuses.js)
const LINE_DISPLAY_CAP = 200 // deliberate display cap for a report email, not a pagination boundary
const RECENT_CRON_MS = 48 * 3600 * 1000

// Status filter mirrors claim_recon_hunt_batch (mig 370) and the
// QStash worker's CAS — a queued row in any OTHER status (covered by a
// pull while queued, historic needs_attention re-hunts) is unclaimable
// by every drain path, so counting it here would wedge the finalizer
// at hunts_pending forever.
async function hasPendingHunts(db) {
  const { data } = await db
    .from('recon_bank_lines')
    .select('id')
    .in('status', ['uncovered', 'not_found'])
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
    .select('location_id, location:location_id(id, name, organization_id)')
  if (error) throw new Error(`connections load failed: ${error.message}`)
  return data || []
}

// That location's own latest cron run within the last 48h — the
// per-location stats source for its section. Returns null when none
// (the caller records an error and skips the location entirely). The
// 48h bound matches the global gate's RECENT_CRON_MS: without it, a
// location whose pull stopped running would keep satisfying allClean
// on the strength of a stale old run.
async function locationCronRun(db, locationId) {
  const { data } = await db
    .from('recon_runs')
    .select('id, status, started_at, stats')
    .eq('location_id', locationId)
    .eq('trigger', 'cron')
    .gte('started_at', new Date(Date.now() - RECENT_CRON_MS).toISOString())
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
      // null when the location row is missing or unassigned — such an
      // error is platform-level and is shown to every organisation.
      const organizationId = conn.location?.organization_id || null
      const run = await locationCronRun(db, locationId)
      if (!run) {
        errors.push({ locationName, error: 'no cron run this cycle', organizationId })
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
        organizationId,
        locationId,
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

    // Bucket by organisation: each tenant sees only its own locations.
    const byOrg = new Map()
    for (const s of sections) {
      const key = s.organizationId || 'unknown'
      if (!byOrg.has(key)) byOrg.set(key, { organizationId: s.organizationId, locationId: s.locationId, sections: [], errors: [] })
      byOrg.get(key).sections.push(s)
    }
    for (const e of errors) {
      // An error carries the organisation of the connection that produced it;
      // one without (a platform-level failure) is shown to every organisation.
      const targets = e.organizationId && byOrg.has(e.organizationId) ? [byOrg.get(e.organizationId)] : [...byOrg.values()]
      for (const bucket of targets) bucket.errors.push({ locationName: e.locationName, error: e.error })
    }
    if (byOrg.size === 0 && errors.length) {
      // Nothing rendered anywhere: still record the run so it is not retried forever, and log.
      logError('recon-finalize', 'coverage report: no organisation to send to', { errors })
    }

    const dateStr = dublinTodayStr()
    for (const bucket of byOrg.values()) {
      if (!bucket.organizationId) {
        // sendCoverageReportForOrg would throw; there is nobody to send to.
        logError('recon-finalize', 'coverage report: sections with no organisation were not sent', {
          locations: bucket.sections.map((s) => s.locationName),
        })
        continue
      }
      const html = renderCoverageReportHtml({ appUrl: getAppUrl(), dateStr, sections: bucket.sections, errors: bucket.errors })
      try {
        await sendCoverageReportForOrg({ db, organizationId: bucket.organizationId, locationId: bucket.locationId, html, dateStr })
      } catch (e) {
        // No report row on email failure — retried next tick.
        return { finalized: false, reason: 'email_failed', error: String(e?.message || e) }
      }
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
