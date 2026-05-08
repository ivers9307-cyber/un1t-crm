// POST /api/admin/achievements/[id]/backfill
//
// Master-only: re-run a single rule against every contact who has at
// least one ended heart_rate_session, granting the achievement
// retroactively where it would have unlocked.
//
// Implementation note: we run this inline rather than queue. For a
// gym with O(1k) members and O(50) sessions each, the rule check is
// cheap (it's a couple of array sums). If the response time creeps
// above a few seconds in production we'll move to a job queue, but
// the batch-by-200 pattern below already keeps memory bounded.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logInfo, logWarn } from '@/lib/log'
import { buildAchievementContext, runDetectors } from '@/lib/achievements'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60   // upgrade timeout for the bigger sweep

const HISTORY_LOOKBACK_DAYS = 365

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

export async function POST(request, { params }) {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const id = params?.id
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })

  const db = createServerClient()
  const { data: rule, error: rErr } = await db
    .from('achievement_rules')
    .select('*')
    .eq('id', id)
    .single()
  if (rErr || !rule) {
    return NextResponse.json({ ok: false, error: 'Rule not found' }, { status: 404 })
  }

  const since = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()

  // 1) Distinct contact_ids with at least one ended session in window.
  const { data: contactRows } = await db
    .from('heart_rate_sessions')
    .select('contact_id')
    .not('ended_at', 'is', null)
    .gte('started_at', since)
  const contactIds = [...new Set((contactRows || []).map((r) => r.contact_id))]

  // 2) Already-earned: skip these contacts.
  const { data: alreadyEarned } = await db
    .from('contact_achievements')
    .select('contact_id')
    .eq('rule_id', id)
  const earnedSet = new Set((alreadyEarned || []).map((r) => r.contact_id))
  const candidates = contactIds.filter((cid) => !earnedSet.has(cid))

  let granted = 0
  let scanned = 0
  const BATCH = 200

  for (let offset = 0; offset < candidates.length; offset += BATCH) {
    const batch = candidates.slice(offset, offset + BATCH)
    const { data: sessions } = await db
      .from('heart_rate_sessions')
      .select('id, contact_id, location_id, booking_id, started_at, ended_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds, max_hr_used, bookings:bookings(event_type_id)')
      .in('contact_id', batch)
      .not('ended_at', 'is', null)
      .gte('started_at', since)
      .order('started_at', { ascending: true })

    // Bucket per contact.
    const perContact = new Map()
    for (const s of sessions || []) {
      s.event_type_id = s.bookings?.event_type_id || null
      const arr = perContact.get(s.contact_id) || []
      arr.push(s)
      perContact.set(s.contact_id, arr)
    }

    const inserts = []
    for (const cid of batch) {
      const list = perContact.get(cid) || []
      if (list.length === 0) continue
      scanned++
      // Treat the LATEST session as "this" — if the rule fires at
      // any point in their timeline, the latest session is when
      // they would have most recently met the criteria.
      const latest = list[list.length - 1]
      const history = list.slice(0, -1)
      const ctx = buildAchievementContext(latest, history)
      const fired = runDetectors([rule], ctx)
      if (fired.length > 0) {
        inserts.push({
          contact_id: cid,
          rule_id: rule.id,
          rule_slug: rule.slug,
          source_session_id: latest.id,
          metadata: { ...fired[0].metadata, backfilled: true },
        })
      }
    }

    if (inserts.length > 0) {
      const { error: insErr, count } = await db
        .from('contact_achievements')
        .upsert(inserts, { onConflict: 'contact_id,rule_id', ignoreDuplicates: true, count: 'exact' })
      if (insErr) {
        logWarn('admin-achievements', 'backfill insert failed', { id, err: insErr })
      } else {
        granted += count || inserts.length
      }
    }
  }

  logInfo('admin-achievements', 'backfill complete', {
    ruleId: id, slug: rule.slug, candidates: candidates.length, scanned, granted,
  })

  return NextResponse.json({
    ok: true,
    rule_slug: rule.slug,
    candidates_total: contactIds.length,
    already_earned: earnedSet.size,
    scanned,
    granted,
  })
}
