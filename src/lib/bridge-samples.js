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
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'
import { lookupBookedMember, resolveClassLinkSource, resolveBookedOccurrenceForMember } from '@/lib/class-bookings'
import { classSessionAction } from '@/lib/hr-session-lifecycle'

// 90 min covers an hour-long class plus 15min before + 15min after.
const BOOKING_WINDOW_MS = 90 * 60 * 1000
// How far before the booking start we already accept samples.
const BOOKING_PRE_GRACE_MS = 30 * 60 * 1000

// Booking-first grace: a registered, BOOKED member's strap routes this wide
// around their class (warmup/cooldown). Only behind a confirmed booking — the
// presence fallback below stays at the tight OCC_PRE/POST window.
export const BOOKED_PRE_MS = 45 * 60_000
export const BOOKED_POST_MS = 30 * 60_000

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
 * A privacy-safe display label for an unpaired strap on the PUBLIC TV.
 * ANT+ → the device number (not PII). BLE → last 4 hex of the MAC, masked
 * (never the full MAC on a public screen). Bad key → a generic 'Strap'.
 *
 * @param {string} deviceKey
 * @returns {string}
 */
export function maskStrapLabel(deviceKey) {
  const parsed = parseDeviceKey(deviceKey)
  if (!parsed) return 'Strap'
  if (parsed.protocol === 'ant') return `Strap ${parsed.deviceId}`
  const hex = String(parsed.deviceId).replace(/[^0-9A-Fa-f]/g, '')
  return hex.length >= 4 ? `Strap ••${hex.slice(-4).toUpperCase()}` : 'Strap'
}

/**
 * Round-trip a device_key into canonical form, or null if it doesn't
 * parse.
 */
export function canonicaliseDeviceKey(key) {
  const parsed = parseDeviceKey(key)
  return parsed ? `${parsed.protocol}:${parsed.deviceId}` : null
}

// ── pure: bridge liveness ───────────────────────────────────────
//
// A bridge updates ble_bridges.last_seen_at on every heartbeat (~30s)
// and scan (~5s). The `status` column can lie — on a power cut the Pi
// can't send a final 'offline', so it stays 'online'. Freshness of
// last_seen_at is the honest liveness signal, so the TV connection dot
// keys off that, not status.

// 60s = two missed 30s heartbeats (and a dozen missed 5s scans), so a
// healthy bridge is never falsely flagged while a dead one trips fast.
export const BRIDGE_ONLINE_WINDOW_MS = 60 * 1000

/**
 * Most-recent last_seen_at across a set of bridge rows, as epoch ms
 * (0 if none have ever been seen). A location may have >1 bridge; the
 * room is "covered" if ANY of them is live, so we take the max.
 * @param {Array<{ last_seen_at?: string|null }>} bridges
 */
export function latestBridgeSeenMs(bridges) {
  let max = 0
  for (const b of bridges || []) {
    if (!b?.last_seen_at) continue
    const t = new Date(b.last_seen_at).getTime()
    if (Number.isFinite(t) && t > max) max = t
  }
  return max
}

/**
 * Is any bridge at the location "live" — seen within the freshness
 * window? Drives the TV display's connection dot.
 * @param {Array<{ last_seen_at?: string|null }>} bridges
 * @param {number} nowMs
 * @param {number} windowMs
 */
export function isBridgeOnline(bridges, nowMs = Date.now(), windowMs = BRIDGE_ONLINE_WINDOW_MS) {
  const last = latestBridgeSeenMs(bridges)
  return last > 0 && (nowMs - last) < windowMs
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

  // Staff HR test mode (mig 321) — registered straps route any time while active.
  let testModeActive = false
  if (deviceRows && deviceRows.length > 0) {
    const { data: bridge } = await db
      .from('ble_bridges').select('test_mode_until').eq('id', bridgeId).maybeSingle()
    testModeActive = !!bridge?.test_mode_until && new Date(bridge.test_mode_until).getTime() > nowMs
  }

  // For each device, find or create a session tied to the contact's
  // currently-in-progress booking (if any).
  for (const dev of deviceRows || []) {
    const sessionId = await findOrCreateAutoSession(db, {
      contactId: dev.contact_id,
      locationId,
      deviceKey: dev.identifier,
      nowMs,
      testModeActive,
    })
    if (sessionId) {
      map.set(canonicaliseDeviceKey(dev.identifier) || dev.identifier, {
        sessionId,
        contactId: dev.contact_id,
        via: 'auto',
      })
    }
  }

  // (3) Anonymous path: any still-unmatched strap, but ONLY while a class is
  // live — create a contact-less session labelled by its device id so walk-ins
  // (visitors with no contact_devices row) appear on the board. No class
  // running → leave it unmatched (its samples are dropped, as before).
  const stillUnmatched = uniqueKeys.filter((k) => !map.has(k))
  if (stillUnmatched.length > 0) {
    const occ = await resolveCurrentOccurrence(db, { locationId, nowMs })
    if (occ) {
      for (const key of stillUnmatched) {
        const sessionId = await findOrCreateAnonymousSession(db, { locationId, deviceKey: key, occ, nowMs })
        if (sessionId) map.set(key, { sessionId, contactId: null, via: 'anon' })
      }
    }
  }

  return map
}

/**
 * Re-select the current OPEN session for a member at a location. Used to
 * recover from a unique-violation (23505) on the mig 343 partial index: a
 * racing overlapping request already created/reopened the open session, so we
 * return its id rather than null. Returns null only if it has since closed.
 */
async function reselectOpenMemberSession(db, { contactId, locationId }) {
  const { data } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

/**
 * Re-select the current OPEN anonymous session for a strap at a location, to
 * recover from a 23505 on the mig 343 anon partial index (a racing request
 * won the insert). Returns null only if it has since closed.
 */
async function reselectOpenAnonSession(db, { locationId, deviceKey }) {
  const { data } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('location_id', locationId)
    .eq('device_identifier', deviceKey)
    .is('contact_id', null)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

/**
 * Find an existing open heart_rate_sessions row for this contact at this
 * location, or create one. Resolution, in priority:
 *   (a) an existing OPEN session → return it (rejoin across drop-outs),
 *       backfilling the class link booking-first.
 *   (b) a class for this member → tie the session to it. Booking-first (the
 *       member's BOOKED occurrence, wide 45/30 window) else the location-wide
 *       live class (presence, tight OCC_PRE/POST). Class-keyed dedup: reopen a
 *       closed (member, class) session while the class is still live; skip once
 *       it has ended.
 *   (c) test mode active (mig 321) → a presence-less session any time.
 *   (d) an in-progress native CRM booking (consultation / PT) → tie to it.
 * Returns null if none apply.
 */
async function findOrCreateAutoSession(db, { contactId, locationId, deviceKey, nowMs, testModeActive = false }) {
  // (a) Any existing OPEN session for this contact? Return it (rejoin across a
  // mid-class drop-out works because the stale-close cron defers closing
  // class-linked sessions until class end). Backfill the class link booking-first.
  const { data: existing } = await db
    .from('heart_rate_sessions')
    .select('id, glofox_event_id')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Contact's max HR + glofox id (used by backfill + create paths).
  const { data: contact } = await db
    .from('contacts')
    .select('max_hr_override, dob, glofox_member_id')
    .eq('id', contactId)
    .single()

  // Resolve the class for this member NOW: booking-first (wide), then presence (tight).
  const bookedOcc = await resolveBookedOccurrenceForMember(db, {
    locationId, glofoxMemberId: contact?.glofox_member_id, nowMs, preMs: BOOKED_PRE_MS, postMs: BOOKED_POST_MS,
  })
  const occ = bookedOcc || await resolveCurrentOccurrence(db, { locationId, nowMs })
  const linkSource = occ
    ? (bookedOcc ? 'booked' : resolveClassLinkSource({
        liveClass: occ,
        booked: await lookupBookedMember(db, { locationId, glofoxEventId: occ.glofox_event_id, glofoxMemberId: contact?.glofox_member_id }),
      }))
    : null

  if (existing?.id) {
    if (!existing.glofox_event_id && occ) {
      await db.from('heart_rate_sessions')
        .update({ glofox_event_id: occ.glofox_event_id, class_name: occ.class_name, class_link_source: linkSource })
        .eq('id', existing.id)
    }
    return existing.id
  }

  const maxHr = resolveMaxHrForBridgeInsert(contact)
  const nowIso = new Date(nowMs).toISOString()

  // (b) Class-linked create (booking-first or presence). One session per
  // (member, class): reopen a closed one while the class is still live; skip
  // (no new session, no duplicate email) once the class has ended.
  if (occ) {
    const { data: priorForClass } = await db
      .from('heart_rate_sessions')
      .select('id, ended_at')
      .eq('contact_id', contactId)
      .eq('glofox_event_id', occ.glofox_event_id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const action = classSessionAction({ existing: priorForClass || null, occ, nowMs })
    if (action === 'return') return priorForClass.id
    if (action === 'skip') return null
    if (action === 'reopen') {
      const { error: reopenErr } = await db
        .from('heart_rate_sessions').update({ ended_at: null }).eq('id', priorForClass.id)
      // A racing request already reopened/created this member's open session:
      // the mig 343 index rejects a second open row. Return the existing one.
      if (reopenErr?.code === '23505') {
        return (await reselectOpenMemberSession(db, { contactId, locationId })) || priorForClass.id
      }
      return priorForClass.id
    }
    const { data: created, error: createErr } = await db
      .from('heart_rate_sessions')
      .insert({
        contact_id: contactId, location_id: locationId, booking_id: null, source: 'ble_bridge',
        device_identifier: deviceKey, started_at: nowIso, max_hr_used: maxHr,
        glofox_event_id: occ.glofox_event_id, class_name: occ.class_name, class_link_source: linkSource,
      })
      .select('id').single()
    if (createErr) {
      // Lost the check-then-insert race: another request opened this member's
      // session between our SELECT and INSERT. Return the winner (mig 343).
      if (createErr.code === '23505') return reselectOpenMemberSession(db, { contactId, locationId })
      logWarn('bridge-samples', 'auto-create (class) session failed', { err: createErr, contactId, glofox_event_id: occ.glofox_event_id })
      return null
    }
    return created?.id || null
  }

  // (c) Test mode — presence-less session any time (no class, no booking).
  if (testModeActive) {
    const { data: created, error: tErr } = await db
      .from('heart_rate_sessions')
      .insert({
        contact_id: contactId, location_id: locationId, booking_id: null, source: 'ble_bridge',
        device_identifier: deviceKey, started_at: nowIso, max_hr_used: maxHr,
        glofox_event_id: null, class_name: null, class_link_source: null,
      })
      .select('id').single()
    if (tErr) {
      if (tErr.code === '23505') return reselectOpenMemberSession(db, { contactId, locationId })
      logWarn('bridge-samples', 'auto-create (test mode) session failed', { err: tErr, contactId })
      return null
    }
    return created?.id || null
  }

  // (d) FALLBACK: an in-progress native CRM booking (consultation / PT).
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
    const bookingMs = dublinWallClockToMs(b.booking_date, b.start_time)
    if (!Number.isFinite(bookingMs)) continue
    const lo = nowMs - BOOKING_WINDOW_MS
    const hi = nowMs + BOOKING_PRE_GRACE_MS
    if (bookingMs >= lo && bookingMs <= hi) {
      if (!activeBooking || Math.abs(bookingMs - nowMs) < Math.abs(activeBooking.bookingMs - nowMs)) {
        activeBooking = { ...b, bookingMs }
      }
    }
  }
  if (!activeBooking) return null

  const { data: created, error: createErr } = await db
    .from('heart_rate_sessions')
    .insert({
      contact_id: contactId, location_id: locationId, booking_id: activeBooking.id, source: 'ble_bridge',
      device_identifier: deviceKey, started_at: nowIso, max_hr_used: maxHr,
    })
    .select('id').single()
  if (createErr) {
    if (createErr.code === '23505') return reselectOpenMemberSession(db, { contactId, locationId })
    logWarn('bridge-samples', 'auto-create session failed', { err: createErr, contactId, bookingId: activeBooking.id })
    return null
  }
  return created?.id || null
}

/**
 * Find or create an ANONYMOUS (contact-less) session for an unregistered strap
 * broadcasting during a live class — so walk-ins / visitors appear on the board
 * labelled by their device id (HR-CLASS-ALLOC.2). Idempotent: reuses an existing
 * open anon session for the same strap so repeated batches don't spawn dupes.
 */
async function findOrCreateAnonymousSession(db, { locationId, deviceKey, occ, nowMs }) {
  const { data: existing } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('location_id', locationId)
    .eq('device_identifier', deviceKey)
    .is('contact_id', null)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.id) return existing.id

  const { data: created, error } = await db
    .from('heart_rate_sessions')
    .insert({
      contact_id: null,
      location_id: locationId,
      booking_id: null,
      source: 'ble_bridge',
      device_identifier: deviceKey,
      started_at: new Date(nowMs).toISOString(),
      max_hr_used: resolveMaxHrForBridgeInsert(null),
      glofox_event_id: occ.glofox_event_id,
      class_name: occ.class_name,
      class_link_source: 'presence',
    })
    .select('id')
    .single()
  if (error) {
    // Lost the race to another overlapping batch: the mig 343 anon index
    // rejects a second open session for this strap. Return the winner.
    if (error.code === '23505') return reselectOpenAnonSession(db, { locationId, deviceKey })
    logWarn('bridge-samples', 'anon session create failed', { err: error, deviceKey })
    return null
  }
  return created?.id || null
}

/**
 * Convert a Dublin wall-clock date + time (the shape `bookings.booking_date`
 * 'YYYY-MM-DD' + `bookings.start_time` 'HH:MM[:SS]' are stored in — operator-
 * local, no tz) to an absolute epoch-ms instant. The naive
 * `new Date(\`${date}T${time}Z\`)` treats it as UTC and is off by the BST
 * offset (+1h Mar–Oct). Pure + exported for tests.
 */
export function dublinWallClockToMs(dateStr, timeStr) {
  const dm = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const tm = String(timeStr || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!dm || !tm) return NaN
  const y = +dm[1], mo = +dm[2], d = +dm[3]
  const h = +tm[1], mi = +tm[2], s = +(tm[3] || 0)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  // What Dublin wall-clock does that UTC instant show? The delta is Dublin's
  // offset from UTC at that moment.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const p = {}
  for (const part of dtf.formatToParts(new Date(asUtc))) p[part.type] = part.value
  const tzAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  const offset = tzAsUtc - asUtc
  return asUtc - offset
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
