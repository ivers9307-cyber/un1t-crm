// src/lib/zoom/sync-runs.js
//
// ZOOMOPS.1 — run history for the Zoom contact sync.
//
// Pure DB access plus one pure mapper. No sync logic lives here; reconcile.js
// calls startRun() before it works and finishRun() after, so every trigger is
// recorded exactly once regardless of who invoked it.

import { logWarn } from '@/lib/log'

export const PRUNE_DAYS = 90
const HISTORY_LIMIT = 30

/** Pure: a runZoomContactSync() result → the columns that close out its row. */
export function outcomePatch(out) {
  const o = out || {}
  return {
    finished_at: new Date().toISOString(),
    creates: o.counts?.creates ?? null,
    updates: o.counts?.updates ?? null,
    deletes: o.counts?.deletes ?? null,
    enqueued: o.enqueued ?? null,
    guard_tripped: Boolean(o.guardTripped),
    guard_threshold: o.guard?.threshold ?? null,
    guard_attempted: o.guard?.attempted ?? null,
    guard_sample: o.guard?.sample ?? null,
    owned_in_zoom: o.ownedInZoom ?? null,
    stats: o.stats ?? null,
    error: o.error ?? null,
  }
}

/**
 * Best-effort throughout: history is observability, and failing to record a run
 * must never fail the run itself. Returns the row id, or null if recording
 * failed — callers pass that straight back to finishRun(), which no-ops on null.
 */
export async function startRun(db, { organizationId, trigger, triggeredBy = null, dry, forced, limit }) {
  try {
    const { data, error } = await db
      .from('zoom_sync_runs')
      .insert({
        organization_id: organizationId ?? null,
        trigger,
        triggered_by: triggeredBy,
        dry: Boolean(dry),
        forced: Boolean(forced),
        limit_applied: Number.isFinite(limit) ? limit : null,
      })
      .select('id')
      .single()
    if (error) { logWarn('zoom-sync-runs', 'startRun failed', { err: error.message }); return null }
    return data?.id ?? null
  } catch (err) {
    logWarn('zoom-sync-runs', 'startRun threw', { err: err?.message })
    return null
  }
}

export async function finishRun(db, runId, out) {
  if (!runId) return
  try {
    await db.from('zoom_sync_runs').update(outcomePatch(out)).eq('id', runId)
  } catch (err) {
    logWarn('zoom-sync-runs', 'finishRun threw', { err: err?.message })
  }
}

export async function listRuns(db, organizationId, limit = HISTORY_LIMIT) {
  try {
    const { data, error } = await db
      .from('zoom_sync_runs')
      .select('*')
      .eq('organization_id', organizationId)
      .order('started_at', { ascending: false })
      .limit(limit)
    if (error) return []
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

/**
 * Runs at the end of each sync rather than on its own cron: a prune that only
 * fires when the sync fires needs no separate heartbeat, and an unconfigured
 * tenant generates no rows to prune.
 */
export async function pruneRuns(db) {
  const cutoff = new Date(Date.now() - PRUNE_DAYS * 86400_000).toISOString()
  try {
    await db.from('zoom_sync_runs').delete().lt('started_at', cutoff)
  } catch (err) {
    logWarn('zoom-sync-runs', 'prune threw', { err: err?.message })
  }
}
