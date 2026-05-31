// POST /api/races/[slug]/teams/[teamId]/reissue-payment
//
// Operator action (RACE2.5): regenerate the Revolut checkout link for a
// team still awaiting payment, so staff can re-send the customer a link
// to settle the balance. Owner/manager only.
//
// Returns { success, checkout_url } — the UI copies the link to the
// clipboard so staff can paste it into WhatsApp / email.
//
// Auth: manage_races permission, same as the manage page + teams route.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { reissueRacePayment } from '@/lib/race-payments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const { slug, teamId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'manage_races')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()

  // Verify the team belongs to the race named in the path before we
  // touch the payment provider.
  const { data: team } = await db
    .from('race_teams')
    .select('id, status, race_events(slug)')
    .eq('id', teamId)
    .maybeSingle()
  if (!team || team.race_events?.slug !== slug) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }
  if (team.status !== 'pending_payment') {
    return NextResponse.json({
      error: 'This team is not awaiting payment.',
      code: 'NOT_PENDING',
    }, { status: 409 })
  }

  try {
    const { checkoutUrl } = await reissueRacePayment({ db, teamId })
    return NextResponse.json({ success: true, checkout_url: checkoutUrl })
  } catch (e) {
    return NextResponse.json({
      error: e?.message || 'Could not reissue the payment link.',
      code: 'REISSUE_FAILED',
    }, { status: 502 })
  }
}
