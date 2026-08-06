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
import { getCurrentUser, assertOrganizationAccess } from '@/lib/auth'
import { hasPermissionInOrganization } from '@/lib/permissions'
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
  //
  // Membership is a fact about the caller's ASSIGNMENTS, so it is read through
  // assertOrganizationAccess (locations' orgs ∪ SAAS-4 org-admin grants) and
  // deliberately NOT through `user.activeOrganization`, which merely mirrors
  // whichever LOCATION is selected in the session right now. Reading that meant
  // someone who genuinely runs a studio inside the synced org was refused for
  // having a CCF Autos location active — the same person, same rights, two
  // different answers depending on a dropdown, and nothing in the 403 hinting
  // that switching location was the fix.
  const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null
  if (!user.isMaster) {
    // Fail closed on an unset env var BEFORE delegating: assertOrganizationAccess
    // reads a null org id as "the caller named no organisation" and PASSES it,
    // which would hand this route to every authenticated user. Unset is the live
    // state — the sync ships dark until the ZOOM_* secrets land.
    if (!syncOrgId) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    const orgGuard = assertOrganizationAccess(user, syncOrgId)
    if (orgGuard) return orgGuard
  }

  // Computed once and reused for both the write gate below and the response
  // redaction further down, so the two can never diverge.
  //
  // Scored INSIDE the synced org rather than with hasPermission(), which
  // resolves at the caller's ACTIVE location. While the gate above demanded the
  // active org BE the synced org, those two questions could not disagree; now
  // that membership is read properly they can. An owner at a CCF Autos location
  // who is only staff at a UN1T one would otherwise clear both halves and drive
  // UN1T's directory writes on authority they never held there. Master keeps the
  // unconditional bypass, including when syncOrgId is unset.
  const canManage = user.isMaster
    || hasPermissionInOrganization(user, syncOrgId, 'integrations_zoom_manage')

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

  // The guard carries real member numbers in two different shapes, and the dry
  // branch returns it whether or not it tripped:
  //   tripped  → `sample`, the first 10 suppressed numbers
  //   UNtripped → `deletes`, EVERY delete candidate, uncapped
  // The second is the ordinary preview and the bigger leak. A preview is
  // deliberately open to callers without integrations_zoom_manage, and the
  // force-confirmation UI reads the numbers from the stored zoom_sync_runs row
  // rather than from this response — so an unprivileged caller keeps the counts
  // and loses the numbers. Redact rather than narrow who may preview.
  const data = canManage || !out?.guard ? out : { ...out, guard: redactGuard(out.guard) }

  return NextResponse.json({ success: out.ok !== false, data })
}

/**
 * Allowlist, not denylist: a field added to the guard later must fail closed
 * (absent from an unprivileged response) rather than leak by default.
 */
function redactGuard(guard) {
  return {
    tripped: guard.tripped,
    threshold: guard.threshold,
    attempted: guard.attempted,
    ...(Array.isArray(guard.deletes) ? { deletesRedacted: guard.deletes.length } : {}),
    ...(Array.isArray(guard.sample) ? { sampleRedacted: guard.sample.length } : {}),
  }
}
