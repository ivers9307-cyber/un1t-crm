// PERF.2.A / PERF.2.C — in-process TTL cache for the Lead / Churn Radar.
//
// THE PROBLEM (see docs/PERF_2_readout_2026-05-23.md)
// ───────────────────────────────────────────────────
// /api/lead-radar/count and /api/churn-radar/count used to be polled
// every 60s per open operator session by Sidebar.jsx (HOME.3 retired
// both routes along with the sidebar's per-item badges — the radar tab
// pages below are what still exercises this cache). Each poll ran the
// *full* radar load (loadFunnel / loadRadar), which paginates a
// sequential scan of the ~13 MB contacts table — purely to produce one
// integer badge. Separately, each radar tab (funnel / cleanup /
// classpass, radar / quarantine / overdue / winback) re-fetches the
// same contact base. The PERF.2 readout measured this family at
// roughly half of all database exec time.
//
// THE FIX
// ───────
// Memoise each loader result per location for a short TTL. A burst of
// polls + page views inside the window collapses onto ONE computation.
// The count endpoint and the matching page endpoint pass the same
// `view`, so they share a cache entry — once either has run, the other
// is free until the entry expires.
//
// WHY A PLAIN IN-PROCESS MEMO — not unstable_cache / the Next data
// cache: this codebase deliberately removed Next's fetch data-cache
// after the 2026-05-05 deposit-token stale-read incident (see
// src/lib/supabase.js and CLAUDE.md "Lessons learned"). A module-scoped
// Map keeps the staleness explicit, process-local, and bounded to
// TTL_MS — it cannot resurrect that class of cross-deployment
// stale-read bug. On Vercel it is per-instance; a warm instance
// serving one operator's session still absorbs that session's entire
// 60s poll stream.
//
// Staleness budget: TTL_MS (60s) — no staler than the sidebar's own
// 60s poll already is between ticks. Mutating routes (radar actions /
// triage) call invalidateRadar() so an operator's own action is
// reflected on the next read instead of after the TTL.

const TTL_MS = 60_000

/** key -> { expires: number, value: Promise<unknown> } */
const store = new Map()

// Opportunistic cleanup so the Map can't accumulate stale entries for
// locations that stop being polled. Cheap — the store only ever holds
// (locations × radar views) entries.
function sweep(now) {
  for (const [k, entry] of store) {
    if (entry.expires <= now) store.delete(k)
  }
}

/**
 * Run `compute` at most once per TTL window for `key`. Concurrent
 * callers within the window share the in-flight promise, so a burst of
 * polls triggers exactly one DB load. A rejected computation is
 * evicted immediately so the next caller retries — failures are never
 * cached.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} compute
 * @returns {Promise<T>}
 */
// AUDIT-13.G — module-private. It was exported and never imported; the
// module's entry point is radarCache() below, which is the only caller.
function cachedRadarLoad(key, compute) {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expires > now) return hit.value

  const value = Promise.resolve().then(compute)
  store.set(key, { expires: now + TTL_MS, value })
  value.catch(() => {
    const cur = store.get(key)
    if (cur && cur.value === value) store.delete(key)
  })
  sweep(now)
  return value
}

/**
 * Memoise a radar loader for one location + surface.
 *
 * `scope` is 'lead' | 'churn'; `view` names the surface ('funnel',
 * 'cleanup', 'classpass', 'radar', 'quarantine', 'overdue',
 * 'winback'). The count endpoint and the page endpoint for the same
 * surface MUST pass the same `view` so they share the cache entry.
 *
 * @template T
 * @param {'lead'|'churn'} scope
 * @param {string} locationId
 * @param {string} view
 * @param {() => Promise<T>} compute
 * @returns {Promise<T>}
 */
export function radarCache(scope, locationId, view, compute) {
  return cachedRadarLoad(`radar:${scope}:${locationId}:${view}`, compute)
}

/**
 * Drop every cached radar surface for one location + scope. Call after
 * any mutation that changes what the radar shows — logging an action,
 * triaging cleanup / quarantine — so the next read recomputes instead
 * of serving a result the operator's own action has already changed.
 *
 * @param {'lead'|'churn'} scope
 * @param {string} locationId
 */
export function invalidateRadar(scope, locationId) {
  const prefix = `radar:${scope}:${locationId}:`
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k)
  }
}
