import { NextResponse } from 'next/server'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncAllLocations } from '@/lib/google-business/sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/cron/sync-google-reviews
 * Daily Vercel cron — pulls each connected location's Google reviews into
 * google_reviews. Best-effort per location (errors recorded on the connection
 * row, never aborts the run). Secured by CRON_SECRET.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let results = []
  try {
    results = await syncAllLocations()
  } catch (e) {
    console.error('[cron] sync-google-reviews failed:', e?.message || e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }

  await stampHeartbeat('sync-google-reviews')
  return NextResponse.json({ success: true, results })
}
