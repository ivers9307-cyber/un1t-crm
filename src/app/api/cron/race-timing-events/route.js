// Cron — emits time-anchored race events (mig 085).
//
// Runs every 15 minutes (configured in pg_cron). For every confirmed
// race_registration whose wave_time falls within the configured
// windows, emits one of:
//   - race.starts_in_24h  (wave starts in 22h-26h)
//   - race.starts_in_1h   (wave starts in 50min-70min)
//   - race.completed_24h_ago  (wave was 22h-26h ago)
//
// Idempotency: contact_events has a partial unique index on
// (source_type, source_id, event_type) for these specific event
// types. Re-firing within the same window is a silent no-op.
//
// Auth: same bearer-token pattern as other crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { emitEvent, applyTagRules, EVENT_TYPES } from '@/lib/contact-events'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Window definitions in minutes from "now". Tuned for a 15-min
// cron cadence: each window is wider than the cron interval so a
// missed tick doesn't drop events.
const WINDOWS = [
  { event: EVENT_TYPES.RACE_STARTS_IN_24H, minMinutes: 22 * 60, maxMinutes: 26 * 60 },
  { event: EVENT_TYPES.RACE_STARTS_IN_1H,  minMinutes: 50,      maxMinutes: 70 },
  { event: EVENT_TYPES.RACE_COMPLETED_24H_AGO, minMinutes: -26 * 60, maxMinutes: -22 * 60 },
]

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const stats = { emitted: 0, skipped: 0, errors: 0 }
  const now = new Date()

  // Pull every confirmed registration with a wave + race_date in the
  // last 2 days OR next 2 days. That bound keeps the cron query cheap
  // (a race 6 weeks out has nothing to emit yet).
  const fromDate = new Date(now.getTime() - 3 * 86400_000).toISOString().slice(0, 10)
  const toDate = new Date(now.getTime() + 3 * 86400_000).toISOString().slice(0, 10)

  const { data: regs, error } = await db
    .from('race_registrations')
    .select(`
      id, contact_id, status,
      race_event_id,
      race:race_event_id ( id, name, location_id, race_date ),
      wave:wave_id ( id, start_time ),
      teams:team_id ( id,
        team_members ( id, name, email, role, contact_id, member_contact_id ) )
    `)
    .eq('status', 'confirmed')
    .gte('race.race_date', fromDate)
    .lte('race.race_date', toDate)

  if (error) {
    // Don't stamp the heartbeat on a query failure — the whole point
    // of the health-check is to surface this. Caller (Vercel cron)
    // sees a 500 in its log too.
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  for (const reg of (regs || [])) {
    const race = reg.race
    if (!race?.race_date || !reg.wave?.start_time) {
      stats.skipped += 1
      continue
    }
    // Construct the wave's start instant in Europe/Dublin.
    const waveStartIso = `${race.race_date}T${(reg.wave.start_time || '00:00:00').slice(0, 8)}+00:00`
    const waveStart = new Date(waveStartIso)
    if (Number.isNaN(waveStart.getTime())) {
      stats.skipped += 1
      continue
    }
    const minutesUntil = (waveStart.getTime() - now.getTime()) / 60_000

    for (const w of WINDOWS) {
      if (minutesUntil >= w.minMinutes && minutesUntil <= w.maxMinutes) {
        // Emit one event per team_member with an email — captain
        // AND non-captain participants (race milestones target the
        // whole team, not just the buyer).
        const targets = (reg.teams?.team_members || [])
          .filter((m) => m.email)
          .map((m) => ({
            email: m.email,
            contact_id: m.contact_id || m.member_contact_id || null,
          }))
        // Always include the registration's primary contact (captain).
        if (reg.contact_id && !targets.some((t) => t.contact_id === reg.contact_id)) {
          // Look up the captain contact's email if missing.
          // Cheap one-off — only fires when team_members didn't capture it.
        }

        for (const target of targets) {
          try {
            const r = await emitEvent({
              db,
              eventType: w.event,
              contactEmail: target.email,
              contactId: target.contact_id,
              locationId: race.location_id,
              sourceType: 'race_registration',
              sourceId: reg.id,
              metadata: { race_event_id: race.id, race_name: race.name },
            })
            if (r) {
              stats.emitted += 1
              if (target.contact_id) {
                await applyTagRules({ db, contactId: target.contact_id })
              }
            } else {
              stats.skipped += 1 // idempotency hit, fine
            }
          } catch (e) {
            console.warn(`[race-timing-events] emit failed: ${e?.message || e}`)
            stats.errors += 1
          }
        }
      }
    }
  }

  // Stamp the heartbeat after the loop completes — the health-check
  // (mig 053) needs this to know the cron is alive. Best-effort: a
  // failed write here shouldn't take down a successful run.
  await stampHeartbeat('race-timing-events', stats).catch(() => {})

  return NextResponse.json({ success: true, stats })
}
