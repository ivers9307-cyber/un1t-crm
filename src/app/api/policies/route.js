// GET /api/policies — list of active policies with current version
// metadata and the caller's ack status for each. Used by the staff
// /policies page (server-rendered) and the unread-policies banner.
//
// No permission gate beyond authentication — every employee can read
// their own organisation's policies (W0.5, mig 713: listPoliciesWithStatus
// scopes to the caller's active organisation; no organisation reads nothing).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listPoliciesWithStatus } from '@/lib/policies'

export const runtime = 'nodejs'

// A failed read throws; withAuth logs it and answers a fixed 500.
export const GET = withAuth({ permission: null, location: false }, async ({ user }) => {
  const policies = await listPoliciesWithStatus(user)
  return NextResponse.json({ success: true, data: policies })
})
