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
}
