// WA-NUMBER-HEALTH — Vercel cron, every 30 min.
//
// Fetches each active WhatsApp number's quality rating + messaging-limit tier from
// the Meta Graph API, stores it on whatsapp_numbers (mig 329) so the
// /communications dashboard stays fast, and pushes an alert to owners/managers when
// the rating drops (or the tier is downgraded). Best-effort per number — a token
// without whatsapp_business_management scope stores null + logs (the dashboard then
// shows "unavailable") rather than failing the whole run.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { ADMIN_ROLES } from '@/lib/schemas'
import { fetchNumberHealth, healthDowngradeReason } from '@/lib/whatsapp-number-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: numbers } = await db.from('whatsapp_numbers')
    .select('id, location_id, label, access_token, phone_number_id, quality_rating, messaging_limit_tier')
    .eq('is_active', true)

  let checked = 0, alerted = 0, errors = 0
  for (const n of numbers || []) {
    if (!n.access_token || !n.phone_number_id) continue
    try {
      const health = await fetchNumberHealth({ phoneNumberId: n.phone_number_id, token: n.access_token })
      const reason = healthDowngradeReason(n, health)

      await db.from('whatsapp_numbers').update({
        quality_rating: health.quality_rating,
        messaging_limit_tier: health.messaging_limit_tier,
        name_status: health.name_status,
        quality_checked_at: new Date().toISOString(),
      }).eq('id', n.id)
      checked++

      // Alert on a genuine downgrade only (never on the first seed). Best-effort.
      if (reason && n.location_id) {
        try {
          await sendPushToRolesAtLocation(n.location_id, ADMIN_ROLES, {
            title: `WhatsApp health: ${n.label || 'number'}`,
            body: `${reason}. Ease off sends and check Meta Business Manager.`,
            category: 'whatsapp',
            data: { type: 'wa_quality', number_id: n.id },
          })
          alerted++
        } catch (e) {
          console.error(`[wa-health] alert failed for ${n.id}:`, e?.message || e)
        }
      }
    } catch (e) {
      // Bad/expired token, missing scope, Meta hiccup — store nothing, keep going.
      errors++
      await db.from('whatsapp_numbers').update({ quality_checked_at: new Date().toISOString() }).eq('id', n.id)
      console.error(`[wa-health] fetch failed for ${n.id}:`, e?.message || e)
    }
  }

  await stampHeartbeat('refresh-whatsapp-health').catch(() => {})
  return NextResponse.json({ ok: true, checked, alerted, errors })
}
