// event-duplicate — HOSTSERIES.1: a DRAFT copy of an event on a new date.
//
// Copies every operator column (DUPLICATE_COLUMNS) and every wave (same
// times, labels, capacities, order); never registrations, promo codes,
// waitlist rows, moves or stats. The copy's registration window moves by the
// same number of days as its date, so "closes the day before" stays true.
// The hero FILE is copied into the new event's own folder (the hero route
// deletes stale files in a folder on re-upload, so sharing the source's URL
// would lose the copy's image later); a failed copy leaves the copy without
// a hero and is logged, never a failed duplicate. Used by the host and staff
// duplicate routes and by createSeriesFromEvent (event-series.js).
//
// Every write destructures `error`.

import { eventSlug, uniqueEventSlug } from './event-slug'
import { logError, logWarn } from './log'

export const DUPLICATE_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  LOAD_FAILED: 'load_failed',
  WRITE_FAILED: 'write_failed',
})

// Every column a copy inherits. Each name exists on race_events in
// supabase/migrations (check:select-columns resolves them); id, slug, status,
// active, series_id and the review stamps are decided by the copy itself.
export const DUPLICATE_COLUMNS = Object.freeze([
  'kind', 'name', 'description', 'location_id', 'host_id',
  'allowed_team_sizes', 'capacity_mode',
  'member_pricing_enabled', 'members_only', 'member_fee_cents', 'non_member_fee_cents', 'payment_currency',
  'registration_opens_at', 'registration_closes_at',
  'hero_image_url', 'accent_hex', 'venue_name', 'venue_address',
  'confirmation_email_subject', 'confirmation_email_intro', 'confirmation_email_template_id',
  'reminder_email_subject', 'reminder_email_intro',
  'rating_email_subject', 'rating_email_intro',
  'moved_email_subject', 'moved_email_intro',
  'waitlist_email_subject', 'waitlist_email_intro',
  'gap_email_subject', 'gap_email_intro',
  'entry_policy', 'find_team', 'charity_enabled', 'charity', 'tv_logos', 'pricing_tiers', 'registration_questions', 'duration_minutes',
  'shared', 'staff_required', 'sending_location_id', 'create_in_glofox',
  'race_date',
])

const SELECT = `id, ${DUPLICATE_COLUMNS.join(', ')}, race_waves ( start_time, label, capacity, display_order )`

const DAY_MS = 86_400_000

/** Whole days from `fromDate` to `toDate` (YYYY-MM-DD both). */
export function dayDelta(fromDate, toDate) {
  const ms = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, dd) }
  return Math.round((ms(toDate) - ms(fromDate)) / DAY_MS)
}

/** An ISO instant moved by whole days (null stays null). A DST change inside
 * the span moves the wall clock by an hour; accepted for a window. */
export function shiftByDays(iso, days) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t + days * DAY_MS).toISOString()
}

const HERO_RE = /\/race-hero\/([0-9a-f-]{36})\/hero\.([a-z0-9]+)(?:\?|$)/i

/**
 * @param {object} db  service-role client (db.storage for the hero copy)
 * @param {{ sourceId: string, raceDate: string, seriesId?: string|null, name?: string|null }} args
 * @returns {Promise<{ ok: true, event: { id: string, slug: string } } | { ok: false, error: string, message: string }>}
 */
export async function duplicateEvent(db, { sourceId, raceDate, seriesId = null, name = null }) {
  const { data: source, error: readErr } = await db.from('race_events').select(SELECT).eq('id', sourceId).maybeSingle()
  if (readErr) {
    logError('event-duplicate', 'source read failed', { err: readErr, sourceId })
    return { ok: false, error: DUPLICATE_ERRORS.LOAD_FAILED, message: 'The event could not be read. Try again.' }
  }
  if (!source) return { ok: false, error: DUPLICATE_ERRORS.NOT_FOUND, message: 'That event no longer exists.' }

  const { id: _id, race_waves: sourceWaves, race_date: sourceDate, ...fields } = source
  const waves = (Array.isArray(sourceWaves) ? [...sourceWaves] : []).sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
  const delta = sourceDate ? dayDelta(sourceDate, raceDate) : 0
  const heroMatch = HERO_RE.exec(String(fields.hero_image_url || ''))
  const heroMatchesSource = heroMatch && heroMatch[1].toLowerCase() === String(sourceId).toLowerCase()

  const slug = await uniqueEventSlug(db, eventSlug({
    place: fields.venue_name,
    date: raceDate,
    times: waves.map((w) => w.start_time),
    name: name ?? fields.name,
  }))

  const row = {
    ...fields,
    name: name ?? fields.name,
    race_date: raceDate,
    registration_opens_at: shiftByDays(fields.registration_opens_at, delta),
    registration_closes_at: shiftByDays(fields.registration_closes_at, delta),
    // A race-hero object is copied below, after the id exists; anything else
    // (a pasted URL) is shared as-is.
    hero_image_url: heroMatchesSource ? null : (fields.hero_image_url ?? null),
    slug,
    status: 'draft',
    active: true,
    series_id: seriesId,
    submitted_at: null,
    reviewed_at: null,
    rejected_reason: null,
  }
  const { data: created, error: insErr } = await db.from('race_events').insert(row).select('id, slug').single()
  if (insErr || !created) {
    logError('event-duplicate', 'event insert failed', { err: insErr, sourceId })
    return { ok: false, error: DUPLICATE_ERRORS.WRITE_FAILED, message: 'The copy could not be saved. Nothing changed. Try again.' }
  }

  if (waves.length > 0) {
    const { error: waveErr } = await db.from('race_waves').insert(waves.map((w) => ({
      race_event_id: created.id, start_time: w.start_time, label: w.label ?? null, capacity: w.capacity ?? null, display_order: w.display_order ?? 0,
    })))
    if (waveErr) {
      logError('event-duplicate', 'wave insert failed; copy removed', { err: waveErr, sourceId, newId: created.id })
      const { error: delErr } = await db.from('race_events').delete().eq('id', created.id)
      if (delErr) logError('event-duplicate', 'rollback of the copy failed', { err: delErr, newId: created.id })
      return { ok: false, error: DUPLICATE_ERRORS.WRITE_FAILED, message: 'The copy could not be saved. Nothing changed. Try again.' }
    }
  }

  if (heroMatchesSource) {
    const ext = heroMatch[2]
    const from = `race-hero/${sourceId}/hero.${ext}`
    const to = `race-hero/${created.id}/hero.${ext}`
    try {
      // Direct calls on the bucket, never through a handle: the branding bucket
      // guard (tests/branding-bucket-guard.test.js, LIB_WRITERS) reads them.
      const { error: copyErr } = await db.storage.from('branding').copy(from, to)
      if (copyErr) {
        logWarn('event-duplicate', 'hero copy failed; the copy has no hero', { err: copyErr, sourceId, newId: created.id })
      } else {
        const { data: urlData } = db.storage.from('branding').getPublicUrl(to)
        const url = urlData?.publicUrl ? `${urlData.publicUrl}?t=${Date.now()}` : null
        if (url) {
          const { error: heroErr } = await db.from('race_events').update({ hero_image_url: url }).eq('id', created.id)
          if (heroErr) logWarn('event-duplicate', 'hero url write failed; the copy has no hero', { err: heroErr, newId: created.id })
        }
      }
    } catch (err) {
      logWarn('event-duplicate', 'hero copy threw; the copy has no hero', { err, sourceId, newId: created.id })
    }
  }

  return { ok: true, event: { id: created.id, slug: created.slug } }
}
