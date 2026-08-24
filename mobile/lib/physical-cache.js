// mobile/lib/physical-cache.js
//
// HOME-FAST.1 — the two blobs Home persists ACROSS LAUNCHES so a reopen at
// the studio paints before the network and the GPS radio answer:
//
//   1. The physical-location snapshot — the geofence regions, the last
//      accepted position fix, and the last at_studio verdict. Seeds
//      use-physical-location.js's module caches on the first resolve after a
//      module load.
//   2. The last shifts list, slimmed, keyed by profile id — Home's offsite
//      view, painted instantly and replaced by the normal fetch.
//
// Storage is expo-secure-store (iOS Keychain), following studio-device.js's
// idiom EXACTLY: JSON in one value per key, a CSV index of the per-user keys
// so teardown can find them all, and every read AND write wrapped in its own
// try/catch. SecureStore has a ~2 KB per-value limit, so a write can fail
// silently — that just means no speed-up on the next launch, never a crash
// and never a blocked screen. NOTHING here is a source of truth: every value
// is a copy of something the network or the OS will re-answer.
//
// No decisions live here — every shape/freshness rule is in
// physical-snapshot.js (pure, vitest-tested). This module is the thin IO
// half, which is why it holds no `if` beyond the empty-key guards.
//
// NEVER put tokens or customer data in here: same rule as the menu cache.

import * as SecureStore from 'expo-secure-store'
import {
  parsePhysicalSnapshot,
  buildPhysicalSnapshot,
  buildShiftsSnapshot,
  parseShiftsSnapshot,
} from './physical-snapshot'

const SNAPSHOT_KEY = 'physical_location_snapshot_v1'
const SHIFTS_PREFIX = 'home_shifts_cache_v1.'
const SHIFTS_INDEX_KEY = 'home_shifts_cache_v1_index' // CSV of cached profile ids

// --- Physical-location snapshot -----------------------------------------

/**
 * The persisted snapshot, validated and freshness-gated. Always resolves to
 * the full `{ at, regions, position, verdict }` shape — an unreadable or
 * absent value simply returns nulls, so callers never branch on failure.
 */
export async function readPhysicalSnapshot(nowMs = Date.now()) {
  let raw = null
  try {
    raw = await SecureStore.getItemAsync(SNAPSHOT_KEY)
  } catch {
    // Unreadable keychain — parse(null) below gives the all-null shape.
  }
  return parsePhysicalSnapshot(raw, nowMs)
}

/**
 * Best-effort persist after a resolve. Never throws. `regionsAt` carries the
 * regions' own provenance (see buildPhysicalSnapshot) — omit it only when the
 * regions were genuinely just fetched.
 */
export async function writePhysicalSnapshot({ regions, regionsAt, position, result, nowMs = Date.now() }) {
  try {
    const snapshot = buildPhysicalSnapshot({ regions, regionsAt, position, result, nowMs })
    await SecureStore.setItemAsync(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // best-effort — a failed write only costs the next launch its head start.
  }
}

// --- Shifts cache --------------------------------------------------------

/**
 * The cached shifts for `profileId`, or null when there is nothing usable.
 * `[]` is a real cached answer (an empty week) and is NOT null.
 */
export async function readShiftsCache(profileId, nowMs = Date.now()) {
  if (!profileId) return null
  try {
    const raw = await SecureStore.getItemAsync(`${SHIFTS_PREFIX}${profileId}`)
    return parseShiftsSnapshot(raw, { profileId, nowMs })
  } catch {
    return null
  }
}

/** Best-effort persist of the slimmed shifts for `profileId`. Never throws. */
export async function writeShiftsCache(profileId, shifts, nowMs = Date.now()) {
  if (!profileId) return
  try {
    const snapshot = buildShiftsSnapshot({ profileId, shifts, nowMs })
    await SecureStore.setItemAsync(`${SHIFTS_PREFIX}${profileId}`, JSON.stringify(snapshot))
    await addToShiftsIndex(profileId)
  } catch {
    // best-effort — a week of shifts can exceed SecureStore's ~2 KB value
    // limit for a heavily-booked coach, exactly like the menu cache.
  }
}

async function addToShiftsIndex(profileId) {
  const idx = await SecureStore.getItemAsync(SHIFTS_INDEX_KEY)
  const ids = new Set(idx ? idx.split(',').filter(Boolean) : [])
  ids.add(profileId)
  await SecureStore.setItemAsync(SHIFTS_INDEX_KEY, Array.from(ids).join(','))
}

// --- Teardown ------------------------------------------------------------

/**
 * Drop everything this module persists. Reached from the sign-out teardown
 * union via clearPhysicalLocationCaches() (lib/sign-out.js): on a shared
 * studio device the next user must not resolve "which studio am I in"
 * against the previous user's regions and last fix, nor see their roster.
 * Best-effort and never throws — sign-out must not block on bookkeeping.
 */
export async function clearPhysicalCaches() {
  try {
    await SecureStore.deleteItemAsync(SNAPSHOT_KEY)
  } catch {
    // best-effort
  }
  try {
    const idx = await SecureStore.getItemAsync(SHIFTS_INDEX_KEY)
    const ids = idx ? idx.split(',').filter(Boolean) : []
    for (const id of ids) await SecureStore.deleteItemAsync(`${SHIFTS_PREFIX}${id}`)
    await SecureStore.deleteItemAsync(SHIFTS_INDEX_KEY)
  } catch {
    // best-effort
  }
}
