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

export const dynamic = 'force-dynamic'

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign, error } = await db
    .from('campaigns')
    .select('id, location_id, resend_enabled')
    .eq('id', params.id)
    .single()
  if (error || !campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return guard

  const { data: child } = await db
    .from('campaigns')
    .select('id')
    .eq('parent_campaign_id', params.id)
    .maybeSingle()
  if (child) {
    return NextResponse.json({
      success: false,
      error: 'The resend has already started — cancel it from its own campaign page.',
      child_id: child.id,
    }, { status: 409 })
  }

  // Idempotent — clearing an already-clear flag is a no-op 200, so a
  // double-click or a raced spawner never surfaces a scary error.
  await db.from('campaigns').update({ resend_enabled: false }).eq('id', params.id)
  return NextResponse.json({ success: true })
}
