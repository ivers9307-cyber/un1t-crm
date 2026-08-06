// ZOOMOPS.1 — the operator's trigger for the Zoom contact sync.
//
// Calls the same runZoomContactSync() the cron does. The cron route is
// unchanged and keeps its CRON_SECRET guard — this is an addition, so an
// authenticated browser session never becomes a way around cron auth.
//
// Permissions: a preview writes nothing to Zoom and is open to managers. A real
// run, and especially the guard override, can add or remove thousands of
// directory entries, so both are owner/master only.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { runZoomContactSync } from '@/lib/zoom/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Matches the cron. An unlimited manual run enqueues one job per pending write
// and relies on the same bounded-concurrency publish loop.
export const maxDuration = 300

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  const dry = body?.dry === true
  const force = body?.force === true
  const rawLimit = body?.limit
  if (rawLimit != null && (!Number.isFinite(rawLimit) || rawLimit <= 0)) {
    return NextResponse.json({ success: false, error: 'limit must be a positive number' }, { status: 400 })
  }
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null

  // The sync belongs to one organisation; nobody outside it may drive it, even
  // as an owner of their own org.
  const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null
  if (!user.isMaster && (!syncOrgId || user.activeOrganization?.id !== syncOrgId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Computed once and reused for both the write gate below and the response
  // redaction further down, so the two can never diverge.
  const canManage = hasPermission(user, 'integrations_zoom_manage')

  // A preview is safe. Anything that writes, or that overrides the deletion
  // guard, is gated on the permission key added in Task 6 — NOT on a hand-rolled
  // role check, or the key would be dead and the two would drift the first time
  // someone edited the role defaults.
  if ((!dry || force) && !canManage) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const out = await runZoomContactSync({
    db, dry, limit, force, trigger: 'manual', triggeredBy: user.id,
  })

  // guard.sample is real member phone numbers. The force-confirmation UI needs
  // them, but it reads them from the stored run row — nothing in the response
  // requires them, and a preview is open to callers who cannot act on them.
  // Redact rather than widen who may preview: the counts are what a previewer
  // actually needs.
  const data = canManage || !out?.guard?.sample
    ? out
    : { ...out, guard: { ...out.guard, sample: undefined, sampleRedacted: out.guard.sample.length } }

  return NextResponse.json({ success: out.ok !== false, data })
}
