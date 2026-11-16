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
import { firstQualifyingSession } from '@/lib/achievements'
import { selectAll } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60   // upgrade timeout for the bigger sweep

const HISTORY_LOOKBACK_DAYS = 365

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

export async function POST(request, props) {
  const params = await props.params;
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
  // AUDIT P1-2 — paginated. This scans EVERY ended session across all
  // members in the 365-day window — far more than 1000 rows. An un-paginated
  // select would silently cap the candidate set, so the backfill would skip
  // everyone past row 1000. Correctness-critical, so let selectAll throw on a
  // DB error (a 500 beats a silently partial backfill). Order by id is
  // deterministic; `recorded_at`-style ties don't apply to a uuid pk.
  const contactRows = await selectAll((from, to) => db
    .from('heart_rate_sessions')
    .select('contact_id, id')
    .not('ended_at', 'is', null)
    .gte('started_at', since)
    .order('id', { ascending: true })
    .range(from, to))
  const contactIds = [...new Set(contactRows.map((r) => r.contact_id))]

  // 2) Already-earned: skip these contacts. Paginated for the same reason —
  // a popular rule's earned set can exceed 1000, and a truncated set would
  // re-grant (upsert ignores dupes, so harmless) but more importantly the
  // candidate filter would be wrong.
  const alreadyEarned = await selectAll((from, to) => db
    .from('contact_achievements')
    .select('contact_id')
    .eq('rule_id', id)
    .order('id', { ascending: true })
    .range(from, to))
  const earnedSet = new Set(alreadyEarned.map((r) => r.contact_id))
  const candidates = contactIds.filter((cid) => !earnedSet.has(cid))

  let granted = 0
  let scanned = 0
  let insertFailures = 0
  const BATCH = 200

  for (let offset = 0; offset < candidates.length; offset += BATCH) {
    const batch = candidates.slice(offset, offset + BATCH)
    // ACHIEVEBACKFILL.1 (October audit A19) — paginated: 200 members' year
    // of sessions is easily past PostgREST's 1,000-row cap, and a truncated
    // read silently dropped later members' history. selectAll throws on a
    // DB error, so the run fails rather than awarding from half a history.
    const sessions = await selectAll((from, to) => db
      .from('heart_rate_sessions')
      .select('id, contact_id, location_id, booking_id, started_at, ended_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds, max_hr_used, bookings:bookings(event_type_id)')
      .in('contact_id', batch)
      .not('ended_at', 'is', null)
      .gte('started_at', since)
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to))

    // Bucket per contact (already oldest first).
    const perContact = new Map()
    for (const s of sessions) {
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
      // Replay the history in order and award at the FIRST session the rule
      // fires on (judging only the latest session missed every rule met
      // earlier, e.g. a first Z5 minute months ago).
      const hit = firstQualifyingSession(rule, list)
      if (hit) {
        inserts.push({
          contact_id: cid,
          rule_id: rule.id,
          rule_slug: rule.slug,
          source_session_id: hit.session.id,
          metadata: { ...hit.fired.metadata, backfilled: true },
        })
      }
    }

    if (inserts.length > 0) {
      // (contact_id, rule_id) is unique, so a re-run never awards twice.
      const { error: insErr, count } = await db
        .from('contact_achievements')
        .upsert(inserts, { onConflict: 'contact_id,rule_id', ignoreDuplicates: true, count: 'exact' })
      if (insErr) {
        insertFailures += inserts.length
        logWarn('admin-achievements', 'backfill insert failed', { id, err: insErr })
      } else {
        granted += count || inserts.length
      }
    }
  }

  logInfo('admin-achievements', 'backfill complete', {
    ruleId: id, slug: rule.slug, candidates: candidates.length, scanned, granted, insertFailures,
  })

  return NextResponse.json({
    ok: true,
    rule_slug: rule.slug,
    candidates_total: contactIds.length,
    already_earned: earnedSet.size,
    scanned,
    granted,
    // A failed write is reported, not hidden: run the backfill again (it is
    // safe to repeat) once the cause is fixed.
    insert_failures: insertFailures,
  })
}
