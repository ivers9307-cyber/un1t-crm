// EVENT-SLUG.1 — an event's public URL reads as place, date and time:
//   /event/hatch-oct18-1100
//
// Derived at creation on both create paths (staff `POST /api/events`,
// host `POST /api/host/events`) and re-derived on host edits until the
// event is published, after which it freezes (the link may be out).
// Pure except `uniqueEventSlug`, which takes the db for the clash probe.
//
// Slugs are globally unique (mig 451) and matched exactly, case-sensitive,
// by every public resolver (/event/[slug], /api/public/events/[slug]/*,
// /book/[slug], /embed/event/[slug]), so every token here is lowercase
// ASCII and the result always satisfies the route rule
// /^[a-z0-9]+(-[a-z0-9]+)*$/ — no validation or lookup change needed.

import { toSlug } from '@/lib/slug'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * "UN1T Hatch Street (Harcourt Luas stop)" -> "hatch"
 * "UN1T STILLORGAN" -> "stillorgan", "SAINT Studios" -> "saint".
 * Strips the brand word and any bracketed text, skips a leading "the",
 * keeps the first remaining word. Nothing usable -> "event".
 */
export function placeToken(name) {
  const words = String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bun1t\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && w !== 'the')
  return words[0] || 'event'
}

/** "2026-11-22" -> "nov22"; "2026-12-05" -> "dec5". Plain-date parse, no timezone. */
export function dateToken(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''))
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${MONTHS[month - 1]}${day}`
}

/** "11:00" | "18:35:00" -> "1100" | "1835" (race_waves.start_time is a TIME, so HH:MM:SS arrives). */
export function timeToken(time) {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(time || ''))
  if (!m) return null
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1]}${m[2]}`
}

/**
 * @param {{ place?: string, date?: string|null, time?: string|null, times?: string[], name?: string }} args
 *   `time` is a single start time; `times` is a list and the EARLIEST wins.
 *   When the date or every time is missing (a lead-gen form) the slug falls
 *   back to the name, exactly as both create paths did before EVENT-SLUG.1.
 */
export function eventSlug({ place, date, time, times, name } = {}) {
  const candidates = (Array.isArray(times) ? times : [time]).map(timeToken).filter(Boolean).sort()
  const d = dateToken(date)
  const t = candidates[0] || null
  if (d && t) return `${placeToken(place)}-${d}-${t}`
  return toSlug(name) || 'event'
}

/** A host event's slug follows its venue/date/time until it is published. */
export function shouldRederiveSlug(status) {
  return status === 'draft' || status === 'rejected' || status === 'pending_review'
}

/**
 * First free slug among base, base-2, base-3… Probes `race_events` globally
 * (mig 451 makes slugs unique across locations). `excludeId` lets an edit
 * keep its own slug. A failed probe counts as taken: this never hands back
 * a slug it could not check. The unique index remains the backstop.
 */
export async function uniqueEventSlug(db, base, { excludeId = null } = {}) {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    let q = db.from('race_events').select('id').eq('slug', candidate)
    if (excludeId) q = q.neq('id', excludeId)
    // .maybeSingle(): 0 rows is the answer we want; slug is unique (mig 451).
    const { data, error } = await q.maybeSingle()
    if (!error && !data) return candidate
  }
  return `${base}-${Date.now()}`
}
