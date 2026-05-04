import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/prune-rate-limits
 * Daily Vercel cron — deletes rate_limit_buckets rows whose expires_at has
 * already passed. Without this, the table grows unbounded; even at modest
 * traffic that's a few hundred KB/day forever.
 *
 * Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  const db = createServerClient()
  const now = new Date().toISOString()

  const { error, count } = await db
    .from('rate_limit_buckets')
    .delete({ count: 'exact' })
    .lt('expires_at', now)

  if (error) {
    console.error('[cron] prune-rate-limits failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  await stampHeartbeat('prune-rate-limits')
  return NextResponse.json({ success: true, deleted: count ?? 0 })
}
