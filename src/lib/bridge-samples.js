// Bridge sample ingestion.
//
// The Pi sends batches of (strap_mac, recorded_at, bpm) tuples to
// /api/bridge/samples. For each tuple we need to:
//
//   1. Find the active strap_assignments row for that mac (the
//      coach's pairing of "strap AA:BB:CC → Sarah" at class start).
//   2. Find the heart_rate_sessions row that assignment created.
//   3. Insert into hr_samples (session_id, recorded_at, bpm).
//
// Unmatched samples (a strap broadcasting but not yet paired) are
// silently dropped. They'll show up in the bridge's /scan list so
// the coach can pair them.
//
// Performance
// -----------
// Bridge sends batches of up to ~100 samples per request (one per
// strap per second, batched by ~3-5s). For 30 straps that's ~150
// rows per insert. We:
//   - Look up active strap_assignments for the bridge ONCE per
//     batch and cache the strap_mac → session_id map.
//   - Insert samples in a single .from('hr_samples').insert([...])
//     call. Postgres handles 150 rows in <5ms.
//
// Idempotency
// -----------
// hr_samples PK is (session_id, recorded_at). A retry with the same
// (session_id, recorded_at) gets ON CONFLICT DO NOTHING semantics
// via Supabase's upsert ignoreDuplicates option. Bridge can replay
// safely on network blip + reconnect.

import { logWarn } from '@/lib/log'

/**
 * Look up the strap_mac → session_id map for a bridge. Only includes
 * pairings that are currently active (ended_at IS NULL) AND have a
 * heart_rate_session_id (i.e. the session has been started).
 *
 * @param {SupabaseClient} db  service-role client
 * @param {string} bridgeId
 * @returns {Promise<Map<string, { sessionId: string, contactId: string }>>}
 */
export async function getActiveStrapMap(db, bridgeId) {
  const { data, error } = await db
    .from('strap_assignments')
    .select('strap_mac, contact_id, heart_rate_session_id')
    .eq('ble_bridge_id', bridgeId)
    .is('ended_at', null)
    .not('heart_rate_session_id', 'is', null)

  const map = new Map()
  if (error) {
    logWarn('bridge-samples', 'failed to load strap assignments', { err: error, bridgeId })
    return map
  }
  for (const row of data || []) {
    if (row.strap_mac && row.heart_rate_session_id) {
      // Normalise to upper-case, colon-separated MAC. Some BLE stacks
      // emit lower-case or no-separator forms; we want a single
      // canonical key so the bridge and the assignment row can use
      // either format.
      map.set(canonicaliseMac(row.strap_mac), {
        sessionId: row.heart_rate_session_id,
        contactId: row.contact_id,
      })
    }
  }
  return map
}

/**
 * Take a batch of bridge-reported samples + the active strap map
 * and return the rows ready to insert into hr_samples. Drops samples
 * for unpaired straps. Validates BPM sanity (30..240) — anything
 * outside that range is dropped (BLE noise on a bad signal).
 *
 * @param {Array<{ strap_mac: string, recorded_at: string|Date, bpm: number }>} samples
 * @param {Map<string, { sessionId: string }>} strapMap
 * @returns {{
 *   rows: Array<{ session_id: string, recorded_at: string, bpm: number }>,
 *   stats: { received: number, accepted: number, dropped_unpaired: number, dropped_invalid: number },
 * }}
 */
export function buildHrSampleRows(samples, strapMap) {
  const rows = []
  const stats = { received: 0, accepted: 0, dropped_unpaired: 0, dropped_invalid: 0 }
  for (const s of samples || []) {
    stats.received++
    const mac = canonicaliseMac(s?.strap_mac)
    const bpm = Number(s?.bpm)
    if (!mac || !Number.isFinite(bpm) || bpm < 30 || bpm > 240) {
      stats.dropped_invalid++
      continue
    }
    const recAt = s.recorded_at ? new Date(s.recorded_at) : null
    if (!recAt || Number.isNaN(recAt.getTime())) {
      stats.dropped_invalid++
      continue
    }
    const target = strapMap.get(mac)
    if (!target) {
      stats.dropped_unpaired++
      continue
    }
    rows.push({
      session_id: target.sessionId,
      recorded_at: recAt.toISOString(),
      bpm: Math.round(bpm),
    })
    stats.accepted++
  }
  return { rows, stats }
}

/**
 * Insert rows with ON CONFLICT DO NOTHING semantics on (session_id,
 * recorded_at). A bridge that retries after a network blip won't
 * 409.
 */
export async function insertHrSamples(db, rows) {
  if (rows.length === 0) return { inserted: 0, error: null }
  const { error, count } = await db
    .from('hr_samples')
    .upsert(rows, { onConflict: 'session_id,recorded_at', ignoreDuplicates: true, count: 'estimated' })
  if (error) {
    logWarn('bridge-samples', 'hr_samples upsert failed', { err: error, attempted: rows.length })
    return { inserted: 0, error }
  }
  return { inserted: count ?? rows.length, error: null }
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * Normalise a BLE MAC. Accepts uppercase/lowercase, colon-separated
 * or no-separator. Returns canonical UPPERCASE COLON-SEPARATED
 * AA:BB:CC:DD:EE:FF or null if input doesn't look like a MAC.
 */
export function canonicaliseMac(input) {
  if (typeof input !== 'string') return null
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g).join(':')
}
