// Pure session-lifecycle decisions for the in-studio HR feature. No DB — the
// cron (auto-end-stale-hr-sessions) and bridge ingest (findOrCreateAutoSession)
// load rows then call these. Keeps "one session per member per class, rejoin
// across drop-outs, one email at class end" testable in isolation.

export const STALE_AFTER_MS = 5 * 60 * 1000          // strap silent → close (non-class)
export const MAX_SESSION_LENGTH_MS = 4 * 3600 * 1000 // defensive cap
export const CLASS_END_GRACE_MS = 10 * 60 * 1000     // cooldown buffer after class end

/**
 * What to do with the most-recent session for a (member, class) when a sample
 * arrives and the member is mapped to occurrence `occ`. Open sessions are
 * handled before this is called, so `existing` here is the class-keyed lookup.
 *
 * @returns {'create'|'return'|'reopen'|'skip'}
 */
export function classSessionAction({ existing, occ, nowMs, classEndGraceMs = CLASS_END_GRACE_MS }) {
  if (!existing) return 'create'
  if (!existing.ended_at) return 'return'
  const endMs = occ?.ends_at ? new Date(occ.ends_at).getTime() : null
  if (endMs != null && nowMs <= endMs + classEndGraceMs) return 'reopen'
  return 'skip'
}

/**
 * Should the stale-close cron finalise this open session now?
 * - 4h backstop → always close.
 * - still streaming (not silent) → keep open.
 * - silent + class-linked + class not yet ended+grace → defer (rejoinable).
 * - silent + non-class (or class ended) → close.
 *
 * @param {{ session:{started_at:string,last_sample_at:string|null,glofox_event_id:string|null}, occ:{ends_at:string|null}|null, nowMs:number, staleMs?:number, classEndGraceMs?:number, maxLenMs?:number }} args
 */
export function shouldCloseStaleSession({
  session, occ, nowMs,
  staleMs = STALE_AFTER_MS, classEndGraceMs = CLASS_END_GRACE_MS, maxLenMs = MAX_SESSION_LENGTH_MS,
}) {
  const startedMs = session?.started_at ? new Date(session.started_at).getTime() : null
  if (startedMs != null && Number.isFinite(startedMs) && nowMs - startedMs > maxLenMs) return true

  const lastMs = session?.last_sample_at ? new Date(session.last_sample_at).getTime() : null
  const silent = lastMs != null && nowMs - lastMs > staleMs
  if (!silent) return false

  if (session?.glofox_event_id) {
    const endMs = occ?.ends_at ? new Date(occ.ends_at).getTime() : null
    if (endMs != null && nowMs <= endMs + classEndGraceMs) return false // defer — rejoinable
    return true
  }
  return true // non-class silent → close (unchanged)
}
