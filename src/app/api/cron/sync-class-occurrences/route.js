// CLASS-CLIMATE.1 — Vercel cron, every 15 min. Refreshes the
// class_occurrences "spine" from the Glofox timetable for every
// Glofox-connected location. Service-role; service bypasses RLS.
//
// defineCron owns the CRON_SECRET check, the error boundary and the stamp.
// A failed locations read answers 500 with a fixed error (the detail is
// logged) and no stamp.
//
// Heartbeat: stamped after the loop on every run that read the locations
// list, including runs where a location's sync failed, so a Glofox that
// ANSWERS with an error does not page. One that HANGS or RATE-LIMITS past
// the 60 s maxDuration kills the tick before its stamp, so it does (mig 644,
// CLASSSYNCHB.1). TRAINERCALLS.1: the stamp carries the
// run's stats as last_outcome; trainer_api_calls is 0 on every tick but the
// daily trainer-lookup tick (04:00 Dublin, src/lib/class-occurrences.js).

import { defineCron } from '@/lib/define-cron'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { locationsWithSource, skippedSummary } from '@/lib/membership/locations-for-source'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'sync-class-occurrences' }, async ({ db }) => {
  // W1.M3b — discovery through the membership seam (active locations whose
  // membership_source is 'glofox' and whose provider is configured), never
  // the settings slice. A failed seam read is a 500 with no heartbeat.
  const { eligible: connected, skipped, error } = await locationsWithSource(db, 'glofox', { module: 'cron-sync-class-occurrences' })
  if (error) {
    logError('cron-sync-class-occurrences', 'glofox locations unreadable', { err: error?.message ?? error })
    return { ok: false, body: { error: 'Could not read the Glofox locations' } }
  }

  // The skip split rides on the stamp's last_outcome: an `unknown` location
  // (its credentials read failed at discovery) is not a quiet unconfigured one.
  const stats = { locations: 0, upserted: 0, errors: 0, trainer_api_calls: 0, reconcile_errors: 0, ...skippedSummary(skipped) }
  for (const loc of connected) {
    stats.locations++
    const creds = await glofoxCredentialsForLocation(db, loc.id)
    if (creds.readError) {
      // REGISTRYREAD.1b: don't call Glofox with null credentials; counted as
      // an error like any failed sync (the stamp below is unchanged) and the
      // next 15-minute tick retries.
      stats.errors++
      logWarn('cron-sync-class-occurrences', 'glofox settings unreadable; skipped this tick', { locationId: loc.id })
      continue
    }
    const out = await syncOccurrencesForLocation(db, { locationId: loc.id, creds })
    // CRONREADERR.1 — this studio's cancellation step could not finish (its
    // read or its UPDATE failed); nothing was cancelled. Counted, never fatal:
    // the next studio still syncs and the stamp below is unchanged.
    if (out.reconcileFailed) stats.reconcile_errors++
    stats.trainer_api_calls += Number(out.trainerApiCalls) || 0
    if (out.ok) {
      stats.upserted += out.upserted
    } else {
      stats.errors++
      logWarn('cron-sync-class-occurrences', 'sync failed', { locationId: loc.id, error: out.error })
    }
  }

  return { outcome: stats, body: { stats } }
})
