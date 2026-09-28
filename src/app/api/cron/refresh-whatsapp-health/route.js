// WA-NUMBER-HEALTH — Vercel cron, every 30 min.
//
// Fetches each active WhatsApp number's quality rating + messaging-limit tier from
// the Meta Graph API, stores it on whatsapp_numbers (mig 329) so the
// /communications dashboard stays fast, and pushes an alert to owners/managers when
// the rating drops (or the tier is downgraded). Best-effort per number — a token
// without whatsapp_business_management scope stores null + logs (the dashboard then
// shows "unavailable") rather than failing the whole run.
//
// WA-QUALITY.5 — the webhook path (whatsapp-number-events) auto-pauses in-flight
// drips on FLAGGED, but this poll can be FIRST to record RED. A poll-observed
// transition into RED/FLAGGED now triggers the SAME auto-pause (shared
// pauseLocationDrips helper — extracted, not copied) + manager page.
//
// WA-TOKEN.1 — a dying System User token used to degrade to "unavailable" here
// and only surface when sends failed. Meta auth failures (error 190 /
// OAuthException) are now classified distinctly: whatsapp_numbers.token_invalid_at
// (mig 393) is stamped on the transition INTO invalid, cleared when a health
// fetch succeeds again, and managers are paged ONCE per transition (never every
// poll tick).
//
// C21 PUSHDONE.1 — the alerts ride on a state TRANSITION (prev rating vs new,
// token_invalid_at), and that state is written whatever the push does,
// because the dashboard, the drip auto-pause and the send paths all read it.
// Holding the state back to re-trigger the alert would show a stale rating
// and re-run the drip pause, so a push that reached nobody is NOT retried: it
// is logged at error level (logError 'wa-health') and counted in
// `alert_failed`, and `alerted` now counts only alerts that reached someone.
// The protective action (the drip auto-pause) never depended on the push.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { pushOutcome } from '@/lib/push-outcome'
import { logWarn, logError } from '@/lib/log'
import { ADMIN_ROLES } from '@/lib/schemas'
import {
  fetchNumberHealth, healthDowngradeReason, pollQualityPauseReason,
  isMetaAuthError, tokenTransition, tokenInvalidNotification, tokenRecoveredNotification,
} from '@/lib/whatsapp-number-health'
import { pauseLocationDrips, dripPauseNote } from '@/lib/whatsapp-number-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request) { return GET(request) }

// Best-effort manager push — an alert failure never fails the poll.
// C21 PUSHDONE.1 — returns the push outcome ('delivered' | 'settled' |
// 'failed'); a failed one is said at error level (see the header).
async function tryPush(locationId, payload, numberId) {
  let result = null
  try {
    result = await sendPushToRolesAtLocation(locationId, ADMIN_ROLES, payload)
  } catch (e) {
    logWarn('wa-health', 'alert push threw', { number_id: numberId, err: e?.message || String(e) })
  }
  const outcome = pushOutcome(result)
  if (outcome === 'failed') {
    logError('wa-health', 'health alert reached nobody; the new state is recorded, the alert is not retried', {
      number_id: numberId, alert: payload?.data?.type ?? null, read_failed: !!result?.read_failed,
    })
  }
  return outcome
}

// A state write the poll cannot stop for. Logged; the next poll writes again.
async function writeNumberState(db, id, patch) {
  const { error } = await db.from('whatsapp_numbers').update(patch).eq('id', id)
  if (error) logWarn('wa-health', 'health state write failed', { number_id: id, err: error.message })
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: numbers } = await db.from('whatsapp_numbers')
    .select('id, location_id, label, access_token, phone_number_id, quality_rating, messaging_limit_tier, token_invalid_at')
    .eq('is_active', true)

  let checked = 0, alerted = 0, alertFailed = 0, errors = 0, pausedDrips = 0
  const tally = (outcome) => {
    if (outcome === 'delivered') alerted++
    else if (outcome === 'failed') alertFailed++
  }
  for (const n of numbers || []) {
    if (!n.access_token || !n.phone_number_id) continue
    try {
      const health = await fetchNumberHealth({ phoneNumberId: n.phone_number_id, token: n.access_token })
      const reason = healthDowngradeReason(n, health)

      // A successful Graph call proves the token works — clear any invalid stamp.
      await writeNumberState(db, n.id, {
        quality_rating: health.quality_rating,
        messaging_limit_tier: health.messaging_limit_tier,
        name_status: health.name_status,
        quality_checked_at: new Date().toISOString(),
        token_invalid_at: null,
      })
      checked++

      // WA-TOKEN.1 — recovery page, once per transition (gated on the old stamp).
      if (tokenTransition(n.token_invalid_at, false) === 'recovered' && n.location_id) {
        const notify = tokenRecoveredNotification(n.label)
        tally(await tryPush(n.location_id, {
          title: notify.title, body: notify.body,
          category: 'whatsapp', data: { type: 'wa_token', number_id: n.id },
        }, n.id))
      }

      // WA-QUALITY.5 — poll-observed collapse into RED/FLAGGED pauses the
      // location's in-flight drips, exactly like the webhook path. Best-effort:
      // a pause failure must not stop the poll (the push below still warns).
      const pauseReason = pollQualityPauseReason(n.quality_rating, health.quality_rating)
      let pausedBroadcasts = []
      if (pauseReason && n.location_id) {
        try {
          pausedBroadcasts = await pauseLocationDrips(db, n.location_id)
          pausedDrips += pausedBroadcasts.length
        } catch (e) {
          console.error(`[wa-health] drip auto-pause failed for ${n.id}:`, e?.message || e)
        }
      }

      // Alert on a genuine downgrade, or on a collapse the downgrade check
      // misses (first-seed RED: prev null isn't a "downgrade" but IS an
      // emergency). Never on a healthy first seed. Best-effort.
      const alertReason = reason || pauseReason
      if (alertReason && n.location_id) {
        const note = dripPauseNote(pausedBroadcasts, pauseReason || alertReason)
        tally(await tryPush(n.location_id, {
          title: `WhatsApp health: ${n.label || 'number'}`,
          body: `${alertReason}. Ease off sends and check Meta Business Manager.${note ? ` ${note}` : ''}`,
          category: 'whatsapp',
          data: { type: 'wa_quality', number_id: n.id },
        }, n.id))
      }
    } catch (e) {
      // Bad/expired token, missing scope, Meta hiccup — keep going.
      errors++
      const nowIso = new Date().toISOString()
      if (isMetaAuthError(e)) {
        // WA-TOKEN.1 — dead token. Stamp + page on the TRANSITION only; a
        // token already known-invalid just refreshes quality_checked_at.
        if (tokenTransition(n.token_invalid_at, true) === 'invalidated') {
          await writeNumberState(db, n.id, { token_invalid_at: nowIso, quality_checked_at: nowIso })
          if (n.location_id) {
            const notify = tokenInvalidNotification(n.label)
            tally(await tryPush(n.location_id, {
              title: notify.title, body: notify.body,
              category: 'whatsapp', data: { type: 'wa_token', number_id: n.id },
            }, n.id))
          }
        } else {
          await writeNumberState(db, n.id, { quality_checked_at: nowIso })
        }
      } else {
        // Non-auth failure — store nothing beyond the check stamp (dashboard
        // shows "unavailable"), never touch token_invalid_at.
        await writeNumberState(db, n.id, { quality_checked_at: nowIso })
      }
      console.error(`[wa-health] fetch failed for ${n.id}:`, e?.message || e)
    }
  }

  await stampHeartbeat('refresh-whatsapp-health').catch(() => {})
  return NextResponse.json({ ok: true, checked, alerted, alert_failed: alertFailed, errors, pausedDrips })
}
