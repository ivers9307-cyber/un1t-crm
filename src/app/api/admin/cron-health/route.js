// STALEWATCH.1 — GET /api/admin/cron-health: every background job's heartbeat
// (master only; the jobs are platform-wide). Feeds the Background jobs card on
// /admin/health.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Platform-wide, so no studio; masters only (profiles.role), as before.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => user.profileRole === 'master', forbiddenMessage: 'Forbidden' },
  async ({ db }) => {
    const { data, error } = await db
      .from('cron_health')
      .select('name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale, is_acknowledged, acknowledged_until, acknowledged_note, stale_alerted_at')
      .order('name')
    if (error) {
      logError('cron-health', 'heartbeat read failed', { err: error })
      return NextResponse.json({ success: false, error: 'Could not read the job heartbeats.' }, { status: 503 })
    }
    return NextResponse.json({ success: true, data: data || [] })
  },
)
