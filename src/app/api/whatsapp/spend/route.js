// GET /api/whatsapp/spend?location_id=&months=3 — WhatsApp spend telemetry.
// Local rollup of per-message PMP pricing fields (mig 341, via the
// whatsapp_spend_rollup RPC — supabase-js can't GROUP BY and the 1k-row cap
// forbids fetching rows) plus Meta's own pricing_analytics (actual cost) when
// the location's number is configured. Registered in src/lib/openapi.js.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fetchPricingAnalytics } from '@/lib/whatsapp-pricing'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const months = Math.min(Math.max(parseInt(searchParams.get('months') || '3', 10) || 3, 1), 12)
  const sinceMs = Date.now() - months * 30 * 24 * 60 * 60 * 1000
  const since = new Date(sinceMs)

  const db = createServerClient()

  let rollup = []
  try {
    const { data } = await db.rpc('whatsapp_spend_rollup', { p_location_id: locationId, p_since: since.toISOString() })
    rollup = data || []
  } catch (e) {
    console.error('[wa-spend] rollup failed:', e?.message)
  }

  // Meta's authoritative cost figures — optional enrichment; null when the
  // number isn't configured or the API errors.
  let meta = null
  try {
    // WAORGNUMBER.1 — the WABA + token of the number switched on at THIS studio
    // (link default first), whatever its home. A lookup that throws is lost
    // enrichment, logged below.
    const num = await getLocationWhatsAppNumberConfig(locationId)
    if (num?.businessAccountId && num?.token) {
      meta = await fetchPricingAnalytics(
        { wabaId: num.businessAccountId, accessToken: num.token },
        { start: Math.floor(sinceMs / 1000), end: Math.floor(Date.now() / 1000), granularity: 'MONTHLY' },
      )
    }
  } catch (e) {
    console.error('[wa-spend] pricing_analytics failed:', e?.message)
  }

  return NextResponse.json({ success: true, data: { months, since: since.toISOString(), rollup, meta } })
}
