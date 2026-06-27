// POST /api/admin/backfill-session-calories?location_id=&since=YYYY-MM-DD
// Master-gated. Recomputes calories_kcal for already-ended ble_bridge sessions
// in a recent window whose contact now has the body metrics. Bounded + logged.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveBodyMetrics } from '@/lib/body-metrics'
import { estimateCaloriesKcal } from '@/lib/calories'
import { selectAll } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster) return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const since = url.searchParams.get('since') || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })

  const db = createServerClient()
  let sessions
  try {
    sessions = await selectAll((from, to) => db
      .from('heart_rate_sessions')
      .select('id, contact_id, started_at, ended_at, avg_hr_bpm, calories_kcal')
      .eq('location_id', locationId)
      .eq('source', 'ble_bridge')
      .not('ended_at', 'is', null)
      .gte('started_at', `${since}T00:00:00Z`)
      // Order by the uuid pk, not started_at: pagination needs a deterministic
      // key or started_at ties straddling a page boundary skip/double-count
      // rows (same pattern as the achievements backfill on this table). Order
      // is irrelevant to a full-scan backfill anyway.
      .order('id', { ascending: true })
      .range(from, to))
  } catch (e) {
    return NextResponse.json({ success: false, error: `query failed: ${e.message}` }, { status: 500 })
  }

  let filled = 0, skipped = 0
  for (const s of sessions) {
    if (!s.contact_id || s.avg_hr_bpm == null) { skipped++; continue }
    const startMs = new Date(s.started_at).getTime()
    const endMs = new Date(s.ended_at).getTime()
    const durationMin = (endMs - startMs) / 60000
    const bm = await resolveBodyMetrics(db, s.contact_id, endMs)
    const kcal = estimateCaloriesKcal({ avgHr: s.avg_hr_bpm, durationMin, age: bm.age, weightKg: bm.weightKg, gender: bm.gender })
    if (kcal == null) { skipped++; continue }
    const { error } = await db.from('heart_rate_sessions').update({ calories_kcal: kcal }).eq('id', s.id)
    if (error) { skipped++; continue }
    filled++
  }

  return NextResponse.json({ success: true, data: { scanned: sessions.length, filled, skipped } })
}
