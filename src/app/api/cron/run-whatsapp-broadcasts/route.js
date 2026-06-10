// src/app/api/cron/run-whatsapp-broadcasts/route.js
// Vercel cron — every 15 min. Picks up in-flight drip broadcasts and sends one
// chunk each, but only while the broadcast is inside its configured send window.
// Mirrors run-sms-broadcasts. Auth via Authorization: Bearer ${CRON_SECRET}.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendDripChunk } from '@/lib/whatsapp'
import { isWithinSendWindow } from '@/lib/whatsapp-drip'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Pro ceiling

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()

  // Active drips only: delivery_mode='drip', status='sending', not paused.
  const { data: drips, error } = await db.from('whatsapp_broadcasts')
    .select('id, name, location_id, send_window_start, send_window_end, send_window_tz')
    .eq('delivery_mode', 'drip')
    .eq('status', 'sending')
    .is('paused_at', null)
    .order('updated_at', { ascending: true })
    .limit(20)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const stats = { found: drips.length, sent: 0, failed: 0, finished: 0, in_progress: 0, outside_window: 0, errors: [] }

  for (const row of drips) {
    try {
      const inWindow = isWithinSendWindow(now, {
        start: row.send_window_start, end: row.send_window_end, tz: row.send_window_tz,
      })
      if (!inWindow) { stats.outside_window++; continue }

      const r = await sendDripChunk(row.id)
      stats.sent += r.sent || 0
      stats.failed += r.failed || 0
      if (r.status === 'sent') stats.finished++
      else stats.in_progress++
    } catch (e) {
      const msg = e?.message || String(e)
      console.warn(`[cron run-whatsapp-broadcasts] drip ${row.id} (${row.name}) failed: ${msg}`)
      stats.errors.push({ broadcast_id: row.id, error: msg })
    }
  }

  await stampHeartbeat('run-whatsapp-broadcasts')
  return NextResponse.json({ success: true, stats })
}
