// GET /api/public/presentations/[token]/state — NO auth (token IS the auth).
// The viewer polls this every 4s (PresentViewer POLL_MS); soft-swaps the slide
// when `version` changes.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bucketUrl(path) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides/${path}`
}

export async function GET(request, { params }) {
  const { token } = await params
  if (!token) return NextResponse.json({ success: false, error: 'missing_token' }, { status: 400 })
  const db = createServerClient()

  // Abuse limiter (audit H2a) — POLLED route: the viewer polls every 4s
  // (≈15 req/min per screen). 240-per-minute per token+IP is the tv-live
  // polled-route convention, 16x headroom for one screen — enough for several
  // audience devices behind one venue NAT while still capping enumeration and
  // floods. Keyed token+IP so one deck's viewers can't starve another's, and
  // run BEFORE the token lookup so enumeration attempts are still capped.
  // Fails open inside checkRateLimit — a limiter outage must never blank a
  // live presentation.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `present-state:${token}:${ip}`, { max: 240, windowMs: 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data: deck } = await db
    .from('presentations')
    .select('id, title, current_index, version')
    .eq('view_token', token)
    .maybeSingle()
  if (!deck) return NextResponse.json({ success: false, error: 'invalid_token' }, { status: 404 })
  const { data: slides } = await db
    .from('presentation_slides')
    .select('image_path')
    .eq('presentation_id', deck.id)
    .order('position', { ascending: true })
  return NextResponse.json({
    success: true,
    title: deck.title,
    current_index: deck.current_index,
    version: deck.version,
    slides: (slides || []).map((s) => bucketUrl(s.image_path)),
  })
}
