// /api/glofox/reconcile-fees — GLOFOX-RECONCILE.1 (master, dry-run by default)
//
// Reconcile a location's open PAST_DUE glofox_invoices against the live Glofox
// TransactionsList report and clear the rows Glofox no longer shows as owed
// (settled / forgiven / aged-out absences). DRY-RUN by default — returns
// exactly what it WOULD clear and writes nothing; pass ?commit=true to apply.
// The daily cron (/api/cron/glofox-arrears-reconcile) does this automatically;
// this is the on-demand preview / one-off surface.
//
// Query params:
//   location_id  optional  defaults to user.activeLocation
//   commit       optional  'true' to write; anything else = dry run
//   restatus     optional  'true' to ALSO apply the PAST_DUE→PENDING
//                          awaiting-authorization re-status (AWAITING-AUTH.2 /
//                          ARREARS-TYPE.2). Proposed on every run (see
//                          `restated` / `byReason.awaiting_authorization` /
//                          `sample`); written only with commit=true&restatus=true.
//                          The daily cron never applies it on its own.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { runArrearsReconcile } from '@/lib/glofox-reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json(
      { ok: false, error: 'Provide ?location_id=<uuid> or set an active location' },
      { status: 400 },
    )
  }
  const commit = url.searchParams.get('commit') === 'true'
  const allowRestatus = url.searchParams.get('restatus') === 'true'

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json(
      { ok: false, error: 'Glofox credentials not configured for this location.' },
      { status: 400 },
    )
  }

  try {
    const res = await runArrearsReconcile(db, creds, locationId, { commit, allowRestatus })
    return NextResponse.json(res)
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 502 })
  }
}
