// GET /api/public/challenges/[locationId] — public (no auth, allow-listed in
// middleware). Powers the in-studio challenge TV board. Active challenges' top-25
// standings (projected: name first+last-initial, value, rank — NO contact ids) +
// collective progress, plus the current-month gym board fallback.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { computeStandings, computeCollective } from '@/lib/challenges-io'
import { challengePhase, windowIso } from '@/lib/challenges'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOP = 25
const project = (standings) => standings.slice(0, TOP).map((r) => ({ name: r.name, value: r.value, rank: r.rank }))

export async function GET(request, props) {
  const params = await props.params
  const db = createServerClient()
  const locationId = params.locationId
  const nowMs = Date.now()

  // Abuse limiter (audit H2a) — the challenge TV board polls this every 45s
  // (ChallengeTvClient POLL_MS), ≈7 requests per 5 min, so 60-per-5-min gives a
  // legit board ~8x headroom while capping scripted hammering of a
  // standings-computation-heavy endpoint. Keyed per location+IP (SAAS-6) so one
  // studio's board can't starve another's. Fails open inside checkRateLimit —
  // a limiter outage must never black out the TV.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `pubchallenges:${locationId}:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data: location } = await db.from('locations').select('id, name').eq('id', locationId).single()
  if (!location) return NextResponse.json({ ok: false, error: 'Location not found' }, { status: 404 })

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
  })
}
