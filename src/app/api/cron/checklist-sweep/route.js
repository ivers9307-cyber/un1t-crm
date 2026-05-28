// CHECKLIST.3 — Vercel cron, every 15 minutes.
//
// Sweeps checklist_instances where status='pending' AND
// deadline_at < now() and:
//   1. Flips status → 'incomplete' (concurrency-safe: only flips
//      from 'pending', so a coach completing the last item between
//      our SELECT and UPDATE wins).
//   2. Sends a personal push to the coach (notify_checklist_overdue).
//   3. Sends a compliance push to head_coach + owner + master at
//      the location (notify_checklist_compliance).
//   4. Logs a 'checklist.incomplete' audit event.
//
// Per-row error isolation — a push failure on one instance never
// stops the loop. Push delivery itself is best-effort; sendPush
// returns counts and never throws.
//
// Auth: CRON_SECRET header, same pattern as the other crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { logAuditEvent } from '@/lib/audit'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'
import {
  COMPLIANCE_ROLES,
  listMissedItems,
  buildOverdueBody,
  isEligibleForSweep,
  markIncomplete,
} from '@/lib/checklist-sweep'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BATCH_LIMIT = 200

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const nowIso = new Date().toISOString()
  const stats = {
    found: 0,
    swept: 0,
    skipped: 0,
    push_overdue: 0,
    push_compliance: 0,
    errors: 0,
  }

  // Pull pending instances whose deadline has passed. The partial
  // index (mig 215) makes this cheap.
  const { data: expired, error } = await db
    .from('checklist_instances')
    .select(`
      id, profile_id, location_id, template_id, date,
      status, deadline_at, items, items_checked,
      locations:location_id ( id, name ),
      profiles:profile_id ( id, full_name, role )
    `)
    .eq('status', 'pending')
    .not('deadline_at', 'is', null)
    .lte('deadline_at', nowIso)
    .order('deadline_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  stats.found = expired?.length || 0

  for (const row of expired || []) {
    // Defensive double-check — between SELECT and now the row
    // could have been completed by an in-flight tick. This is
    // also enforced server-side by markIncomplete's status='pending'
    // filter; this short-circuits before we spend a write at all.
    const eligibility = isEligibleForSweep(row, new Date())
    if (!eligibility.eligible) {
      stats.skipped++
      continue
    }

    // 1. Flip status. If the concurrent UPDATE lost (another
    //    process or the coach finishing the last item won), we
    //    bail — no notifications.
    const updated = await markIncomplete(db, row.id)
    if (!updated) {
      stats.skipped++
      continue
    }
    stats.swept++

    const missed = listMissedItems(row)
    const body = buildOverdueBody(missed)
    const total = (row.items || []).length
    const checked = Object.keys(row.items_checked || {}).length

    // 2. Personal push — coach themselves.
    try {
      const r = await sendPush(row.profile_id, {
        title: `Checklist not completed`,
        body: body
          ? `${checked} / ${total} done. Missed: ${body}.`
          : `${checked} / ${total} done at shift end.`,
        category: 'checklist_overdue',
        data: {
          type: 'checklist_overdue',
          instance_id: row.id,
        },
      })
      stats.push_overdue += r.sent || 0
    } catch (e) {
      logWarn('cron-checklist-sweep', 'overdue push failed', { id: row.id, err: e?.message })
      stats.errors++
    }

    // 3. Compliance push — head coach + owner + master at the
    //    location. push.js filters by notify_checklist_compliance
    //    per user, so an operator who's opted out won't get hit.
    try {
      const coachName = row.profiles?.full_name || 'A coach'
      const locName = row.locations?.name || 'the studio'
      const r = await sendPushToRolesAtLocation(
        row.location_id,
        COMPLIANCE_ROLES,
        {
          title: `Checklist not completed`,
          body: body
            ? `${coachName} at ${locName} missed: ${body}.`
            : `${coachName} at ${locName} ended shift with ${total - checked} of ${total} items unticked.`,
          category: 'checklist_compliance',
          data: {
            type: 'checklist_compliance',
            instance_id: row.id,
            profile_id: row.profile_id,
            location_id: row.location_id,
          },
        }
      )
      stats.push_compliance += r.sent || 0
    } catch (e) {
      logWarn('cron-checklist-sweep', 'compliance push failed', { id: row.id, err: e?.message })
      stats.errors++
    }

    // 4. Audit-log the transition. Detail includes the missed
    //    count + the total so the audit-log UI can render a
    //    one-line summary without re-loading the instance.
    await logAuditEvent({
      category: 'business',
      action: 'checklist.incomplete',
      target: {
        id: row.id,
        label: 'Checklist',
        resource: `checklist_instance/${row.id}`,
      },
      locationId: row.location_id,
      details: {
        profile_id: row.profile_id,
        template_id: row.template_id,
        items_total: total,
        items_checked: checked,
        items_missed: total - checked,
      },
    })
  }

  await stampHeartbeat('checklist-sweep').catch((err) =>
    logWarn('cron-checklist-sweep', 'heartbeat failed', { err }))

  return NextResponse.json({ success: true, stats })
}
