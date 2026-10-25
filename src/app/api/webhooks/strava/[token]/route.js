// Strava push webhook. GET = subscription handshake (verify_token + echo challenge).
// POST = activity events. Strava does NOT sign webhook POSTs (events carry only ids,
// no sensitive data); we act only on owner_ids we have a token for and fetch detail
// with that member's own token. Always 200 fast so Strava doesn't disable the sub.
//
// W0.10 — because Strava never signs its POSTs, the URL token IS the shared
// secret (same model as postmark-inbound/[token]): the path segment must equal
// STRAVA_WEBHOOK_URL_TOKEN, compared constant-time. Without it anyone who knew
// a connected athlete's id could trigger fetch/ingest/delete of that athlete's
// activities. Wrong or missing token: GET 403, POST 404 (never confirm the
// route exists). Fails CLOSED when the env is unset. POST is additionally
// rate-limited per IP (120/min) before any DB read. The push subscription's
// callback_url must carry the token: https://crm.repset.ie/api/webhooks/strava/<token>
// (docs/domain-migration-stage3.md §5a has the curl).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { loadStravaConfig, ingestActivity } from '@/lib/strava-import'
import { safeEqual } from '@/lib/webhook-auth'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function tokenOk(params) {
  const expected = process.env.STRAVA_WEBHOOK_URL_TOKEN || ''
  return expected.length > 0 && safeEqual(String(params?.token || ''), expected)
}

export async function GET(request, props) {
  const params = await props.params
  if (!tokenOk(params)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const u = new URL(request.url)
  if (u.searchParams.get('hub.mode') === 'subscribe'
    && u.searchParams.get('hub.verify_token') === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.json({ 'hub.challenge': u.searchParams.get('hub.challenge') })
  }
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}

export async function POST(request, props) {
  const params = await props.params
  if (!tokenOk(params)) return NextResponse.json({ success: false }, { status: 404 })

  const db = createServerClient()
  const limit = await checkRateLimit(db, `strava-webhook:${getClientIp(request)}`, { max: 120, windowMs: 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  let evt
  try { evt = await request.json() } catch { return NextResponse.json({ success: true }) }
  if (evt?.object_type !== 'activity') return NextResponse.json({ success: true, ignored: 'non_activity' })

  // Resolve the member by athlete id. Defence-in-depth against duplicate active
  // rows: even though mig 312's unique index now prevents them, order
  // newest-first + limit(1) so maybeSingle() can never throw on a stray dupe
  // (the failure mode that silently killed real-time ingest pre-mig-312).
  const { data: connection } = await db
    .from('contact_external_integrations')
    .select('id, contact_id, external_athlete_id, access_token, refresh_token, expires_at')
    .eq('provider', 'strava')
    .eq('external_athlete_id', String(evt.owner_id))
    .is('disconnected_at', null)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!connection?.contact_id) return NextResponse.json({ success: true, skipped: 'unknown_athlete' })

  try {
    if (evt.aspect_type === 'delete') {
      await db.from('strava_activities').delete()
        .eq('contact_id', connection.contact_id).eq('strava_activity_id', String(evt.object_id))
      return NextResponse.json({ success: true, deleted: String(evt.object_id) })
    }
    // create | update
    const config = await loadStravaConfig(db)
    if (!config) return NextResponse.json({ success: true, skipped: 'not_configured' })
    const r = await ingestActivity(db, { connection, activityId: evt.object_id, config })
    return NextResponse.json({ success: true, ...r })
  } catch (e) {
    console.warn(`[strava-webhook] ingest failed for activity ${evt.object_id}: ${e?.message || e}`)
    return NextResponse.json({ success: true, skipped: 'ingest_error' })
  }
}
