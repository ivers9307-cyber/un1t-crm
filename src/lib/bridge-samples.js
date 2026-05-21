// Bridge sample ingestion + auto-association.
//
// Straps are protocol-aware (ANT+ or BLE). Each sample carries a
// `device_key` — a self-describing identifier:
//   ant:12345               ANT+ device number
//   ble:AA:BB:CC:DD:EE:FF   BLE canonical MAC
//
// Routing model: when the bridge sees BPM for device_key X at
// location L, the server resolves X → session_id by:
//
//   1. Override path: strap_assignments (per-class manual pairing
//      for walk-ins / lent straps). If an active row exists for
//      (bridge, device_key), use its heart_rate_session_id.
//
//   2. Auto path: contact_devices (persistent member registry).
//      Look up X → contact_id (constrained to bridge's location).
//      Find an open heart_rate_sessions for that contact at this
//      location; create one if missing AND the contact has an
//      in-progress booking (right now ± grace).
//
//   3. No match: drop the sample silently (will surface in /scan
//      so the coach can manually pair).
//
// The resolution map is built per-batch and cached for the request
// lifespan. A dual-band strap broadcasting on both protocols arrives
// as two distinct device_keys — only the one the member registered
// resolves; the other drops as unpaired. No cross-protocol de-dup is
// needed because protocol-namespaced keys can't collide.

import { logWarn } from '@/lib/log'

// 90 min covers an hour-long class plus 15min before + 15min after.
const BOOKING_WINDOW_MS = 90 * 60 * 1000
// How far before the booking start we already accept samples.
const BOOKING_PRE_GRACE_MS = 30 * 60 * 1000

// ── protocol-aware identifiers ──────────────────────────────────
//
// Shared with champ-bridge/src/device-key.js and champ-app's
// heart-rate-devices.js — duplicated because the three projects are
// separate. If this drifts, champ-bridge's copy is the source.

/**
 * Normalise a BLE MAC. Accepts upper/lowercase, colon / hyphen / no
 * separator. Returns canonical UPPER colon form or null.
 */
export function canonicaliseMac(input) {
  if (typeof input !== 'string') return null
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g).join(':')
}

/**
 * Normalise an ANT+ device number (16-bit, 1-65535). Returns the
 * decimal string (leading zeros stripped) or null.
 */
export function canonicaliseAntId(input) {
  if (input == null) return null
  const s = String(input).trim()
  // Digits only; range — not length — decides validity, so a
  // leading-zero-padded id still canonicalises.
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return String(n)
}

/**
 * Build a device_key from a protocol + raw id. Returns null on a bad
 * protocol or an id that fails its protocol's canonicaliser.
 */
export function makeDeviceKey(protocol, rawId) {
  if (protocol === 'ble') {
    const mac = canonicaliseMac(rawId)
    return mac ? `ble:${mac}` : null
  }
  if (protocol === 'ant') {
    const id = canonicaliseAntId(rawId)
    return id ? `ant:${id}` : null
  }
  return null
}

/**
 * Parse a device_key into { protocol, deviceId }. A BLE key carries
 * its own colons — split on the FIRST colon only. Returns null for
 * anything malformed.
 */
export function parseDeviceKey(key) {
  if (typeof key !== 'string') return null
  const idx = key.indexOf(':')
  if (idx < 1) return null
  const protocol = key.slice(0, idx)
  const rest = key.slice(idx + 1)
  if (protocol === 'ble') {
    const mac = canonicaliseMac(rest)
    return mac ? { protocol: 'ble', deviceId: mac } : null
  }
  if (protocol === 'ant') {
    const id = canonicaliseAntId(rest)
    return id ? { protocol: 'ant', deviceId: id } : null
  }
  return null
}

/**
 * Round-trip a device_key into canonical form, or null if it doesn't
 * parse.
 */
export function canonicaliseDeviceKey(key) {
  const parsed = parseDeviceKey(key)
  return parsed ? `${parsed.protocol}:${parsed.deviceId}` : null
}

// ── pure: build sample rows from a strap → session map ──────────

/**
 * Take a batch of bridge-reported samples + a resolved device_key →
 * session_id map and return rows ready to insert into hr_samples.
 * Drops invalid / unmatched / non-finite samples, records reasons
 * in stats.
 *
 * @param {Array<{ device_key: string, recorded_at: string|Date, bpm: number }>} samples
 * @param {Map<string, { sessionId: string }>} strapMap
 */
export function buildHrSampleRows(samples, strapMap) {
  const rows = []
  const stats = { received: 0, accepted: 0, dropped_unpaired: 0, dropped_invalid: 0 }
  for (const s of samples || []) {
    stats.received++
    const key = canonicaliseDeviceKey(s?.device_key)
    const bpm = Number(s?.bpm)
    if (!key || !Number.isFinite(bpm) || bpm < 30 || bpm > 240) {
      stats.dropped_invalid++
      continue
    }
    const recAt = s.recorded_at ? new Date(s.recorded_at) : null
    if (!recAt || Number.isNaN(recAt.getTime())) {
      stats.dropped_invalid++
      continue
    }
    const target = strapMap.get(key)
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

// ── strap → session resolution ──────────────────────────────────

/**
 * Resolve all unique device_keys in a batch to their target sessions
 * in one combined pass. Returns a Map<canonicalDeviceKey, {
 * sessionId, contactId, via: 'override'|'auto' }>.
 */
export async function resolveStrapsForBatch(db, { bridgeId, locationId, deviceKeys, nowMs = Date.now() }) {
  const map = new Map()
  const uniqueKeys = [...new Set((deviceKeys || []).map(canonicaliseDeviceKey).filter(Boolean))]
  if (uniqueKeys.length === 0) return map

  // (1) Override path: strap_assignments active for this bridge.
  const { data: overrideRows } = await db
    .from('strap_assignments')
    .select('strap_identifier, contact_id, heart_rate_session_id')
    .eq('ble_bridge_id', bridgeId)
    .is('ended_at', null)
    .not('heart_rate_session_id', 'is', null)

  for (const row of overrideRows || []) {
    const canonical = canonicaliseDeviceKey(row.strap_identifier)
    if (canonical && uniqueKeys.includes(canonical) && row.heart_rate_session_id) {
      map.set(canonical, {
        sessionId: row.heart_rate_session_id,
        contactId: row.contact_id,
        via: 'override',
      })
    }
  }

  // (2) Auto path: contact_devices for the remaining device_keys.
  const remaining = uniqueKeys.filter((k) => !map.has(k))
  if (remaining.length === 0) return map

  const { data: deviceRows, error: devErr } = await db
    .from('contact_devices')
    .select('identifier, contact_id, label, contacts!inner(id, location_id)')
    .in('identifier', remaining)
    .eq('is_active', true)
    .eq('contacts.location_id', locationId)

  if (devErr) {
    logWarn('bridge-samples', 'contact_devices lookup failed', { err: devErr, locationId })
    return map
  }

  // For each device, find or create a session tied to the contact's
  // currently-in-progress booking (if any).
  for (const dev of deviceRows || []) {
    const sessionId = await findOrCreateAutoSession(db, {
      contactId: dev.contact_id,
      locationId,
      deviceKey: dev.identifier,
      nowMs,
    })
    if (sessionId) {
      map.set(canonicaliseDeviceKey(dev.identifier) || dev.identifier, {
        sessionId,
        contactId: dev.contact_id,
        via: 'auto',
      })
    }
  }

  return map
}

/**
 * Find an existing open heart_rate_sessions row for this contact at
 * this location, or create one if the contact has an in-progress
 * booking. Returns null if no active booking.
 */
async function findOrCreateAutoSession(db, { contactId, locationId, deviceKey, nowMs }) {
  // (a) any existing open session?
  const { data: existing } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.id) return existing.id

  // (b) find an in-progress booking on today (Dublin date).
  const now = new Date(nowMs)
  const yesterdayIso = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 10)
  const tomorrowIso = new Date(nowMs + 24 * 3600_000).toISOString().slice(0, 10)

  const { data: bookings } = await db
    .from('bookings')
    .select('id, booking_date, start_time, event_type_id, status')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .in('status', ['confirmed', 'attended'])
    .gte('booking_date', yesterdayIso)
    .lte('booking_date', tomorrowIso)

  let activeBooking = null
  for (const b of bookings || []) {
    if (!b.booking_date || !b.start_time) continue
    const bookingMs = new Date(`${b.booking_date}T${b.start_time}Z`).getTime()
    const lo = nowMs - BOOKING_WINDOW_MS
    const hi = nowMs + BOOKING_PRE_GRACE_MS
    if (bookingMs >= lo && bookingMs <= hi) {
      if (!activeBooking || Math.abs(bookingMs - nowMs) < Math.abs(activeBooking.bookingMs - nowMs)) {
        activeBooking = { ...b, bookingMs }
      }
    }
  }

  if (!activeBooking) return null

  // (c) snapshot the contact's max HR onto the session row.
  const { data: contact } = await db
    .from('contacts')
    .select('max_hr_override, dob')
    .eq('id', contactId)
    .single()

  const maxHr = resolveMaxHrForBridgeInsert(contact)

  const { data: created, error: createErr } = await db
    .from('heart_rate_sessions')
    .insert({
      contact_id: contactId,
      location_id: locationId,
      booking_id: activeBooking.id,
      source: 'ble_bridge',
      device_identifier: deviceKey,
      started_at: now.toISOString(),
      max_hr_used: maxHr,
    })
    .select('id')
    .single()

  if (createErr) {
    logWarn('bridge-samples', 'auto-create session failed', {
      err: createErr,
      contactId,
      bookingId: activeBooking.id,
    })
    return null
  }
  return created?.id || null
}

/**
 * Same logic as the shared HR helper resolveMaxHr but inlined so
 * un1t-crm doesn't depend on champ-app's shared module.
 */
function resolveMaxHrForBridgeInsert(contact) {
  const override = Number(contact?.max_hr_override)
  if (Number.isFinite(override) && override >= 100 && override <= 240) {
    return Math.round(override)
  }
  if (contact?.dob) {
    const dobMs = new Date(contact.dob).getTime()
    if (Number.isFinite(dobMs)) {
      const ageYears = (Date.now() - dobMs) / (365.25 * 24 * 3600 * 1000)
      if (ageYears > 5 && ageYears < 110) {
        const tanaka = 208 - 0.7 * Math.floor(ageYears)
        return Math.round(Math.max(140, Math.min(220, tanaka)))
      }
    }
  }
  return 180
}

// ── insertion ───────────────────────────────────────────────────

/**
 * Upsert with onConflict (session_id, recorded_at) ignoreDuplicates.
 * Bridge retries after a network blip don't 409.
 *
 * Also opportunistically touches heart_rate_sessions.last_sample_at
 * for each session represented in the batch.
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

  const latestPerSession = new Map()
  for (const r of rows) {
    const prev = latestPerSession.get(r.session_id)
    if (!prev || r.recorded_at > prev) latestPerSession.set(r.session_id, r.recorded_at)
  }
  await Promise.all(
    Array.from(latestPerSession.entries()).map(([sessionId, ts]) =>
      db.from('heart_rate_sessions')
        .update({ last_sample_at: ts })
        .eq('id', sessionId)
        .then(({ error: e }) => {
          if (e) logWarn('bridge-samples', 'last_sample_at touch failed', { err: e, sessionId })
        }),
    ),
  )

  return { inserted: count ?? rows.length, error: null }
}

// ── back-compat shim ────────────────────────────────────────────
//
// Old callers used getActiveStrapMap(db, bridgeId) — thin wrapper
// around the override layer only.

export async function getActiveStrapMap(db, bridgeId) {
  const { data } = await db
    .from('strap_assignments')
    .select('strap_identifier, contact_id, heart_rate_session_id')
    .eq('ble_bridge_id', bridgeId)
    .is('ended_at', null)
    .not('heart_rate_session_id', 'is', null)
  const map = new Map()
  for (const row of data || []) {
    const canonical = canonicaliseDeviceKey(row.strap_identifier)
    if (canonical && row.heart_rate_session_id) {
      map.set(canonical, { sessionId: row.heart_rate_session_id, contactId: row.contact_id })
    }
  }
  return map
}
