// /api/cron/glofox-arrears-reconcile — GLOFOX-RECONCILE.1
//
// Daily sweep. For every Glofox-connected location it reconciles the open
// PAST_DUE glofox_invoices against the live Glofox TransactionsList report and
// clears the rows Glofox no longer shows as owed (settled / forgiven / aged-out
// absences). Keeps the churn-radar Overdue + Unpaid-charges list honest as fees
// are paid or waived in Glofox — the INVOICE_UPDATED webhook only ever CREATES
// fee rows as PAST_DUE; nothing flips them back when they're resolved.
//
// defineCron owns the CRON_SECRET check, the error boundary and the stamp. A
// failed locations read answers 500 with a fixed error (the detail is logged)
// and no stamp; one location failing is a fixed per-location error and the
// run still stamps; a dry-run answers success with `stamp: false`.

import { defineCron } from '@/lib/define-cron'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { runArrearsReconcile } from '@/lib/glofox-reconcile'
import { logError, logWarn } from '@/lib/log'

const MODULE = 'cron-glofox-arrears-reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// One Glofox report fetch + a chunked update per Glofox location. Single-tenant
// in practice (only Stillorgan is connected); 300s leaves ample headroom.
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'glofox-arrears-reconcile' }, async ({ db, request }) => {
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

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    logError(MODULE, 'failed to list locations', { err: locErr.message })
    return { ok: false, body: { error: 'Could not list locations' } }
  }

  const perLocation = []
  for (const loc of locations || []) {
    try {
      const creds = await glofoxCredentialsForLocation(db, loc.id)
      if (creds.readError) {
        // REGISTRYREAD.1b: not a clean skip. The daily reconcile did not run here.
        perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: creds.readError })
        continue
      }
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
      // One bad location can't stall the rest of the sweep. A fixed line in
      // the response; the detail (Glofox status, DB error) is logged.
      logWarn(MODULE, 'reconcile failed for location', { locationId: loc.id, err: e?.message })
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: 'reconcile failed' })
    }
  }

  // A dry-run isn't a real reconcile — don't reset the staleness clock.
  return {
    stamp: !dryRun,
    body: { dry_run: dryRun, restatus_applied: allowRestatus && !dryRun, locations: perLocation.length, perLocation },
  }
})
