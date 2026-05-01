// Vercel cron — every 5 minutes.
// Picks up due sequence enrollments and fires the next step.
//
// Auth: Vercel cron jobs hit this URL with a CRON_SECRET bearer
// (the same pattern the other crons use). Local invocation via
// the dev server requires the same bearer.

import { NextResponse } from 'next/server'
import { runSequences } from '@/lib/sequences'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  try {
    const stats = await runSequences()
    return NextResponse.json({ success: true, stats })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || String(e) }, { status: 500 })
  }
}
