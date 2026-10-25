// POST /api/locations/[id]/un1t-online/sync — "Sync now".
//
// UN1TSYNC.7 — runs the same full pull the */15 cron runs, for ONE studio, on
// demand. Owner/master AT THE TARGET only (the connect route's gate order:
// 401 -> membership 404 -> 403). A run that did not go through (auth, studio
// mismatch, api, truncated, db) is still a 200: the request worked and the
// answer is in `data.ok` / `data.reason`, the same way the cron reports it.
// runUn1tSync never throws on a bad token or a bad pull; a throw here is a
// bug, answered 500 without its message.
//
// A manual run never overlaps the cron's (UN1THARD.1, mig 735): if a run is
// already in flight for this studio, the answer is data.ok false with reason
// 'in_progress', and nothing was read or written.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runUn1tSync } from '@/lib/un1t-online-sync'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return access
  const role = guardMasterOrOwner(user, locationId)
  if (role) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can sync un1t.online.' }, { status: 403 })
  }

  const db = createServerClient()
  try {
    const result = await runUn1tSync(db, locationId)
    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    logError('un1t-online-sync-now', 'sync threw', { locationId, errName: err?.name })
    return NextResponse.json({ success: false, error: 'The sync failed unexpectedly.' }, { status: 500 })
  }
}
