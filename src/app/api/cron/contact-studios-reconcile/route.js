// ORGCONTACTS.1 (plan Task 10) — the nightly contact_studios reconcile.
//
// contact_studios (mig 764) is kept live by three DEFINER triggers and the two
// syncs, but its lifecycle rules derive from source rows that change without
// any of those firing (a Glofox membership ending is a contacts column, a
// un1t.online client row vanishing from a pull is a mirror write), so every
// night public.reconcile_contact_studios(NULL) re-derives every (contact,
// studio) pair from the sources: first_seen_at never later, last_seen_at
// never earlier, ended_at set and cleared with status, rows never deleted.
//
// One RPC, one heartbeat ('contact-studios-reconcile', daily, 2h grace; mig
// 764 seeds the row). A failed RPC is a 500 with NO stamp: the health check
// reads is_stale, so a night that did nothing must read as stale.
//
// Schedule: vercel.json, 03:30 PLATFORM_TZ (after the 03:00 Glofox sync).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const CRON_NAME = 'contact-studios-reconcile'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { data, error } = await db.rpc('reconcile_contact_studios', { p_location_id: null })
  if (error) {
    logError(CRON_NAME, 'reconcile_contact_studios failed; no heartbeat', { code: error.code ?? null, message: error.message })
    return NextResponse.json({ success: false, error: error.message || 'reconcile failed' }, { status: 500 })
  }
  const row = Array.isArray(data) ? data[0] : data
  const counts = {
    inserted: Number(row?.inserted ?? 0),
    updated: Number(row?.updated ?? 0),
    ended: Number(row?.ended ?? 0),
    unchanged: Number(row?.unchanged ?? 0),
    skipped_no_primary: Number(row?.skipped_no_primary ?? 0),
  }
  logInfo(CRON_NAME, 'contact_studios reconciled', counts)
  await stampHeartbeat(CRON_NAME, counts)
  return NextResponse.json({ success: true, ...counts })
}
