import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { importClassKnowledge } from '@/lib/agent/knowledge-import'

// KNOWLEDGE-IMPORT.2 — weekly (Monday 06:00 UTC, vercel.json) refresh
// of the agent's class knowledge from the Glofox timetable. New class
// types appear as knowledge entries automatically; existing entries
// (operator-curated or previously imported) are never touched, so the
// cron can only ADD. Locations without working Glofox creds are
// skipped — same posture as every other per-location Glofox cron.
export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: locations } = await db.from('locations')
    .select('id, name')
    .eq('active', true)

  const results = []
  for (const loc of locations || []) {
    try {
      const r = await importClassKnowledge(db, loc.id)
      if (!r.ok && r.reason === 'glofox_not_connected') continue // not a Glofox location
      results.push({
        location: loc.name,
        ok: r.ok,
        ...(r.ok
          ? { imported: r.imported.length, skipped: r.skipped.length, missing_description: r.missing_description }
          : { reason: r.reason }),
      })
    } catch (e) {
      results.push({ location: loc.name, ok: false, reason: e?.message || 'error' })
    }
  }

  await stampHeartbeat('sync-class-knowledge')
  return NextResponse.json({ success: true, results })
}
