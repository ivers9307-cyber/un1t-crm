import * as SecureStore from 'expo-secure-store'

// WAVE-9 — "seen the weekly digest" flag, keyed by the recapped Dublin ISO-week
// ('YYYY-Www', e.g. '2026-W27'), so the in-app "Your week" Home card appears at
// most ONCE per ISO week and never re-ambushes the member on later home visits
// that same week. Mirrors the monthly "wrapped" flag in mobile/lib/recap-seen.js
// but lives in its own module with its OWN prefix, so the week + month flags are
// completely independent — dismissing one never affects the other.
//
// SecureStore keys must match [A-Za-z0-9._-]; ISO-week keys already are, but we
// sanitise defensively. All ops are best-effort and never throw (matches
// recap-seen.js): the digest is a nice-to-have, not something to crash Home over.

const PREFIX = 'week_digest_seen_'

function keyFor(weekKey) {
  return PREFIX + String(weekKey || '').replace(/[^A-Za-z0-9._-]/g, '')
}

/** Has the member already seen the weekly digest for this Dublin ISO-week? */
export async function hasSeenWeekDigest(weekKey) {
  if (!weekKey) return true // no key → never show
  try {
    return (await SecureStore.getItemAsync(keyFor(weekKey))) != null
  } catch {
    // Fail "seen" on a storage error so we never repeatedly pop the card.
    return true
  }
}

/** Mark this ISO-week's digest as seen (idempotent, best-effort). */
export async function markWeekDigestSeen(weekKey) {
  if (!weekKey) return
  try { await SecureStore.setItemAsync(keyFor(weekKey), String(Date.now())) } catch { /* best-effort */ }
}

/** Clear the flag (test/replay affordance; not wired into the UI). */
export async function clearWeekDigestSeen(weekKey) {
  if (!weekKey) return
  try { await SecureStore.deleteItemAsync(keyFor(weekKey)) } catch { /* best-effort */ }
}
