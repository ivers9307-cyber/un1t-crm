// FEAT-INTEG-HEALTH.1 — one pane for "is anything silently broken?".
//
// Consolidates the signals that already exist but are scattered, into per-
// integration rows with a red/amber/green status. Does NOT rebuild the
// underlying checks — it reads:
//   - cron_health view (mig 053): per-cron heartbeat staleness (global).
//   - whatsapp_numbers: Meta quality/tier + token validity (per location).
//   - webhook_dead_letter (mig 315): un-replayed webhook backlog (per location).
//   - channel_connections (getConnection): Glofox connection state (per loc).
//   - xero_connections: Xero OAuth binding + last sync error (per location).
//   - email_sends: Postmark bounce/complaint rate over 24h (per location).
//
// FEAT-INTEG-HEALTH.2 also attaches a runbook to every non-ok row — a short
// `remedy` line (what to do) plus an in-app `href` to the fix surface where
// one exists — so the pane is actionable, not just diagnostic.
//
// Status vocabulary: 'ok' | 'warn' | 'down' | 'unknown'.

import { getConnection } from '@/lib/connection-registry'
import { gradeXeroConnection } from '@/lib/integrations-hub'

// ── Pure status helpers (unit-tested) ─────────────────────────────────

export function cronStatus(rows) {
  const list = Array.isArray(rows) ? rows : []
  const stale = list.filter((r) => r?.is_stale)
  if (list.length === 0) return { status: 'unknown', staleCount: 0, worstLag: 0, staleNames: [] }
  if (stale.length === 0) return { status: 'ok', staleCount: 0, worstLag: 0, staleNames: [] }
  const worstLag = Math.max(...stale.map((r) => Number(r?.stale_seconds) || 0))
  return { status: 'down', staleCount: stale.length, worstLag, staleNames: stale.map((r) => r?.name).filter(Boolean) }
}

export function waNumberStatus(num) {
  if (!num) return { status: 'unknown', detail: '—' }
  // A dead token silently kills every send — the audit's headline integration pain.
  if (num.token_invalid_at) return { status: 'down', detail: 'Access token invalid — re-auth needed' }
  const q = String(num.quality_rating || '').toUpperCase()
  if (q === 'RED') return { status: 'down', detail: 'Quality rating: RED' }
  if (q === 'YELLOW') return { status: 'warn', detail: 'Quality rating: YELLOW' }
  return { status: 'ok', detail: q ? `Quality rating: ${q}` : 'Active' }
}

export function backlogStatus(count) {
  const n = Number(count) || 0
  if (n === 0) return { status: 'ok' }
  if (n < 10) return { status: 'warn' }
  return { status: 'down' }
}

// channel_connections / xero grade vocabulary → this pane's vocabulary.
const REGISTRY_TO_HEALTH = { connected: 'ok', action_needed: 'warn', error: 'down', not_connected: 'unknown' }
export function registryHealth(status) {
  return REGISTRY_TO_HEALTH[status] || 'unknown'
}

// Payment health over a 7d window (lower volume than email). race_payments
// records a hard failure as failed_at — a genuine provider error, distinct
// from customer 'abandoned' (walking away isn't a fault). Small-sample
// guarded, and thresholds are tight because a failing checkout is high-impact.
export function paymentStatus({ total = 0, failed = 0 } = {}) {
  const t = Number(total) || 0
  const f = Number(failed) || 0
  if (t === 0) return { status: 'ok', detail: 'No payments in last 7 days' }
  const rate = f / t
  const pct = Math.round(rate * 100)
  if (t < 8) {
    if (f > 0) return { status: 'warn', detail: `${f} of ${t} payment${t === 1 ? '' : 's'} failed (7d)` }
    return { status: 'ok', detail: `${t} processed (7d)` }
  }
  if (rate >= 0.2) return { status: 'down', detail: `${pct}% of payments failed — ${f}/${t} (7d)` }
  if (rate >= 0.08) return { status: 'warn', detail: `${pct}% of payments failed — ${f}/${t} (7d)` }
  return { status: 'ok', detail: `${t} processed, ${f} failed (7d)` }
}

// Postmark deliverability over a 24h window. Bounces + spam complaints hurt
// sender reputation, so a spike is the "silently broken" signal. Small-sample
// guarded: a couple of bounces out of a handful of sends isn't a provider
// problem, so the ratio is only graded once there's a meaningful sample —
// below that only an actual spam complaint is worth surfacing.
export function emailSendStatus({ total = 0, bounced = 0, complained = 0 } = {}) {
  const t = Number(total) || 0
  const b = Number(bounced) || 0
  const c = Number(complained) || 0
  if (t === 0) return { status: 'ok', detail: 'No email sent in last 24h' }
  const bad = b + c
  const rate = bad / t
  const pct = Math.round(rate * 100)
  if (t < 20) {
    if (c > 0) return { status: 'warn', detail: `${c} spam complaint${c === 1 ? '' : 's'} of ${t} sent (24h)` }
    return { status: 'ok', detail: `${t} sent, ${b} bounced (24h)` }
  }
  if (rate >= 0.15) return { status: 'down', detail: `${pct}% bounced/complained — ${bad}/${t} (24h)` }
  if (rate >= 0.05) return { status: 'warn', detail: `${pct}% bounced/complained — ${bad}/${t} (24h)` }
  return { status: 'ok', detail: `${t} sent, ${bad} bounced/complained (24h)` }
}

// Both zoom-contacts routes cap execution at maxDuration=300s (Vercel's hard
// limit on the function), so a run that is genuinely still executing is never
// older than that. The margin above it absorbs clock skew between this
// process and the DB, not uncertainty about the deadline itself.
export const ZOOM_RUN_GRACE_MS = 15 * 60 * 1000

/**
 * ZOOMOPS.1 — status from the most recent non-dry zoom_sync_runs row.
 *
 * A null finished_at OLDER than ZOOM_RUN_GRACE_MS is 'down': the run started
 * and never closed out, which means it crashed, and that is otherwise
 * invisible. A null finished_at YOUNGER than that is a run still in flight —
 * reporting that as 'down' would flag every currently-executing sync as
 * crashed, which is exactly the false alarm this pane must not raise. The
 * query that feeds this always hands over the newest non-dry row, so a
 * running trigger IS that row for the whole time it executes — this is the
 * ordinary shape of "checked the pane right after clicking Run now", not a
 * rare edge case.
 */
export function zoomSyncStatus(lastRun, nowMs = Date.now()) {
  if (!lastRun) return { status: 'unknown', detail: 'Never run' }
  if (lastRun.error) return { status: 'down', detail: `Last run failed: ${lastRun.error}` }
  if (!lastRun.finished_at) {
    const startedMs = lastRun.started_at ? new Date(lastRun.started_at).getTime() : NaN
    if (Number.isFinite(startedMs) && nowMs - startedMs < ZOOM_RUN_GRACE_MS) {
      return { status: 'unknown', detail: 'Run in progress' }
    }
    return { status: 'down', detail: 'Last run started but never finished' }
  }
  if (lastRun.guard_tripped) {
    return {
      status: 'warn',
      detail: `Deletion guard tripped — ${lastRun.guard_attempted} deletions refused (threshold ${lastRun.guard_threshold})`,
    }
  }
  const c = lastRun.creates ?? 0
  const u = lastRun.updates ?? 0
  const d = lastRun.deletes ?? 0
  return {
    status: 'ok',
    detail: `${lastRun.owned_in_zoom ?? 0} in directory · last run +${c} ~${u} -${d}`,
  }
}

// Worst status across a set of rows (for a roll-up badge).
const RANK = { down: 3, warn: 2, unknown: 1, ok: 0 }
export function worstStatus(rows) {
  return (rows || []).reduce((worst, r) => (RANK[r?.status] > RANK[worst] ? r.status : worst), 'ok')
}

function latestOkAt(rows) {
  return (rows || []).reduce((m, r) => (r?.last_ok_at && (!m || r.last_ok_at > m) ? r.last_ok_at : m), null)
}

// ── Aggregator (IO) ──────────────────────────────────────────────────

export async function getIntegrationHealth(db, locationId) {
  const rows = []

  // 1. Scheduled jobs — the cron_health view (global; crons fan out per tenant).
  try {
    const { data: crons } = await db.from('cron_health').select('name, last_ok_at, stale_seconds, is_stale')
    const c = cronStatus(crons)
    rows.push({
      key: 'crons',
      name: 'Scheduled jobs (crons)',
      status: c.status,
      lastSuccess: latestOkAt(crons),
      lagSeconds: c.worstLag,
      detail: c.status === 'ok'
        ? `${(crons || []).length} jobs healthy`
        : c.status === 'unknown'
          ? 'No heartbeat rows'
          : `${c.staleCount} stale: ${c.staleNames.slice(0, 4).join(', ')}${c.staleNames.length > 4 ? '…' : ''}`,
    })
  } catch { rows.push({ key: 'crons', name: 'Scheduled jobs (crons)', status: 'unknown', detail: 'Unavailable' }) }

  // 2. WhatsApp number(s) — per location (quality/tier + token validity).
  try {
    const { data: nums } = await db
      .from('whatsapp_numbers')
      .select('label, quality_rating, messaging_limit_tier, token_invalid_at, quality_checked_at')
      .eq('location_id', locationId)
      .eq('is_active', true)
    if ((nums || []).length === 0) {
      rows.push({ key: 'wa', name: 'WhatsApp', status: 'unknown', detail: 'No active number' })
    } else {
      for (const num of nums) {
        const s = waNumberStatus(num)
        rows.push({
          key: `wa:${num.label || 'number'}`,
          name: `WhatsApp — ${num.label || 'number'}`,
          status: s.status,
          lastSuccess: num.quality_checked_at || null,
          detail: s.detail,
        })
      }
    }
  } catch { rows.push({ key: 'wa', name: 'WhatsApp', status: 'unknown', detail: 'Unavailable' }) }

  // 3. Webhook processing backlog — un-replayed dead-letter rows (per location).
  try {
    const { count } = await db
      .from('webhook_dead_letter')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .is('resolved_at', null)
    const s = backlogStatus(count)
    rows.push({
      key: 'webhooks',
      name: 'Webhook processing',
      status: s.status,
      detail: (count || 0) === 0 ? 'No backlog' : `${count} un-replayed`,
    })
  } catch { rows.push({ key: 'webhooks', name: 'Webhook processing', status: 'unknown', detail: 'Unavailable' }) }

  // 4. Glofox — connection registry (only Stillorgan is connected today; other
  // locations legitimately read 'not connected' → unknown, not broken).
  try {
    const conn = await getConnection(db, locationId, 'glofox')
    rows.push({
      key: 'glofox',
      name: 'Glofox',
      status: registryHealth(conn.status),
      lastSuccess: conn.lastOkAt || null,
      detail:
        conn.status === 'connected'
          ? conn.externalAccountId ? `Connected · branch ${conn.externalAccountId}` : 'Connected'
          : conn.status === 'not_connected'
            ? 'Not connected'
            : conn.lastError ? String(conn.lastError).slice(0, 120) : 'Needs attention',
    })
  } catch { rows.push({ key: 'glofox', name: 'Glofox', status: 'unknown', detail: 'Unavailable' }) }

  // 5. Xero — OAuth binding + last sync error (per location). Token expiry is
  // NOT graded (tokens refresh lazily on use — see gradeXeroConnection).
  try {
    const { data: xrow } = await db
      .from('xero_connections')
      .select('tenant_id, tenant_name, accounts_sync_error, contacts_sync_error, tax_rates_sync_error, last_refreshed_at, accounts_last_synced_at')
      .eq('location_id', locationId)
      .maybeSingle()
    const g = gradeXeroConnection(xrow)
    rows.push({
      key: 'xero',
      name: 'Xero',
      status: registryHealth(g.status),
      lastSuccess: xrow?.accounts_last_synced_at || xrow?.last_refreshed_at || null,
      detail:
        g.status === 'connected'
          ? xrow?.tenant_name ? `Connected · ${xrow.tenant_name}` : 'Connected'
          : g.status === 'not_connected'
            ? 'Not connected'
            : g.message || 'Last sync failed',
    })
  } catch { rows.push({ key: 'xero', name: 'Xero', status: 'unknown', detail: 'Unavailable' }) }

  // 6. Email (Postmark) — bounce/complaint rate over the last 24h (per location).
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const base = () => db.from('email_sends').select('id', { count: 'exact', head: true }).eq('location_id', locationId).gte('created_at', sinceIso)
    const [totalRes, bouncedRes, complainedRes] = await Promise.all([
      base(),
      base().not('bounced_at', 'is', null),
      base().not('complained_at', 'is', null),
    ])
    const s = emailSendStatus({ total: totalRes.count, bounced: bouncedRes.count, complained: complainedRes.count })
    rows.push({ key: 'email', name: 'Email (Postmark)', status: s.status, detail: s.detail })
  } catch { rows.push({ key: 'email', name: 'Email (Postmark)', status: 'unknown', detail: 'Unavailable' }) }

  // 7. Payments — hard checkout failures over 7d. race_payments has no
  // location_id; scope via the parent race_event (inner join). NOT head:true —
  // an embedded-resource filter under a count-only select returns 0 (known
  // PostgREST trap), so fetch the (low-volume) rows and count in JS.
  try {
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: pays } = await db
      .from('race_payments')
      .select('failed_at, race_events!inner(location_id)')
      .eq('race_events.location_id', locationId)
      .gte('created_at', sinceIso)
      .limit(500)
    const total = (pays || []).length
    const failed = (pays || []).filter((p) => p.failed_at).length
    const s = paymentStatus({ total, failed })
    rows.push({ key: 'payments', name: 'Payments', status: s.status, detail: s.detail })
  } catch { rows.push({ key: 'payments', name: 'Payments', status: 'unknown', detail: 'Unavailable' }) }

  // 8. Zoom contact sync — organisation-level, not per location. One directory
  // serves every handset on the account, so the row is equally true at every
  // location in the synced org, and absent everywhere else. Unlike Glofox/
  // Xero/WhatsApp there is no per-org self-serve "connect" flow for Zoom (it
  // ships dark behind ZOOM_SYNC_ORGANIZATION_ID — see zoom/client.js) so an
  // unconfigured tenant renders nothing here rather than a "not connected"
  // row nobody at that org can act on; the dedicated settings page still
  // explains itself to a visitor who lands there directly.
  try {
    const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null
    if (syncOrgId) {
      const { data: loc } = await db
        .from('locations').select('organization_id').eq('id', locationId).maybeSingle()
      if (loc?.organization_id === syncOrgId) {
        const { data: runs } = await db
          .from('zoom_sync_runs')
          .select('started_at, finished_at, creates, updates, deletes, owned_in_zoom, guard_tripped, guard_attempted, guard_threshold, error')
          .eq('organization_id', syncOrgId)
          // A preview is not a run. Without this filter any manager can turn
          // this row green by clicking Preview — the exact falsely-reassuring
          // signal this pane exists to prevent.
          .eq('dry', false)
          .order('started_at', { ascending: false })
          .limit(1)
        const lastRun = (runs || [])[0] || null
        const s = zoomSyncStatus(lastRun)
        rows.push({
          key: 'zoom-contacts',
          name: 'Zoom phone directory',
          status: s.status,
          lastSuccess: lastRun?.finished_at || null,
          detail: s.detail,
          remedy: s.status === 'warn'
            ? 'Preview the run, read the numbers it wants to remove, then override the guard if they are genuinely gone.'
            : s.status === 'down'
              ? 'Open the sync page and preview a run to see the current error.'
              : undefined,
          href: '/settings/integrations/zoom-contacts',
        })
      }
    }
  } catch {
    // Match every other block: a broken check degrades to 'unknown' rather
    // than silently dropping the row (an omitted row is indistinguishable
    // from "not applicable to this org" — exactly the ambiguity this pane
    // exists to remove).
    rows.push({ key: 'zoom-contacts', name: 'Zoom phone directory', status: 'unknown', detail: 'Unavailable', href: '/settings/integrations/zoom-contacts' })
  }

  // Attach a runbook (remedy + fix link) to every degraded/down row so the pane
  // is actionable. Keyed by the row-key prefix; only surfaced when there's
  // genuinely something to do (warn/down — not ok, and not the ambiguous
  // 'unknown').
  for (const r of rows) {
    if (r.status !== 'warn' && r.status !== 'down') continue
    const rem = REMEDIES[String(r.key || '').split(':')[0]]
    if (rem) { r.remedy = rem.text; r.href = rem.href }
  }

  return rows
}

// Runbook content per integration — the "what do I do when this is red" line
// and the in-app fix surface (verified routes) where one exists.
const REMEDIES = {
  crons: { text: 'A scheduled job is stale. It usually clears on the next run; if it persists, check that job’s logs.', href: null },
  wa: { text: 'Re-authorise the WhatsApp number, or address the Meta message-quality rating, in Settings → Integrations.', href: '/settings/integrations-hub' },
  webhooks: { text: 'Replay the failed webhooks from the dead-letter queue.', href: null },
  glofox: { text: 'Reconnect Glofox in Settings → Integrations.', href: '/settings/integrations-hub' },
  xero: { text: 'Reconnect Xero in Settings → Integrations if the sync error persists.', href: '/settings/integrations-hub' },
  email: { text: 'A high bounce/complaint rate hurts deliverability — review recipients and your sending domain.', href: '/settings/email-domain' },
  payments: { text: 'Checkouts are failing — verify the payment provider (Revolut/Stripe) connection and recent transactions.', href: null },
}
