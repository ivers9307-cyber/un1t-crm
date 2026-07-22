// FEAT-INTEG-HEALTH.1 — one pane for "is anything silently broken?".
//
// Consolidates the signals that already exist but are scattered, into per-
// integration rows with a red/amber/green status. Does NOT rebuild the
// underlying checks — it reads:
//   - cron_health view (mig 053): per-cron heartbeat staleness (global).
//   - whatsapp_numbers: Meta quality/tier + token validity (per location).
//   - webhook_dead_letter (mig 315): un-replayed webhook backlog (per location).
//
// Status vocabulary: 'ok' | 'warn' | 'down' | 'unknown'.

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

  return rows
}
