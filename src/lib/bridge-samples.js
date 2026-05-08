// Bridge sample ingestion + auto-association.
//
// New (mig 112) routing model: when the bridge sees BPM for MAC X
// at location L, the server resolves X → session_id by:
//
//   1. Override path: strap_assignments (per-class manual pairing
//      for walk-ins / lent straps). If an active row exists for
//      (bridge, mac), use its heart_rate_session_id.
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
// lifespan. For a 30-strap class that means 1 query for overrides
// + 1 query for devices + N queries for booking lookups (at most
// 30) — small. Future work: bulk the booking lookups.
//
// Concurrency note: heart_rate_sessions creation is select-then-
// insert, so a racy two-sample-at-once could double-create. Bridge
// connections are sequential per Pi so this only matters if the
// same MAC arrives via two distinct bridges (unlikely — one gym
// per bridge). If we see duplicates in production, add a partial
// unique index on (contact_id, booking_id, source) WHERE
// ended_at IS NULL.

import { logWarn } from '@/lib/log'

// 90 min covers an hour-long class plus 15min before + 15min after
// so a member who comes early or stays late still has their HR
// auto-route to the right booking.
const BOOKING_WINDOW_MS = 90 * 60 * 1000
// How far before the booking start we already accept samples.
// Members chest-strap up early; we want their warmup HR to count.
const BOOKING_PRE_GRACE_MS = 30 * 60 * 1000

// ── canonicalisation ─────────────────────────────────────────────

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

// ── pure: build sample rows from a strap → session map ──────────

/**
 * Take a batch of bridge-reported samples + a resolved strap_mac →
 * session_id map and return rows ready to insert into hr_samples.
 * Drops invalid / unmatched / non-finite samples, records reasons
 * in stats.
 *
 * @param {Array<{ strap_mac: string, recorded_at: string|Date, bpm: number }>} samples
 * @param {Map<string, { sessionId: string }>} strapMap
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

// ── strap → session resolution ──────────────────────────────────

/**
 * Resolve all unique MACs in a batch to their target sessions in
 * one combined pass. Returns a Map<canonicalMac, { sessionId,
 * contactId, via: 'override'|'auto' }>.
 *
 * `via` is informational — the API route surfaces it in the
 * response so the bridge / coach UI can tell whether a sample was
 * manually paired or auto-routed.
 */
export async function resolveStrapsForBatch(db, { bridgeId, locationId, macs, nowMs = Date.now() }) {
  const map = new Map()
  const uniqueMacs = [...new Set((macs || []).map(canonicaliseMac).filter(Boolean))]
  if (uniqueMacs.length === 0) return map

  // (1) Override path: strap_assignments active for this bridge.
  const { data: overrideRows } = await db
    .from('strap_assignments')
    .select('strap_mac, contact_id, heart_rate_session_id')
    .eq('ble_bridge_id', bridgeId)
    .is('ended_at', null)
    .not('heart_rate_session_id', 'is', null)

  for (const row of overrideRows || []) {
    const canonical = canonicaliseMac(row.strap_mac)
    if (canonical && uniqueMacs.includes(canonical) && row.heart_rate_session_id) {
      map.set(canonical, {
        sessionId: row.heart_rate_session_id,
        contactId: row.contact_id,
        via: 'override',
      })
    }
  }

  // (2) Auto path: contact_devices for the remaining MACs.
  const remaining = uniqueMacs.filter((m) => !map.has(m))
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
      strapMac: dev.identifier,
      nowMs,
    })
    if (sessionId) {
      map.set(dev.identifier, {
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
 * booking. Returns null if no active booking — the strap is broadcasting
 * but the member isn't booked into anything right now.
 */
async function findOrCreateAutoSession(db, { contactId, locationId, strapMac, nowMs }) {
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

  // (b) find an in-progress booking. We look at bookings on today
  // (Dublin date — booking_date is naïve) whose start_time falls
  // within [now - BOOKING_WINDOW_MS, now + BOOKING_PRE_GRACE_MS].
  // booking_date + start_time are stored as a naïve date+time
  // pair; compose them and treat as UTC. Around DST transitions
  // there's a ±1h drift but the wide window absorbs it.
  const now = new Date(nowMs)
  const yesterdayIso = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 10)
  const tomorrowIso = new Date(nowMs + 24 * 3600_000).toISOString().slice(0, 10)

  const { data: bookings } = await db
    .from('bookings')
    .select('id, booking_date, start_time, event_type_id, status')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .in('status', ['confirmed', 'attended'])
    // ±1 day filter cheaply scopes the result set; final in-window
    // check is done below in JS for precision.
    .gte('booking_date', yesterdayIso)
    .lte('booking_date', tomorrowIso)

  let activeBooking = null
  for (const b of bookings || []) {
    if (!b.booking_date || !b.start_time) continue
    const bookingMs = new Date(`${b.booking_date}T${b.start_time}Z`).getTime()
    const lo = nowMs - BOOKING_WINDOW_MS
    const hi = nowMs + BOOKING_PRE_GRACE_MS
    if (bookingMs >= lo && bookingMs <= hi) {
      // Pick the booking whose start is closest to now.
      if (!activeBooking || Math.abs(bookingMs - nowMs) < Math.abs(activeBooking.bookingMs - nowMs)) {
        activeBooking = { ...b, bookingMs }
      }
    }
  }

  if (!activeBooking) return null

  // (c) compute the contact's max HR for the session — needed for
  // zone math at session-end. We snapshot it on the row so future
  // edits to contacts.max_hr_override don't retroactively reshape
  // historical sessions.
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
      device_identifier: strapMac,
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
 * Same logic as shared HR helper resolveMaxHr but inlined here so
 * un1t-crm doesn't depend on champ-app's shared module. Single
 * source of truth migration is on the Phase-2 follow-up list.
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
 * for each session represented in the batch — the live coach view
 * uses that column to flag stale sessions ("strap silent for >2min").
 * Best-effort: a failure here is logged but does not fail the
 * sample insert.
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

  // Touch last_sample_at on each affected session. Use the latest
  // recorded_at per session (rather than now()) so the column
  // reflects the actual sample timestamp the bridge sent — robust
  // to clock skew between bridge + server.
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
// Old callers used getActiveStrapMap(db, bridgeId). Now thin
// wrapper around resolveStrapsForBatch with no MAC list (returns
// only the override layer). Kept so the tests for v1 still pass;
// remove once they're rewritten against resolveStrapsForBatch.

export async function getActiveStrapMap(db, bridgeId) {
  const { data } = await db
    .from('strap_assignments')
    .select('strap_mac, contact_id, heart_rate_session_id')
    .eq('ble_bridge_id', bridgeId)
    .is('ended_at', null)
    .not('heart_rate_session_id', 'is', null)
  const map = new Map()
  for (const row of data || []) {
    const canonical = canonicaliseMac(row.strap_mac)
    if (canonical && row.heart_rate_session_id) {
      map.set(canonical, { sessionId: row.heart_rate_session_id, contactId: row.contact_id })
    }
  }
  return map
}
