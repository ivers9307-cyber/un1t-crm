import { defineCron } from '@/lib/define-cron'
import { logError } from '@/lib/log'
import { importClassKnowledge } from '@/lib/agent/knowledge-import'

// KNOWLEDGE-IMPORT.2 — weekly (Monday 06:00 UTC, vercel.json) refresh
// of the agent's class knowledge from the Glofox timetable. New class
// types appear as knowledge entries automatically; existing entries
// (operator-curated or previously imported) are never touched, so the
// cron can only ADD. Locations without working Glofox creds are
// skipped — same posture as every other per-location Glofox cron.
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'sync-class-knowledge' }, async ({ db }) => {
  const { data: locations, error: locationsError } = await db.from('locations')
    .select('id, name')
    .eq('active', true)
  // A failed read is not "no studios": the run did not happen.
  if (locationsError) {
    logError('cron.sync-class-knowledge', 'locations read failed', { err: locationsError })
    return { ok: false, body: { error: 'Could not read locations' } }
  }

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

  return { body: { results } }
})
