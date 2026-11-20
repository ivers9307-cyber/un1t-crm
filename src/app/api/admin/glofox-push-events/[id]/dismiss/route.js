// POST /api/admin/glofox-push-events/[id]/dismiss  (GLOFOX3.6)
//
// Mark a push event reviewed without retrying. Operator decision —
// e.g. a 'needs_review' multiple-Glofox-matches case where the
// operator manually reassigned the contact to a different Glofox
// account via the Glofox admin UI and no longer needs the alert.
//
// Master only. Just stamps reviewed_at + reviewed_by; nothing else.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: null, location: false, allow: (user) => user.role === 'master', forbiddenMessage: 'Master only' },
  async ({ user, db, params }) => {
    const id = params?.id
    if (!id) return NextResponse.json({ success: false, error: 'missing event id' }, { status: 400 })

    const { error } = await db
      .from('glofox_push_events')
      .update({ reviewed_at: new Date().toISOString(), reviewed_by: user.id })
      .eq('id', id)
    if (error) {
      logError('glofox-push-events', 'dismiss failed', { err: error, eventId: id })
      return NextResponse.json({ success: false, error: 'Could not dismiss the event. Try again.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
)
