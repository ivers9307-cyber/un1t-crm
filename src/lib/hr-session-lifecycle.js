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
 * Should an existing OPEN session be CLOSED to make way for a fresh session on
 * the member's newly-resolved class? True only when the open session is linked
 * to a DIFFERENT class than the one now resolved AND that older class has ended
 * (+ grace). This is the back-to-back-classes fix (HR wave-2 item 1): a 09:00
 * session that stays open (closing waits on silence) must not absorb the 10:00
 * class's samples.
 *
 * Preserves rejoin: same class (or no newly-resolved class) → don't close; the
 * older class still live (within end+grace) → don't close (still rejoinable).
 *
 * @param {{
 *   openEventId: string|null,           // existing open session's glofox_event_id
 *   newEventId: string|null,            // the member's currently-resolved occurrence id
 *   openClassEndsAt: string|null,       // ends_at of the open session's class (null if unknown)
 *   nowMs: number,
 *   classEndGraceMs?: number,
 * }} args
 * @returns {boolean}
 */
export function shouldCloseSupersededSession({
  openEventId, newEventId, openClassEndsAt, nowMs, classEndGraceMs = CLASS_END_GRACE_MS,
}) {
  // No new class resolved, or the open session isn't class-linked, or it's the
  // SAME class → keep the existing open session (rejoin).
  if (!newEventId || !openEventId || openEventId === newEventId) return false
  // Different class. Only supersede once the OLD class has ended past grace —
  // while it's still live the member could legitimately still be in it.
  const endMs = openClassEndsAt ? new Date(openClassEndsAt).getTime() : null
  if (endMs == null || !Number.isFinite(endMs)) return true // unknown end → treat as ended
  return nowMs > endMs + classEndGraceMs
}

/**
 * Should the stale-close cron finalise this open session now?
 * - 4h backstop → always close.
 * - never sampled (item 4a: last_sample_at IS NULL) + open past staleMs → treat
 *   as silent (a strap that never delivered — bridge crashed right after
 *   create); same class-defer rule applies.
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
  // "Silent" = we've heard nothing recently. Either the last sample is older
  // than staleMs, OR the strap NEVER delivered a sample (last_sample_at IS NULL)
  // and the session has been open longer than staleMs (item 4a).
  const silent = lastMs != null
    ? nowMs - lastMs > staleMs
    : startedMs != null && Number.isFinite(startedMs) && nowMs - startedMs > staleMs
  if (!silent) return false

  if (session?.glofox_event_id) {
    const endMs = occ?.ends_at ? new Date(occ.ends_at).getTime() : null
    if (endMs != null && nowMs <= endMs + classEndGraceMs) return false // defer — rejoinable
    return true
  }
  return true // non-class silent → close (unchanged)
}
