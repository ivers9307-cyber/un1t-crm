// src/app/api/accounting/mailboxes/[id]/route.js
//
// RCOV.P1 — remove a hunt inbox. Per-location (mig 374): the delete is
// scoped to the active location, so one location can't remove another's
// inbox. 404 — not 403 — on a missing id or an id owned by a different
// location, per the repo's IDOR posture.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// accounting_hub at the active studio ('Forbidden' 403), then the active
// studio (400), in that order and with these texts, as before.
export const DELETE = withAuth(
  { permission: null, location: false, allow: (user) => hasPermission(user, 'accounting_hub'), forbiddenMessage: 'Forbidden' },
  async ({ user, db, params }) => {
    const locationId = user.activeLocation?.id
    if (!locationId) {
      return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
    }

    const { data: deleted, error } = await db
      .from('recon_mailboxes')
      .delete()
      .eq('id', params?.id)
      .eq('location_id', locationId)
      .select('id')
      .maybeSingle()
    if (error) {
      logError('accounting-mailboxes', 'delete failed', { err: error, locationId })
      return NextResponse.json({ success: false, error: 'Could not remove the inbox. Try again.' }, { status: 500 })
    }
    if (!deleted) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

    return NextResponse.json({ success: true })
  },
)
