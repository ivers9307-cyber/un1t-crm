// Phase 2 of glofox_lead_provisioning: a one-time, resumable backfill
// that pushes existing un-linked leads into Glofox + attaches the trial.
// Eligibility comes from the mig-278 RPCs (excludes already-attempted so
// "remaining" reaches 0). The client calls the route repeatedly; each
// call processes one bounded, throttled batch.

import { logWarn } from '@/lib/log'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Pure: tally findOrCreateGlofoxMember results by status. */
export function summariseBackfill(results) {
  const out = { processed: 0, created: 0, linked: 0, needs_review: 0, failed: 0, skipped: 0 }
  for (const r of results || []) {
    out.processed += 1
    const s = r?.status
    if (s === 'created') out.created += 1
    else if (s === 'linked') out.linked += 1
    else if (s === 'needs_review') out.needs_review += 1
    else if (s === 'skipped') out.skipped += 1
    else out.failed += 1
  }
  return out
}

/**
 * Process ONE batch of eligible contacts. Returns
 * { ...summary, remaining }. Never throws (per-contact errors counted
 * as failed). `_findOrCreateGlofoxMember` + `_delayMs` are test seams.
 */
export async function runGlofoxBackfillBatch({ db, locationId, limit = 20, _findOrCreateGlofoxMember, _delayMs = 150 }) {
  const findOrCreate = _findOrCreateGlofoxMember
    || (await import('@/lib/glofox-push')).findOrCreateGlofoxMember

  const { data: rows, error } = await db.rpc('glofox_backfill_eligible_batch', {
    p_location_id: locationId,
    p_limit: limit,
  })
  if (error) {
    logWarn('automations.glofox-backfill', 'batch fetch failed', { err: error })
    return { ...summariseBackfill([]), remaining: 0, error: error.message }
  }

  const results = []
  for (const contact of rows || []) {
    try {
      const r = await findOrCreate({
        db, locationId, contact,
        source: 'automation', createIfMissing: true, attachTrial: true,
      })
      results.push(r || { status: 'failed' })
    } catch (e) {
      logWarn('automations.glofox-backfill', `contact ${contact?.id} threw`, { err: e })
      results.push({ status: 'failed' })
    }
    if (_delayMs) await sleep(_delayMs)
  }

  const summary = summariseBackfill(results)

  let remaining = 0
  try {
    const { data: cnt } = await db.rpc('glofox_backfill_eligible_count', { p_location_id: locationId })
    remaining = Number(cnt) || 0
  } catch (e) {
    logWarn('automations.glofox-backfill', 'remaining count failed', { err: e })
  }

  return { ...summary, remaining }
}
