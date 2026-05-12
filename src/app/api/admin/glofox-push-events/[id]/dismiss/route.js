// POST /api/admin/glofox-push-events/[id]/dismiss  (GLOFOX3.6)
//
// Mark a push event reviewed without retrying. Operator decision —
// e.g. a 'needs_review' multiple-Glofox-matches case where the
// operator manually reassigned the contact to a different Glofox
// account via the Glofox admin UI and no longer needs the alert.
//
// Master only. Just stamps reviewed_at + reviewed_by; nothing else.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const { id } = await params
  if (!id) return NextResponse.json({ success: false, error: 'missing event id' }, { status: 400 })

  const db = createServerClient()
  const { error } = await db
    .from('glofox_push_events')
    .update({ reviewed_at: new Date().toISOString(), reviewed_by: user.id })
    .eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
