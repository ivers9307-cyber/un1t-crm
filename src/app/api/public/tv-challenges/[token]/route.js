// GET /api/public/tv-challenges/[token]
//
// W0.9a — token-gated entrypoint for the in-studio challenge TV board. Same
// payload as /api/public/challenges/[locationId], but the caller presents an
// opaque tv_displays.token instead of a guessable location UUID — exactly the
// model /api/public/tv-live/[token] uses for the live HR board (P0-3, mig 160).
//
// No auth header — the token IS the auth (kiosk browsers can't supply
// cookies). Invalid / inactive tokens return 404 (never reveal whether a token
// or location exists). Rate-limited per token + IP and no-store.
//
// The location endpoint stays live during the transition (W0.9b moves the
// kiosks, W0.9c removes the location-keyed routes).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { computeStandings, computeCollective } from '@/lib/challenges-io'
import { challengePhase, windowIso } from '@/lib/challenges'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const TOP = 25
const project = (standings) => standings.slice(0, TOP).map((r) => ({ name: r.name, value: r.value, rank: r.rank }))

export async function GET(request, props) {
  const params = await props.params
  const db = createServerClient()
  const token = params.token
  const nowMs = Date.now()

  if (!token) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // Abuse limiter (fail-open) — the challenge TV board polls every 45s
  // (ChallengeTvClient POLL_MS), ≈7 requests per 5 min, so 60-per-5-min gives a
  // legit board ~8x headroom while capping scripted hammering of a
  // standings-computation-heavy endpoint. Keyed on the token so one display
  // can't starve another's bucket. Runs BEFORE the token lookup so an
  // enumeration attempt is still capped.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `tv-challenges:${token}:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  // Resolve the opaque token → display → location. Only active displays. Invalid
  // token or inactive display → 404 (don't confirm existence of either).
  const { data: display } = await db
    .from('tv_displays')
    .select('location_id, active')
    .eq('token', token)
    .maybeSingle()
  if (!display || !display.active) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  const { data: location } = await db
    .from('locations')
    .select('id, name')
    .eq('id', display.location_id)
    .single()
  if (!location) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // From here on identical to /api/public/challenges/[locationId], scoped to
  // the location the TOKEN resolved to.
  const locationId = location.id

  const { data: defs } = await db.from('challenges')
    .select('id, name, mode, metric, starts_on, ends_on, target')
    .eq('location_id', locationId).order('ends_on', { ascending: true })

  const challenges = []
  for (const ch of defs || []) {
    if (challengePhase(ch, nowMs) !== 'active') continue
    const { fromIso, toIso } = windowIso(ch)
    // DECISION #1 (mig 348) — this is a PUBLIC render surface, so exclude
    // members who opted out of the leaderboard. They still score for
    // themselves and can still win (the run-challenge-events cron computes
    // winners WITHOUT this flag); they're just not shown on the TV board.
    if (ch.mode === 'collective') {
      const collective = await computeCollective(db, { locationId, metric: ch.metric, fromIso, toIso, target: ch.target, excludeOptedOut: true })
      challenges.push({ id: ch.id, name: ch.name, mode: 'collective', metric: ch.metric, endsOn: ch.ends_on, collective })
    } else {
      const standings = await computeStandings(db, { locationId, metric: ch.metric, fromIso, toIso, excludeOptedOut: true })
      challenges.push({ id: ch.id, name: ch.name, mode: 'individual', metric: ch.metric, endsOn: ch.ends_on, standings: project(standings) })
    }
  }

  const d = new Date(nowMs)
  const monthFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
  const gym = await computeStandings(db, { locationId, metric: 'points', fromIso: monthFrom, toIso: new Date(nowMs).toISOString(), excludeOptedOut: true })

  return NextResponse.json({
    ok: true, server_time: new Date().toISOString(),
    location: { id: location.id, name: location.name },
    challenges, gymBoard: project(gym),
  }, { headers: NO_STORE })
}
