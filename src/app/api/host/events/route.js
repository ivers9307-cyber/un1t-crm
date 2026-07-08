// GET /api/host/events — the host's OWN events. The `.eq('host_id', host.id)`
// filter is the entire tenancy boundary of the portal: a host can only ever see
// events assigned to them. (HOST-PORTAL.1)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentHost } from '@/lib/host-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('race_events')
    .select('id, name, slug, race_date, kind, active')
    .eq('host_id', session.host.id)
    .order('race_date', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}
