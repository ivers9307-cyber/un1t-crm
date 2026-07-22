// GET /api/integrations/health — consolidated integration status rows
// (FEAT-INTEG-HEALTH.1). Backs the /settings/integration-health pane and is
// available for a future client refresh / external monitor. Session-guarded,
// settings permission; the aggregator scopes per-location tables by the active
// location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getIntegrationHealth, worstStatus } from '@/lib/integration-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'settings')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const db = createServerClient()
  const rows = await getIntegrationHealth(db, locationId)
  return NextResponse.json({ success: true, overall: worstStatus(rows), rows })
}
