// TZ.14 — which clock a STAFF screen reads a record in (decision D3 = A).
//
// A record is shown in its own studio's timezone (`locations.timezone`, carried
// on every location of /api/mobile/me since TZ.14). When that zone differs from
// the phone's own zone, a time carries the zone's abbreviation ("09:00 EST"),
// so a manager in Dublin reading a New York shift knows whose 09:00 it is. A
// Dublin record on a phone set to Dublin renders exactly as before: no suffix,
// same text.
//
// Pure: no React, no IO. The hooks are mobile/lib/use-studio-zone.js. Every
// Intl formatter is built lazily through shared/zoned-time (Hermes-safe: a
// build without full ICU can never fail this module's evaluation).
//
// The suffix rule (same-zone test, abbreviation, ' EST' suffix) is
// shared/zone-suffix.js, the ONE implementation the web's
// src/lib/record-time.js (TZ.16) re-exports too; this module only adds the
// phone's own zone as the default viewer.

import { DEFAULT_TZ, canonicalZone, resolveZone, formatInZone } from 'shared/zoned-time'
import { zoneSuffix as sharedZoneSuffix } from 'shared/zone-suffix'

export { sameZone, zoneAbbreviation as zoneAbbrev } from 'shared/zone-suffix'

/** A /api/mobile/me location row → its canonical zone (Dublin floor for absent/invalid). */
export function zoneOfLocationRow(loc) {
  return resolveZone(loc?.timezone)
}

/**
 * A resolver from location id to zone, over the locations the staff session
 * already holds (/api/mobile/me). A record from a studio outside that list
 * (rare: the routes scope reads to the caller's studios) takes the active
 * studio's zone; no session at all takes the platform default.
 * @param {{ locations?: Array<{id:string, timezone?:string|null}>, activeLocation?: {id:string, timezone?:string|null}|null }} auth
 * @returns {(locationId?: string|null) => string}
 */
export function locationZoneResolver({ locations, activeLocation } = {}) {
  const byId = new Map()
  for (const l of locations || []) if (l?.id) byId.set(l.id, zoneOfLocationRow(l))
  if (activeLocation?.id && !byId.has(activeLocation.id)) byId.set(activeLocation.id, zoneOfLocationRow(activeLocation))
  const fallback = activeLocation ? zoneOfLocationRow(activeLocation) : DEFAULT_TZ
  return (locationId) => (locationId && byId.get(locationId)) || fallback
}

// ── the viewer's zone ───────────────────────────────────────────────────────
// Read once per process, lazily. undefined = not read yet; null = unreadable.
let _device
/** The phone's own IANA zone, or null when the runtime cannot say. Never throws. */
export function deviceZone() {
  if (_device === undefined) {
    try {
      _device = canonicalZone(new Intl.DateTimeFormat().resolvedOptions().timeZone) || null
    } catch {
      _device = null
    }
  }
  return _device
}
/** Test seam. */
export function _resetDeviceZone() { _device = undefined }

/**
 * ' EST' when the record's zone differs from the viewer's, '' otherwise (and ''
 * when the viewer's zone is unknown: the pre-TZ.14 text, never a guess).
 */
export function zoneSuffix(instant, zone, viewerZone = deviceZone()) {
  return sharedZoneSuffix(instant, zone, viewerZone)
}

function parseInstant(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

const DATE_OPTS = { day: 'numeric', month: 'short', year: 'numeric' }
const DATE_TIME_OPTS = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
const TIME_OPTS = { hour: '2-digit', minute: '2-digit' }

/** '3 Oct 2026, 14:05' in the record's zone (+ suffix per D3); '' for no/invalid instant. */
export function studioDateTimeLabel(iso, zone, viewerZone = deviceZone()) {
  const d = parseInstant(iso)
  if (!d) return ''
  return formatInZone(d, zone, DATE_TIME_OPTS) + zoneSuffix(d, zone, viewerZone)
}

/** '3 Oct 2026' in the record's zone; '' for no/invalid instant. A bare date carries no suffix. */
export function studioDateLabel(iso, zone) {
  const d = parseInstant(iso)
  return d ? formatInZone(d, zone, DATE_OPTS) : ''
}

/** '14:05' in the record's zone (+ suffix per D3); null for no/invalid instant. */
export function studioTimeLabel(iso, zone, viewerZone = deviceZone()) {
  const d = parseInstant(iso)
  if (!d) return null
  return formatInZone(d, zone, TIME_OPTS) + zoneSuffix(d, zone, viewerZone)
}

/**
 * A Postgres `date` ('2026-03-01') as '1 Mar 2026'. Not an instant: it is read
 * as UTC midnight, so it is formatted in UTC, never a studio zone (a zone
 * behind UTC would show the previous day).
 */
export function dateOnlyLabel(dateStr) {
  const d = parseInstant(dateStr)
  return d ? formatInZone(d, 'UTC', DATE_OPTS) : ''
}
