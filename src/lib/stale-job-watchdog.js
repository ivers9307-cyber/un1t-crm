// STALEWATCH.1 (15 Nov 2026 feature audit, area 21) — the in-CRM watchdog for
// background jobs. Runs every 15 minutes (/api/cron/stale-job-watchdog).
//
// Why: /api/cron/health-check answers one bit (any heartbeat stale -> 503) to an
// outside monitor. It had been red since 21 Sep for one known fault, so two
// later stale jobs changed nothing anyone could see, and nothing inside the
// CRM alerted at all.
//
// What it does each tick, from public.cron_health (mig 053, columns from 843):
//   - a job that is stale and NOT acknowledged, and has not been alerted on
//     for this stale episode, is alerted ONCE: one message to every active
//     master (email + uncategorised push), and one error_events row per job
//     (route_type 'cron_stale') so Sentinel's error-events watcher sees it.
//     stale_alerted_at is stamped only once someone was reached, so a failed
//     delivery is retried next tick.
//   - a job that has recovered has its stale_alerted_at cleared, so its next
//     stale episode alerts again.
//   - once a day, at the first tick from 08:00 Dublin, one digest of every
//     job still stale (acknowledged ones included, marked) with its age.
// Acknowledged rows (acknowledged_until in the future) neither alert nor hold
// the health check red; the acknowledgement simply runs out.

import { sendTransactionalEmail } from '@/lib/postmark'
import { sendPush } from '@/lib/push'
import { excludeTombstones } from '@/lib/staff-tombstone'
import { recordErrorEvent } from '@/lib/error-events'
import { logError, logWarn } from '@/lib/log'
import { PLATFORM_TZ, instantToZonedParts, dayStrIn } from '@/lib/location-time'

export const WATCHDOG_NAME = 'stale-job-watchdog'
export const DIGEST_CLAIM_NAME = 'stale-job-watchdog-digest'
export const DIGEST_HOUR = 8 // Dublin wall clock

const HEALTH_COLUMNS =
  'name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale, is_acknowledged, acknowledged_until, acknowledged_note, stale_alerted_at'

/** "3d", "5h", "12m" for a number of seconds. */
export function formatAge(seconds) {
  const s = Number(seconds) || 0
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 172800) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/**
 * Pure: what this tick must do.
 * @param {object[]} rows cron_health rows
 * @returns {{ newlyStale: object[], recovered: object[], stillStale: object[] }}
 */
export function planWatchdog(rows) {
  const list = Array.isArray(rows) ? rows : []
  const live = list.filter((r) => r.is_stale && !r.is_acknowledged)
  const newlyStale = live.filter((r) => {
    if (!r.stale_alerted_at) return true
    // Alerted on an EARLIER episode that recovered between ticks: a new one.
    return r.last_ok_at && Date.parse(r.stale_alerted_at) < Date.parse(r.last_ok_at)
  })
  const recovered = list.filter((r) => !r.is_stale && r.stale_alerted_at)
  const stillStale = list.filter((r) => r.is_stale)
  return { newlyStale, recovered, stillStale }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** Pure: the alert for jobs that newly went stale. */
export function newlyStaleMessage(rows) {
  const names = rows.map((r) => r.name)
  const subject = rows.length === 1
    ? `Background job stale: ${names[0]}`
    : `${rows.length} background jobs stale`
  const items = rows.map((r) => `<li><strong>${esc(r.name)}</strong>: no successful run for ${formatAge(r.stale_seconds)} (expected within ${formatAge(r.max_allowed_seconds)})</li>`).join('')
  const htmlBody = `<p>These background jobs have stopped succeeding:</p><ul>${items}</ul>`
    + '<p>Open Admin, then Health, to see every job. A known fault can be acknowledged there so it stops alerting.</p>'
  const pushBody = rows.length === 1
    ? `${names[0]}: no successful run for ${formatAge(rows[0].stale_seconds)}.`
    : `${names.slice(0, 3).join(', ')}${rows.length > 3 ? ` and ${rows.length - 3} more` : ''} have stopped succeeding.`
  return { subject, htmlBody, pushBody }
}

/** Pure: the daily digest of every job still stale. */
export function digestMessage(rows) {
  const sorted = [...rows].sort((a, b) => (b.stale_seconds || 0) - (a.stale_seconds || 0))
  const items = sorted.map((r) => {
    const ack = r.is_acknowledged
      ? ` <em>(acknowledged until ${esc(String(r.acknowledged_until).slice(0, 10))}${r.acknowledged_note ? `: ${esc(r.acknowledged_note)}` : ''})</em>`
      : ''
    return `<li><strong>${esc(r.name)}</strong>: stale for ${formatAge(r.stale_seconds)}${ack}</li>`
  }).join('')
  const open = sorted.filter((r) => !r.is_acknowledged).length
  return {
    subject: `Background jobs: ${sorted.length} still stale (${open} not acknowledged)`,
    htmlBody: `<p>Background jobs still not succeeding, longest first:</p><ul>${items}</ul>`,
    pushBody: `${sorted.length} background job${sorted.length === 1 ? '' : 's'} still stale, ${open} not acknowledged.`,
  }
}

/**
 * Email + uncategorised push to every active, non-tombstoned master. Never
 * throws. Returns whether anyone was reached.
 */
export async function alertMasters(db, { subject, htmlBody, pushBody }) {
  let masters
  try {
    const { data, error } = await excludeTombstones(db.from('profiles').select('id, email').eq('role', 'master').eq('active', true))
    if (error) throw error
    masters = data || []
  } catch (err) {
    logError('stale-job-watchdog', 'masters unreadable: the stale-job alert reached nobody', { err })
    return false
  }
  let delivered = false
  const ids = masters.map((m) => m.id).filter(Boolean)
  if (ids.length) {
    try {
      const res = await sendPush(ids, { title: subject, body: pushBody, data: { type: 'stale_job' } })
      if ((res?.sent ?? 0) > 0) delivered = true
    } catch (err) {
      logWarn('stale-job-watchdog', 'push to masters failed', { err })
    }
  }
  for (const to of masters.map((m) => m.email).filter(Boolean)) {
    try {
      await sendTransactionalEmail({ to, subject, htmlBody, tag: 'ops-alert' })
      delivered = true
    } catch (err) {
      logWarn('stale-job-watchdog', 'email to a master failed', { err })
    }
  }
  return delivered
}

/** Claim today's digest once (Dublin day). True when this tick won it. */
async function claimDigest(db, day) {
  const { data, error } = await db.from('cron_daily_slot_claims')
    .upsert([{ cron_name: DIGEST_CLAIM_NAME, scope: 'none', slot_day: day, location_id: null, zone: PLATFORM_TZ }],
      { onConflict: 'cron_name,scope,slot_day', ignoreDuplicates: true })
    .select('scope')
  if (error) {
    logWarn('stale-job-watchdog', 'digest claim failed; no digest this tick', { err: error })
    return false
  }
  return (data || []).length > 0
}

/**
 * One watchdog tick.
 * @returns {Promise<{ ok: boolean, newlyStale?: string[], alerted?: boolean, recovered?: string[], digest?: string, stale?: number }>}
 */
export async function runStaleJobWatchdog(db, { nowMs = Date.now(), alert = alertMasters, recordError = recordErrorEvent } = {}) {
  const { data: rows, error } = await db.from('cron_health').select(HEALTH_COLUMNS).order('name')
  if (error) {
    logError('stale-job-watchdog', 'cron_health unreadable; nothing judged this tick', { err: error })
    return { ok: false }
  }
  const all = (rows || []).filter((r) => r.name !== WATCHDOG_NAME)
  const { newlyStale, recovered, stillStale } = planWatchdog(all)
  const nowIso = new Date(nowMs).toISOString()

  let alerted = false
  if (newlyStale.length) {
    alerted = await alert(db, newlyStaleMessage(newlyStale))
    for (const r of newlyStale) {
      try {
        await recordError({
          route_type: 'cron_stale',
          route_path: `cron:${r.name}`,
          method: null,
          name: 'cron_stale',
          message: `${r.name}: no successful run for ${formatAge(r.stale_seconds)}`.slice(0, 500),
          runtime: process.env.NEXT_RUNTIME || null,
          vercel_id: null,
          digest: null,
        })
      } catch { /* observability never stops the watchdog */ }
    }
    if (alerted) {
      const { error: markErr } = await db.from('cron_heartbeats')
        .update({ stale_alerted_at: nowIso })
        .in('name', newlyStale.map((r) => r.name))
      if (markErr) logWarn('stale-job-watchdog', 'could not record the alert; it may repeat next tick', { err: markErr })
    }
  }

  if (recovered.length) {
    const { error: clearErr } = await db.from('cron_heartbeats')
      .update({ stale_alerted_at: null })
      .in('name', recovered.map((r) => r.name))
    if (clearErr) logWarn('stale-job-watchdog', 'could not clear recovered alerts', { err: clearErr })
  }

  let digest = 'not_due'
  if (instantToZonedParts(nowMs, PLATFORM_TZ).h >= DIGEST_HOUR) {
    const won = await claimDigest(db, dayStrIn(nowMs, PLATFORM_TZ))
    if (!won) digest = 'already_sent'
    else if (stillStale.length === 0) digest = 'nothing_stale'
    else digest = (await alert(db, digestMessage(stillStale))) ? 'sent' : 'undelivered'
  }

  return {
    ok: true,
    newlyStale: newlyStale.map((r) => r.name),
    alerted,
    recovered: recovered.map((r) => r.name),
    digest,
    stale: stillStale.length,
  }
}
