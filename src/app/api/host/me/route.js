// GET /api/host/me — the logged-in host's own profile (host-portal). 401 when
// it isn't a host session. (HOST-PORTAL.1)

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ success: true, data: session.host })
}
