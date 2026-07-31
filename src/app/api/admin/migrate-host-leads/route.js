// POST /api/admin/migrate-host-leads
//
// HOST-MASTER.7 — one-off relocation of pre-HOST-MASTER host leads. Contacts
// created by host signups/registrations before HOST-MASTER live at the host's
// hidden `is_host_anchor` location, invisible to the operator's normal
// location-scoped views. This walks every anchor location and MOVES its
// contacts to the owning org's master location (`organizations.master_location_id`,
// mig 464), stamping `automations_exempt = true`.
//
// It never deletes and never merges anything. When an anchor contact's email
// collides with an existing master contact it is left exactly where it is and
// reported in `needs_manual_merge` for a human to resolve via the existing
// POST /api/contacts/merge route — a cross-location merge needs the full
// child-table re-point that route already implements.
//
// Idempotent — a relocated contact is no longer at an anchor location, so
// re-running is always safe and finds nothing to do.
//
// DRY-RUN BY DEFAULT: writes only with ?dry=0. Master/owner only.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { runHostLeadMigration } from '@/lib/host-lead-migration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Anything other than an explicit ?dry=0 stays a dry run.
  const dryRun = new URL(request.url).searchParams.get('dry') !== '0'

  const db = createServerClient()
  try {
    const summary = await runHostLeadMigration(db, { dryRun })
    return NextResponse.json({ success: true, data: summary })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
