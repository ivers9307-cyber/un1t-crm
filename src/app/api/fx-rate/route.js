// /api/fx-rate — current cached GBP→EUR rate. Auth-only (any
// logged-in user can read it). Used by client components that need
// the rate without prop-drilling from a server parent.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getCachedGbpToEur } from '@/lib/fx'

export const runtime = 'nodejs'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const fx = await getCachedGbpToEur()
  return NextResponse.json({ success: true, data: fx })
}
