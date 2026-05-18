// GET /api/policies — list of active policies with current version
// metadata and the caller's ack status for each. Used by the staff
// /policies page (server-rendered) and the unread-policies banner.
//
// No permission gate beyond authentication — every employee can read
// the policies (mig 178 RLS).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listPoliciesWithStatus } from '@/lib/policies'

export const runtime = 'nodejs'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const policies = await listPoliciesWithStatus(user)
    return NextResponse.json({ success: true, data: policies })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'Failed to load policies' }, { status: 500 })
  }
}
