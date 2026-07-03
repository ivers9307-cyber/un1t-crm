// Pure logic for the Wave-4 studio-TV "theatre" upgrade (mockup C).
//
// No React, no DOM, no timers — just the derivations the LiveTvClient
// needs so they can be unit-tested in isolation:
//   - roomTotalPoints      : sum of effortPoints across live sessions
//   - stableTileOrder      : fixed tile positions (colour, not position,
//                            carries the drama) + a points-rank badge
//   - detectToastEvents    : cross-poll threshold crossings (entered
//                            Zone 5 / earned a Burn) → transient toasts
//   - buildTilePrevState / snapshotSessions : the per-session state we
//                            carry across polls to detect those crossings
//   - selectPodium         : top-3 movers for the outro
//   - zoneWord             : "Zone 4" (never "Z4") from a zone id
//
// The Burn threshold is the shared heart-rate helper — never re-derived.

import { isBurn } from './heart-rate.js'

/** Sum of effortPoints across the live sessions (the header ticker target). */
export function roomTotalPoints(sessions) {
  if (!Array.isArray(sessions)) return 0
  return sessions.reduce((acc, s) => {
    const p = Number(s?.effortPoints)
    return acc + (Number.isFinite(p) && p > 0 ? p : 0)
  }, 0)
}

/**
 * Stable key for a session tile. Prefer the session id (stable for the
 * whole class); fall back to displayName so a session that somehow
 * arrives without an id still keeps a consistent slot rather than
 * teleporting every poll.
 */
export function tileKey(session) {
  if (session?.id != null && session.id !== '') return `id:${session.id}`
  if (session?.displayName) return `name:${session.displayName}`
  return 'unknown'
}

/**
 * Fixed tile positions. The payload arrives sorted by points (which would
 * make tiles teleport every 2s), so we RE-ORDER by a stable key and keep
 * each member in the same slot all class — the zone colour is what
 * changes. A separate points-rank badge (1 = most points) still conveys
 * the leaderboard without moving the tile.
 *
 * Position order: first appearance wins, and new joiners append to the
 * end (never displacing an existing tile). `prevOrder` is the array of
 * stable keys from the previous render; pass [] on first render.
 *
 * @param {Array} sessions           current poll's sessions
 * @param {string[]} [prevOrder]     stable keys in their established order
 * @returns {{ tiles: Array, order: string[] }}
 *   tiles: sessions in fixed-position order, each with a `_rank` (points
 *          rank, 1-based) and `_key` (stable key) attached (shallow copy).
 *   order: the new established key order (feed back in next render).
 */
export function stableTileOrder(sessions, prevOrder = []) {
  const list = Array.isArray(sessions) ? sessions : []
  const byKey = new Map()
  for (const s of list) byKey.set(tileKey(s), s)

  // Points rank: 1 = most points. Ties broken by stable key so it's
  // deterministic (position never depends on rank anyway).
  const ranked = [...list].sort((a, b) => {
    const pa = Number(a?.effortPoints) || 0
    const pb = Number(b?.effortPoints) || 0
    if (pb !== pa) return pb - pa
    return tileKey(a).localeCompare(tileKey(b))
  })
  const rankByKey = new Map()
  ranked.forEach((s, i) => rankByKey.set(tileKey(s), i + 1))

  // Position order: keep previously-established keys in their slots (only
  // those still present), then append new keys in payload order.
  const order = []
  const seen = new Set()
  for (const k of prevOrder) {
    if (byKey.has(k) && !seen.has(k)) { order.push(k); seen.add(k) }
  }
  for (const s of list) {
    const k = tileKey(s)
    if (!seen.has(k)) { order.push(k); seen.add(k) }
  }

  const tiles = order.map((k) => {
    const s = byKey.get(k)
    return { ...s, _key: k, _rank: rankByKey.get(k) || null }
  })
  return { tiles, order }
}

/** Shallow equality of two ordered key arrays (cheap loop-guard). */
export function sameOrder(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** "Zone 4" spelled out from a zone id (1..5); null-safe. Never "Z4". */
export function zoneWord(zoneId) {
  const id = Number(zoneId)
  return id >= 1 && id <= 5 ? `Zone ${id}` : null
}

/**
 * Per-session snapshot we carry across polls to detect threshold
 * crossings. Kept tiny (one small object per live session).
 */
export function snapshotSession(session) {
  return {
    zoneId: Number(session?.currentZone?.id) || 0,
    burn: isBurn(session?.zonesSeconds),
  }
}

/** Snapshot every session into a Map keyed by stable key. */
export function snapshotSessions(sessions) {
  const m = new Map()
  if (Array.isArray(sessions)) {
    for (const s of sessions) m.set(tileKey(s), snapshotSession(s))
  }
  return m
}

// Toast de-dupe: once we've announced a member+event we never repeat it
// for the life of the class. The key is `${stableKey}:${event}`.
export function toastDedupeKey(stableKey, event) {
  return `${stableKey}:${event}`
}

/**
 * Detect notable events that crossed a threshold BETWEEN polls, so the
 * TV can flash a transient toast. Pure: caller owns the prev-state map
 * and the already-announced set.
 *
 * Two events, in priority order per session:
 *   - 'redline' : entered Zone 5 (prev zone < 5, now == 5)
 *   - 'burn'    : earned a Burn (prev !burn, now burn)
 *
 * Only fresh crossings fire (a member sitting in Zone 5 across many polls
 * toasts once). Already-announced member+event pairs are skipped so we
 * never repeat. Returns at most one toast PER SESSION (redline wins over
 * burn if both cross in the same tick — the caller shows one at a time
 * and queues the rest).
 *
 * @param {Array} sessions                current sessions
 * @param {Map<string,{zoneId,burn}>} prev  previous snapshot (empty Map ok)
 * @param {Set<string>} announced          dedupe set of toastDedupeKey()s
 * @returns {Array<{key,event,name,message}>} new toasts (possibly empty)
 */
export function detectToastEvents(sessions, prev, announced) {
  const out = []
  if (!Array.isArray(sessions)) return out
  const seen = announced instanceof Set ? announced : new Set()
  const prevMap = prev instanceof Map ? prev : new Map()

  for (const s of sessions) {
    const key = tileKey(s)
    const before = prevMap.get(key) || { zoneId: 0, burn: false }
    const nowZone = Number(s?.currentZone?.id) || 0
    const nowBurn = isBurn(s?.zonesSeconds)
    const name = s?.displayName || 'Someone'

    // Redline: crossed INTO Zone 5 this tick. Requires a real prior
    // reading (before.zoneId > 0) so a member whose very first sample is
    // already Zone 5 doesn't spuriously toast on their join poll.
    if (nowZone === 5 && before.zoneId > 0 && before.zoneId < 5) {
      const dk = toastDedupeKey(key, 'redline')
      if (!seen.has(dk)) {
        out.push({ key, event: 'redline', name, message: `${name} just hit Zone 5 — Redline` })
        continue // one toast per session per tick; redline outranks burn
      }
    }

    // Burn: crossed the 12-min Z4+ threshold this tick.
    if (nowBurn && !before.burn) {
      const dk = toastDedupeKey(key, 'burn')
      if (!seen.has(dk)) {
        out.push({ key, event: 'burn', name, message: `${name} earned a 🔥 BURN` })
      }
    }
  }
  return out
}

/**
 * Top-N movers for the outro podium. Ranks by effortPoints desc, ties by
 * stable key (deterministic). Drops zero-point sessions so an empty/idle
 * board yields an empty podium. Default N = 3.
 *
 * @returns {Array<{key,name,points,place}>}
 */
export function selectPodium(sessions, n = 3) {
  const list = Array.isArray(sessions) ? sessions : []
  return [...list]
    .map((s) => ({ key: tileKey(s), name: s?.displayName || 'Member', points: Number(s?.effortPoints) || 0 }))
    .filter((s) => s.points > 0)
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : a.key.localeCompare(b.key)))
    .slice(0, Math.max(0, n))
    .map((s, i) => ({ ...s, place: i + 1 }))
}

/**
 * Class-end detection for the outro podium. The class "ended" when the
 * live class transitions from present (a current_class in a prior poll)
 * to absent (null now) — OR when the timer reports finished. Pure: the
 * caller tracks `hadClass` (has current_class been seen this class?).
 *
 * @param {object} args
 *   hadClass        boolean — was a current_class present earlier?
 *   currentClass    the payload's current_class (or null)
 *   timerFinished   boolean — the timer banner reports finished
 * @returns {boolean} true on the transition into "ended"
 */
export function classDidEnd({ hadClass, currentClass, timerFinished }) {
  if (!hadClass) return false
  if (timerFinished) return true
  return !currentClass
}
