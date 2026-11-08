// event-series — HOSTSERIES.1: a group of event dates sharing one public page
// (event_series, mig 817; race_events.series_id → /event/series/<slug>).
//
// Ownership: a series belongs to its host (host_id) or, with host_id NULL, to
// staff at its studio. A host route takes a series id from the request body,
// so it asks hostOwnsSeries before any write: another host's series id must
// never attach an event to that host's page (the review that caught it:
// IDOR, unvalidated foreign key from the body).
//
// Making a series: the source event is stamped, then duplicateEvent runs
// once per date with the series id. Nothing is rolled back when a later copy
// fails: the host sees the drafts that exist and the message says how many.
//
// Every write destructures `error`.

import { toSlug } from './slug'
import { duplicateEvent } from './event-duplicate'
import { getLocationZone, DEFAULT_TZ } from './location-time'
import { todayIsoIn } from '@shared/events'
import { logError, logWarn } from './log'
import { isEventSoldOut, toBrowseCard } from './public-events'

export const SERIES_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  LOAD_FAILED: 'load_failed',
  WRITE_FAILED: 'write_failed',
  ALREADY_IN_SERIES: 'already_in_series',
  INVALID_DATES: 'invalid_dates',
  INVALID_SERIES: 'invalid_series',
})

export const MAX_SERIES_DATES = 24
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * May `hostId` attach an event to `seriesId`? A failed read is load_failed,
 * never "yes".
 * @returns {Promise<{ ok: true } | { ok: false, error: 'invalid_series' | 'load_failed' }>}
 */
export async function hostOwnsSeries(db, { seriesId, hostId }) {
  if (!seriesId) return { ok: true }
  const { data, error } = await db.from('event_series').select('id, host_id').eq('id', seriesId).maybeSingle()
  if (error) {
    logError('event-series', 'series read failed', { err: error, seriesId })
    return { ok: false, error: SERIES_ERRORS.LOAD_FAILED }
  }
  if (!data || data.host_id !== hostId) return { ok: false, error: SERIES_ERRORS.INVALID_SERIES }
  return { ok: true }
}

/** "Monthly Mobility Workshop!" → "monthly-mobility-workshop"; nothing usable → "series". */
export function seriesSlugBase(name) {
  return toSlug(name) || 'series'
}

/**
 * First free slug among base, base-2, base-3… on event_series.slug. A failed
 * probe falls back to a timestamped slug (this never says "free" about a slug
 * it could not check); the unique index is the backstop.
 */
export async function uniqueSeriesSlug(db, base) {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    // .maybeSingle(): slug is unique, so 0-or-1 rows and 0 is the answer we want.
    const { data, error } = await db.from('event_series').select('id').eq('slug', candidate).maybeSingle()
    if (error) {
      logWarn('event-series', 'slug probe failed; falling back to a timestamped slug', { err: error, base })
      return `${base}-${Date.now()}`
    }
    if (!data) return candidate
  }
  return `${base}-${Date.now()}`
}

function validDates(dates, sourceDate) {
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > MAX_SERIES_DATES) return false
  const seen = new Set()
  for (const d of dates) {
    if (!DATE_RE.test(String(d))) return false
    if (d === sourceDate) return false
    if (seen.has(d)) return false
    seen.add(d)
  }
  return true
}

/**
 * Make `sourceId` the first date of a new series and copy it onto `dates`.
 * @returns {Promise<{ ok: true, series: { id, slug }, created: Array<{ id, slug, race_date }> }
 *         | { ok: false, error: string, message: string, created?: Array }>}
 */
export async function createSeriesFromEvent(db, { sourceId, dates, name }) {
  const { data: source, error: readErr } = await db
    .from('race_events')
    .select('id, host_id, location_id, race_date, series_id')
    .eq('id', sourceId)
    .maybeSingle()
  if (readErr) {
    logError('event-series', 'source read failed', { err: readErr, sourceId })
    return { ok: false, error: SERIES_ERRORS.LOAD_FAILED, message: 'The event could not be read. Try again.' }
  }
  if (!source) return { ok: false, error: SERIES_ERRORS.NOT_FOUND, message: 'That event no longer exists.' }
  if (source.series_id) return { ok: false, error: SERIES_ERRORS.ALREADY_IN_SERIES, message: 'This event is already part of a series.' }
  if (!validDates(dates, source.race_date)) {
    return { ok: false, error: SERIES_ERRORS.INVALID_DATES, message: `Pick 1 to ${MAX_SERIES_DATES} other dates, each once, none the event's own date.` }
  }

  const slug = await uniqueSeriesSlug(db, seriesSlugBase(name))
  const { data: series, error: insErr } = await db
    .from('event_series')
    .insert({ host_id: source.host_id ?? null, location_id: source.location_id, name: String(name).trim(), slug })
    .select('id, slug')
    .single()
  if (insErr || !series) {
    logError('event-series', 'series insert failed', { err: insErr, sourceId })
    return { ok: false, error: SERIES_ERRORS.WRITE_FAILED, message: 'The series could not be created. Nothing changed. Try again.' }
  }

  const { error: stampErr } = await db.from('race_events').update({ series_id: series.id }).eq('id', source.id)
  if (stampErr) {
    logError('event-series', 'source stamp failed', { err: stampErr, sourceId, seriesId: series.id })
    return { ok: false, error: SERIES_ERRORS.WRITE_FAILED, message: 'The series was created but the event could not be added to it. Try again.', created: [] }
  }

  const created = []
  for (const raceDate of dates) {
    const copy = await duplicateEvent(db, { sourceId: source.id, raceDate, seriesId: series.id })
    if (!copy.ok) {
      logError('event-series', 'a date copy failed; the series keeps the copies made so far', { err: copy.error, sourceId, seriesId: series.id, raceDate })
      return {
        ok: false,
        error: SERIES_ERRORS.WRITE_FAILED,
        message: `${created.length} of ${dates.length} dates were created before one failed. The series exists; add the missing dates again.`,
        created,
      }
    }
    created.push({ ...copy.event, race_date: raceDate })
  }
  return { ok: true, series: { id: series.id, slug: series.slug }, created }
}

/**
 * Put an existing event of the host's into one of the host's series.
 * @returns {Promise<{ ok: true } | { ok: false, error: 'not_found' | 'load_failed' | 'write_failed' }>}
 */
export async function addEventToSeries(db, { eventId, seriesId, hostId }) {
  const owns = await hostOwnsSeries(db, { seriesId, hostId })
  if (!owns.ok) return { ok: false, error: owns.error === SERIES_ERRORS.LOAD_FAILED ? SERIES_ERRORS.LOAD_FAILED : SERIES_ERRORS.NOT_FOUND }
  const { data: event, error: readErr } = await db.from('race_events').select('id, host_id').eq('id', eventId).maybeSingle()
  if (readErr) return { ok: false, error: SERIES_ERRORS.LOAD_FAILED }
  if (!event || event.host_id !== hostId) return { ok: false, error: SERIES_ERRORS.NOT_FOUND }
  const { error } = await db.from('race_events').update({ series_id: seriesId }).eq('id', eventId)
  if (error) {
    logError('event-series', 'add to series failed', { err: error, eventId, seriesId })
    return { ok: false, error: SERIES_ERRORS.WRITE_FAILED }
  }
  return { ok: true }
}

// Public-safe SELECT for a series date: the same shape /h/[slug] uses, so
// toBrowseCard + isEventSoldOut read it. Embeds only for the sold-out boolean.
export const SERIES_DATE_COLS = 'id, slug, name, kind, race_date, start_time, venue_name, description, hero_image_url, accent_hex, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity, start_time ), registrations:race_registrations ( status, wave_id, looking_for_team, team:teams ( size ) )'

async function zoneFor(db, locationId) {
  try {
    return await getLocationZone(db, locationId || null)
  } catch (err) {
    logWarn('event-series', 'studio zone unreadable; the default zone stands', { err, locationId })
    return DEFAULT_TZ
  }
}

/**
 * The public series page's data: the series, its PUBLISHED upcoming dates in
 * date order, and the studio zone. null for an unknown slug.
 * @param {{ slug: string, today?: string|null }} args  today: YYYY-MM-DD; omitted → the studio's day
 */
export async function loadSeriesPage(db, { slug, today = null }) {
  const { data: series, error } = await db
    .from('event_series')
    .select('id, host_id, location_id, name, slug, headline, blurb')
    .eq('slug', slug)
    .maybeSingle()
  if (error) {
    logError('event-series', 'series page read failed', { err: error, slug })
    return null
  }
  if (!series) return null
  const zone = await zoneFor(db, series.location_id)
  const day = today || todayIsoIn(zone)
  const { data: rows, error: datesErr } = await db
    .from('race_events')
    .select(SERIES_DATE_COLS)
    .eq('series_id', series.id)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', day)
    .order('race_date', { ascending: true })
    .limit(200)
  if (datesErr) logError('event-series', 'series dates read failed; page shows no dates', { err: datesErr, seriesId: series.id })
  const dates = (rows || []).slice().sort((a, b) => String(a.race_date || '').localeCompare(String(b.race_date || '')))
  return { series, dates, zone }
}

/**
 * The host's series with how many PUBLISHED dates are still to come (today
 * or later, YYYY-MM-DD on the host's anchor clock).
 * @returns {Promise<Array<{ id, name, slug, headline, blurb, upcoming_count }>>}
 */
export async function listHostSeries(db, { hostId, today }) {
  const { data: series, error } = await db
    .from('event_series')
    .select('id, name, slug, headline, blurb')
    .eq('host_id', hostId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) {
    logError('event-series', 'host series read failed', { err: error, hostId })
    return []
  }
  if (!series || series.length === 0) return []
  const { data: events, error: evErr } = await db
    .from('race_events')
    .select('series_id, race_date, status, active')
    .eq('host_id', hostId)
    .in('series_id', series.map((s) => s.id))
    .limit(1000)
  if (evErr) logError('event-series', 'series dates read failed; counts show 0', { err: evErr, hostId })
  const counts = new Map()
  for (const e of events || []) {
    if (e.status !== 'published' || e.active !== true) continue
    if (!e.race_date || String(e.race_date).slice(0, 10) < today) continue
    counts.set(e.series_id, (counts.get(e.series_id) || 0) + 1)
  }
  return series.map((s) => ({ id: s.id, name: s.name, slug: s.slug, headline: s.headline ?? null, blurb: s.blurb ?? null, upcoming_count: counts.get(s.id) || 0 }))
}

// ─── The public page (/event/series/<slug>) ────────────────────────────────

/** Operator copy with defaults (customer-facing copy is operator-editable). */
export function seriesPageCopy(series) {
  const headline = String(series?.headline || '').trim()
  const blurb = String(series?.blurb || '').trim()
  return { headline: headline || String(series?.name || '').trim() || 'Upcoming dates', blurb: blurb || 'Pick a date' }
}

/**
 * The cards of a series page: PUBLISHED, active, upcoming dates in date
 * order, each a browse card (toBrowseCard) plus `href` to its own signup page
 * (null when registration has closed; a sold-out date still links, as on
 * /h/<slug>). Pure; the loader already filters, this re-applies the rule so a
 * caller can never show a draft.
 * @param {Array} dates  rows shaped by SERIES_DATE_COLS (+ status, active)
 * @param {{ now: number, zone: string, today: string }} args  today: YYYY-MM-DD on the studio clock
 */
export function seriesCards(dates, { now, zone, today }) {
  return (Array.isArray(dates) ? dates : [])
    .filter((e) => (e.status == null || e.status === 'published') && e.active !== false && e.race_date && String(e.race_date).slice(0, 10) >= today)
    .sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)))
    .map((e) => {
      const card = toBrowseCard(e, { soldOut: isEventSoldOut(e.waves, e.registrations, e.capacity_mode), now, zone })
      return { ...card, href: card.closed ? null : `/event/${e.slug}` }
    })
}
