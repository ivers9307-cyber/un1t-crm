// mobile/lib/physical-snapshot.js
//
// HOME-FAST.1 — pure validation of everything Home persists ACROSS LAUNCHES so
// it can paint before the network (and the GPS radio) answer:
//
//   • the physical-location snapshot — { at, regions, position, verdict } —
//     written after every successful resolve and read once per module load;
//   • the last shifts list, slimmed and keyed by profile id.
//
// NO native imports — vitest runs this in Node (the geofence-permission.js
// rule). The storage side is physical-cache.js (expo-secure-store); the hook
// that consumes it is use-physical-location.js.
//
// Discipline, everywhere below: ABSENT IS NOT ZERO. Every numeric is checked
// with Number.isFinite and every list with Array.isArray before it is
// believed — a `null` latitude coerced to 0 resolves against the Gulf of
// Guinea, and a `null` timestamp coerced to 0 makes a 56-year-old fix look
// like the epoch rather than like garbage. Ages are measured with
// Math.abs(now - at) so a backwards clock change (or a future-dated write)
// can never make a stale record look fresh — the same rule pickPosition uses.
//
// The three freshness windows, and why they differ:
//   • regions — 24h. They change ~never (a geofence is edited by hand,
//     rarely), so a day-old copy is a fine thing to paint with while a
//     background refresh corrects it. Older than that we wait for the network
//     rather than resolve "which studio" against last week's map.
//   • position — NOT gated here. It carries its own timestamp and pickPosition
//     applies the real 5-minute staleness gate at the moment of use, which is
//     the only place that can judge it against the clock that matters.
//   • verdict — 30 min. It is the ONLY thing that paints studio controls
//     before detection lands, so it must expire fast: a phone that was at
//     Stillorgan this morning must not offer Stillorgan's tiles this
//     afternoon. It never claims 'detected' (the pill renders grey/detecting),
//     and the tiles' destinations re-resolve on arrival.

export const REGIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const VERDICT_MAX_AGE_MS = 30 * 60 * 1000
export const SHIFTS_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The budget for the SHIFTS value, in JSON string length.
 *
 * expo-secure-store's documented per-value limit is 2048 bytes (Android), and
 * a write over it fails SILENTLY — which is the trap: a 7-day week of the
 * busiest coach is ~290 slimmed bytes a row (two UUIDs + a template), so
 * ~2100 bytes for seven rows, and the people who most need Home to paint
 * instantly were the only ones getting nothing at all. Trimming to a budget
 * gives them the first few days instead of nothing.
 *
 * 1800 rather than 2048 for headroom: this counts UTF-16 code units, and a
 * studio or template name outside ASCII costs more BYTES than length.
 */
export const SHIFTS_CACHE_MAX_BYTES = 1800

/**
 * The shape parsePhysicalSnapshot returns when there is nothing usable.
 * Exported (and frozen) so the hook's own "nothing" value is this one and not
 * a second literal that could drift from it. Callers get a COPY from parse;
 * this object itself must never be mutated.
 */
export const EMPTY_SNAPSHOT = Object.freeze({ at: null, regions: null, position: null, verdict: null })

/** JSON.parse that never throws; passes an already-parsed object through. */
function safeParse(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** A plain object — not null, not an array (JSON.parse('[1]') is an object). */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** |now - at| <= maxAge, with both ends required to be real numbers. */
function withinAge(at, nowMs, maxAgeMs) {
  return Number.isFinite(at) && Number.isFinite(nowMs) && Math.abs(nowMs - at) <= maxAgeMs
}

/**
 * The four fields resolvePhysicalLocation actually reads, or null. Dropping
 * the rest is what keeps the snapshot inside SecureStore's ~2 KB value limit
 * — the geofence-config row carries names/notes/timestamps this never needs.
 */
function normaliseRegion(r) {
  if (!isPlainObject(r)) return null
  if (!r.location_id || typeof r.location_id !== 'string') return null
  if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude) || !Number.isFinite(r.radius_m)) return null
  return { location_id: r.location_id, latitude: r.latitude, longitude: r.longitude, radius_m: r.radius_m }
}

/** A list of well-formed regions, or null when none survive. */
function normaliseRegions(regions) {
  if (!Array.isArray(regions)) return null
  const out = regions.map(normaliseRegion).filter(Boolean)
  // An empty result is returned as null, not [], so the hook does not seed a
  // cache that would answer "no geofences anywhere" from disk — that reading
  // suppresses the enable-location nudge's promise, and it is exactly the
  // answer a corrupted blob would give. Absent, we simply wait for the network.
  return out.length > 0 ? out : null
}

/**
 * expo-location's shape, stripped to what pickPosition + the resolver read.
 * A position with no finite timestamp is dropped outright: pickPosition only
 * accepts a lastKnown that carries one, so a timestamp-less persisted fix
 * could never be used anyway.
 */
function normalisePosition(position) {
  if (!isPlainObject(position) || !isPlainObject(position.coords)) return null
  const { latitude, longitude } = position.coords
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (!Number.isFinite(position.timestamp)) return null
  return { coords: { latitude, longitude }, timestamp: position.timestamp }
}

function normaliseVerdict(verdict) {
  if (!isPlainObject(verdict)) return null
  if (!verdict.locationId || typeof verdict.locationId !== 'string') return null
  if (!Number.isFinite(verdict.at)) return null
  return { locationId: verdict.locationId, at: verdict.at }
}

/**
 * Validate a persisted physical-location snapshot and apply the freshness
 * rules above. Never throws; every field independently falls back to null, so
 * one corrupt member (stale regions, say) cannot cost the others.
 *
 * @param {string|object|null} raw  the SecureStore value (or a parsed object)
 * @param {number} nowMs
 * @returns {{ at: number|null, regions: Array|null, position: object|null, verdict: {locationId: string, at: number}|null }}
 */
export function parsePhysicalSnapshot(raw, nowMs) {
  if (!Number.isFinite(nowMs)) return { ...EMPTY_SNAPSHOT }
  const parsed = safeParse(raw)
  if (!isPlainObject(parsed)) return { ...EMPTY_SNAPSHOT }

  // `at` is when the REGIONS were obtained (see buildPhysicalSnapshot) — it
  // gates nothing else here, since the position and the verdict each carry
  // their own timestamp. An unstamped snapshot is one we cannot age at all.
  const at = Number.isFinite(parsed.at) ? parsed.at : null
  const regions = withinAge(at, nowMs, REGIONS_MAX_AGE_MS) ? normaliseRegions(parsed.regions) : null
  // The position is kept raw (well, normalised) at any age: pickPosition owns
  // the staleness decision, using the position's OWN timestamp.
  const position = normalisePosition(parsed.position)
  // The verdict is aged on its own `at`, not the snapshot's: a snapshot
  // rewritten by a later resolve does not make an older verdict any newer.
  const verdict = normaliseVerdict(parsed.verdict)
  return {
    at,
    regions,
    position,
    verdict: verdict && withinAge(verdict.at, nowMs, VERDICT_MAX_AGE_MS) ? verdict : null,
  }
}

/**
 * The verdict a resolve result earns IN MEMORY: at_studio stamps one, every
 * other status earns null. This is what the hook shows — the live answer, and
 * "I cannot tell where you are" is not something to paint studio tiles from.
 *
 * The PERSISTED verdict follows a different rule (nextPersistedVerdict): the
 * two are deliberately not the same question.
 */
export function verdictFromResult(result, nowMs) {
  const id = result?.status === 'at_studio' ? result?.location?.id : null
  if (!id || typeof id !== 'string' || !Number.isFinite(nowMs)) return null
  return { locationId: id, at: nowMs }
}

/**
 * What a resolve does to the STORED verdict — a three-way decision, not the
 * two-way one above:
 *
 *   at_studio → write it. We know where we are.
 *   offsite   → CLEAR it. A confirmed offsite is real evidence that the
 *               optimistic paint would be wrong, and leaving the verdict on
 *               disk would resurrect it on the next launch.
 *   anything else (unknown/loading/absent) → LEAVE IT AS IT WAS.
 *
 * That last line is the one worth stating: 'unknown' means "could not tell"
 * — no permission, no regions, no fix, offline — and it is not evidence that
 * the phone has moved. Treating it as a clear meant that one offline launch,
 * or one GPS timeout in a basement gym, threw away the NEXT launch's head
 * start for nothing. The stored verdict expires on its own 30-minute clock
 * (parsePhysicalSnapshot), which is the bound that actually protects it.
 */
export function nextPersistedVerdict({ result, previousVerdict, nowMs }) {
  if (result?.status === 'at_studio') return verdictFromResult(result, nowMs)
  if (result?.status === 'offsite') return null
  return normaliseVerdict(previousVerdict)
}

/**
 * The snapshot to persist after a resolve.
 *
 * `regionsAt` is WHEN THE REGIONS WERE OBTAINED, not when this snapshot is
 * written — the caller passes its region cache's own stamp. Defaulting it to
 * `nowMs` would re-stamp week-old regions as fresh on every launch, so an
 * offline device (which re-persists what it just read from disk) would keep
 * a stale map of the studios alive for ever instead of ageing it out at 24h.
 *
 * `previous` is what is currently on disk ({ verdict, position }), so an
 * inconclusive resolve can carry it forward instead of erasing it. The
 * position follows the same principle as the verdict, one rung simpler:
 * NEVER overwrite a fix with nothing. A resolve that produced no position
 * produced no information about where the phone is, and the stored fix is
 * still gated by pickPosition's 5-minute rule wherever it is used.
 */
export function buildPhysicalSnapshot({ regions, regionsAt, position, result, previous, nowMs }) {
  return {
    at: Number.isFinite(regionsAt) ? regionsAt : nowMs,
    regions: Array.isArray(regions) ? regions.map(normaliseRegion).filter(Boolean) : [],
    position: normalisePosition(position) || normalisePosition(previous?.position),
    verdict: nextPersistedVerdict({ result, previousVerdict: previous?.verdict, nowMs }),
  }
}

/**
 * The verdict, if it is still inside the 30-minute window — else null. The
 * hook re-applies this at read time as well as at parse time: a verdict set
 * by a live resolve early in a long session must expire the same way a
 * persisted one does, or a phone left open at 09:00 paints Stillorgan's tiles
 * at 13:00.
 */
export function freshVerdict(verdict, nowMs) {
  const v = normaliseVerdict(verdict)
  return v && withinAge(v.at, nowMs, VERDICT_MAX_AGE_MS) ? v : null
}

/**
 * The shift row reduced to the fields Home renders — shiftTimeLabel's
 * override → template resolution, the template name, and the location chip.
 * `profiles`, `notes`, the full `shift_templates (*)` row and the rest are
 * dropped: SecureStore's per-value limit is ~2 KB and a week of raw rows
 * blows it (a failed write is silent, so smaller is the whole game).
 * Absent branches are OMITTED rather than written as null — same bytes
 * argument, and `undefined` members do not survive JSON anyway.
 */
export function slimShiftsForCache(shifts) {
  if (!Array.isArray(shifts)) return []
  const out = []
  for (const s of shifts) {
    if (!isPlainObject(s) || typeof s.shift_date !== 'string' || !s.shift_date) continue
    const row = { id: s.id, shift_date: s.shift_date }
    if (s.start_time_override) row.start_time_override = s.start_time_override
    if (s.end_time_override) row.end_time_override = s.end_time_override
    if (s.location_id) row.location_id = s.location_id
    if (isPlainObject(s.locations)) row.locations = { id: s.locations.id, name: s.locations.name }
    if (isPlainObject(s.shift_templates)) {
      row.shift_templates = {
        name: s.shift_templates.name,
        start_time: s.shift_templates.start_time,
        end_time: s.shift_templates.end_time,
      }
    }
    if (row.id === undefined) delete row.id
    out.push(row)
  }
  return out
}

/**
 * The shifts blob to persist, stamped with WHOSE it is and when, sorted by
 * date and TRIMMED to SHIFTS_CACHE_MAX_BYTES.
 *
 * The trim is by budget rather than by a fixed row count because the row size
 * is not fixed (a `locations` embed would widen it by ~80 bytes), and the
 * failure it prevents is silent: SecureStore drops an oversize value without
 * an error, so a busy coach's cache simply never existed. Rows are added
 * soonest-date-first, so what survives is the part of the week the user is
 * about to look at.
 */
export function buildShiftsSnapshot({ profileId, shifts, nowMs }) {
  const slim = slimShiftsForCache(shifts)
    // Ascending by date. The API already sorts this way; doing it here is
    // what makes "trim the tail" mean "drop the furthest-out days".
    .sort((a, b) => (a.shift_date < b.shift_date ? -1 : a.shift_date > b.shift_date ? 1 : 0))
  const snapshot = { profileId: profileId || null, at: nowMs, shifts: [] }
  for (const row of slim) {
    snapshot.shifts.push(row)
    if (JSON.stringify(snapshot).length > SHIFTS_CACHE_MAX_BYTES) {
      snapshot.shifts.pop()
      break
    }
  }
  return snapshot
}

/**
 * The cached shifts for `profileId`, or null when there is nothing usable.
 *
 * The profile id is checked HERE as well as being part of the storage key:
 * Home's identity-swap reset (View-as, or a second staffer signing in on a
 * shared studio device) must never repaint the previous user's roster, and a
 * key alone is one typo away from that. `[]` is a real answer — a cached
 * "no shifts this week" — and is deliberately distinguishable from null.
 */
export function parseShiftsSnapshot(raw, { profileId, nowMs }) {
  if (!Number.isFinite(nowMs) || !profileId || typeof profileId !== 'string') return null
  const parsed = safeParse(raw)
  if (!isPlainObject(parsed)) return null
  if (parsed.profileId !== profileId) return null
  if (!withinAge(parsed.at, nowMs, SHIFTS_MAX_AGE_MS)) return null
  if (!Array.isArray(parsed.shifts)) return null
  // Re-slim on the way out: the shape on disk was written by an older build
  // whose slimmer may have kept more (or less) than this one does.
  return slimShiftsForCache(parsed.shifts)
}
