// GET /api/public/challenges/[locationId] — public (no auth, allow-listed in
// middleware). Powers the in-studio challenge TV board. Active challenges' top-25
// standings (projected: name first+last-initial, value, rank — NO contact ids) +
// collective progress, plus the current-month gym board fallback.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { computeStandings, computeCollective } from '@/lib/challenges-io'
import { challengePhase, windowIso } from '@/lib/challenges'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOP = 25
const project = (standings) => standings.slice(0, TOP).map((r) => ({ name: r.name, value: r.value, rank: r.rank }))

export async function GET(_request, props) {
  const params = await props.params
  const db = createServerClient()
  const locationId = params.locationId
  const nowMs = Date.now()

  const { data: location } = await db.from('locations').select('id, name').eq('id', locationId).single()
  if (!location) return NextResponse.json({ ok: false, error: 'Location not found' }, { status: 404 })

  const { data: defs } = await db.from('challenges')
    .select('id, name, mode, metric, starts_on, ends_on, target')
    .eq('location_id', locationId).order('ends_on', { ascending: true })

  const challenges = []
  for (const ch of defs || []) {
    if (challengePhase(ch, nowMs) !== 'active') continue
    const { fromIso, toIso } = windowIso(ch)
    if (ch.mode === 'collective') {
      const collective = await computeCollective(db, { locationId, metric: ch.metric, fromIso, toIso, target: ch.target })
      challenges.push({ id: ch.id, name: ch.name, mode: 'collective', metric: ch.metric, endsOn: ch.ends_on, collective })
    } else {
      const standings = await computeStandings(db, { locationId, metric: ch.metric, fromIso, toIso })
      challenges.push({ id: ch.id, name: ch.name, mode: 'individual', metric: ch.metric, endsOn: ch.ends_on, standings: project(standings) })
    }
  }

  const d = new Date(nowMs)
  const monthFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
  const gym = await computeStandings(db, { locationId, metric: 'points', fromIso: monthFrom, toIso: new Date(nowMs).toISOString() })

  return NextResponse.json({
    ok: true, server_time: new Date().toISOString(),
    location: { id: location.id, name: location.name },
    challenges, gymBoard: project(gym),
  })
}
