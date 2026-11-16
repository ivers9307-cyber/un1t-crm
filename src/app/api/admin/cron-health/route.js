// STALEWATCH.1 — GET /api/admin/cron-health: every background job's heartbeat
// (master only; the jobs are platform-wide). Feeds the Background jobs card on
// /admin/health.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const { data, error } = await createServerClient()
    .from('cron_health')
    .select('name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale, is_acknowledged, acknowledged_until, acknowledged_note, stale_alerted_at')
    .order('name')
  if (error) return NextResponse.json({ success: false, error: 'Could not read the job heartbeats.' }, { status: 503 })
  return NextResponse.json({ success: true, data: data || [] })
}
