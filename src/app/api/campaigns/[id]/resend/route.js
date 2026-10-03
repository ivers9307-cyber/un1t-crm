// CAMPAIGN-RESEND (mig 506) — cancel a pending resend-to-non-openers.
//
// While the resend is pending it exists only as resend_enabled on the
// parent — the child campaign isn't created until the spawner fires —
// so cancelling is just clearing the flag. Once a child row exists the
// resend is a live campaign and this returns 409; it's then cancelled
// (if still possible) through the normal campaign cancel path.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'

// GATES-2 — /send's rule (email at the campaign's studio); before, any member
// of the studio could cancel a pending resend.
const emailForbidden = () => NextResponse.json(
  { success: false, error: 'No email permission at this location' }, { status: 403 })

export const dynamic = 'force-dynamic'

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) return emailForbidden()

  const db = createServerClient()
  const { data: campaign, error } = await db
    .from('campaigns')
    .select('id, location_id, resend_enabled')
    .eq('id', params.id)
    .single()
  // GATES-3 (d) — a failed read is never "not found" (PGRST116 = no row).
  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ success: false, error: 'Could not read the campaign' }, { status: 500 })
  }
  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, campaign.location_id, 'email')) return emailForbidden()

  const { data: child, error: childErr } = await db
    .from('campaigns')
    .select('id')
    .eq('parent_campaign_id', params.id)
    .maybeSingle()
  // GATES-3 (d) — an unreadable child is not "no child": clearing the flag
  // then would report a cancel while the resend may already be running.
  if (childErr) {
    return NextResponse.json({ success: false, error: 'Could not check whether the resend has started' }, { status: 500 })
  }
  if (child) {
    return NextResponse.json({
      success: false,
      error: 'The resend has already started — cancel it from its own campaign page.',
      child_id: child.id,
    }, { status: 409 })
  }

  // Idempotent — clearing an already-clear flag is a no-op 200, so a
  // double-click or a raced spawner never surfaces a scary error.
  // GATES-3 (d) — the write's error is read: a failed clear left the resend
  // armed while this answered success.
  const { error: updErr } = await db.from('campaigns').update({ resend_enabled: false }).eq('id', params.id)
  if (updErr) {
    return NextResponse.json({ success: false, error: 'Could not cancel the resend. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
