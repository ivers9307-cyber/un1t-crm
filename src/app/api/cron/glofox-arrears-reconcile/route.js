// /api/cron/glofox-arrears-reconcile — GLOFOX-RECONCILE.1
//
// Daily sweep. For every Glofox-connected location it reconciles the open
// PAST_DUE glofox_invoices against the live Glofox TransactionsList report and
// clears the rows Glofox no longer shows as owed (settled / forgiven / aged-out
// absences). Keeps the churn-radar Overdue + Unpaid-charges list honest as fees
// are paid or waived in Glofox — the INVOICE_UPDATED webhook only ever CREATES
// fee rows as PAST_DUE; nothing flips them back when they're resolved.
//
// Auth: the same CRON_SECRET bearer pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { runArrearsReconcile } from '@/lib/glofox-reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// One Glofox report fetch + a chunked update per Glofox location. Single-tenant
// in practice (only Stillorgan is connected); 300s leaves ample headroom.
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  // AWAITING-AUTH.2 — manual controls (the scheduled cron passes neither):
  //   ?dry=1       — dry-run: report what WOULD change (clears + re-status), no writes.
  //   ?restatus=1  — also APPLY the PAST_DUE→PENDING awaiting-authorization
  //                  re-status (default off, so the scheduled run only ever
  //                  clears settled/forgiven/aged rows as before). Review a
  //                  dry-run first, then run once with ?restatus=1 to apply.
  const params = new URL(request.url).searchParams
  const isTruthy = (v) => v === '1' || v === 'true'
  const dryRun = isTruthy(params.get('dry'))
  const allowRestatus = isTruthy(params.get('restatus'))
  const commit = !dryRun

  const db = createServerClient()

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][glofox-arrears-reconcile] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const perLocation = []
  for (const loc of locations || []) {
    try {
      const creds = await glofoxCredentialsForLocation(db, loc.id)
      if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
        perLocation.push({ location_id: loc.id, location_name: loc.name, skipped: 'no_glofox_credentials' })
        continue
      }
      const res = await runArrearsReconcile(db, creds, loc.id, { commit, allowRestatus })
      perLocation.push({
        location_id: loc.id,
        location_name: loc.name,
        ok: true,
        dry_run: res.dryRun,
        scanned: res.scanned,
        cleared: res.cleared,
        restated: res.restated ?? 0,
        restatus_applied: res.restatusApplied ?? false,
        kept: res.kept,
        by_reason: res.byReason,
        written: res.written ?? 0,
        // On a dry-run, surface the sample of proposed changes for review.
        ...(res.dryRun ? { sample: res.sample } : {}),
      })
    } catch (e) {
      // One bad location can't stall the rest of the sweep.
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: e.message })
    }
  }

  // A dry-run isn't a real reconcile — don't reset the staleness clock.
  if (!dryRun) await stampHeartbeat('glofox-arrears-reconcile').catch(() => {})

  return NextResponse.json({ success: true, dry_run: dryRun, restatus_applied: allowRestatus && !dryRun, locations: perLocation.length, perLocation })
}
