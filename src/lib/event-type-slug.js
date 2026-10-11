// ETSLUG.1 — choosing an event type's public slug (the /book/[slug] address).
//
// event_types.slug is globally UNIQUE (mig 002) and the public booking routes
// resolve by slug alone, so the namespace is shared by every studio on the
// platform. Both event-type routes used to derive the slug from the name and
// insert it blind: a second studio naming a type "Free Consultation" (or the
// same studio re-creating a deactivated name, whose row still holds the slug
// so old links keep resolving) got the raw duplicate-key error. Now the plain
// slug is kept when it is free, else the studio's slug is appended, else a
// counter. An explicit slug (API-key callers) is never rewritten: a clash is
// a 409 the caller can act on.

import { eventTypeSlug } from './event-type-schema.js'

// BOOKINGSELF.1 — words a booking type may never take as its slug because a
// STATIC route under /book/ owns that address: /book/manage/<token> is the
// customer's own booking page, and Next resolves the static segment before
// [slug], so a type slugged 'manage' would be unreachable. pickFreeSlug skips
// them as if taken; slugTaken answers taken for them, so an explicit slug
// (API-key callers, the slug field) is the usual 409 SLUG_IN_USE.
export const RESERVED_EVENT_TYPE_SLUGS = Object.freeze(new Set(['manage']))

/** Is `slug` reserved for a static /book/ route? */
export const isReservedEventTypeSlug = (slug) => RESERVED_EVENT_TYPE_SLUGS.has(String(slug || '').toLowerCase())

// A studio slug longer than this is not worth reading in a link (host
// locations are `host-<uuid>`); count instead.
const MAX_STUDIO_SUFFIX = 24
const MAX_COUNTER = 20

/** Candidate slugs in preference order. */
function candidates(base, studioSlug) {
  const root = base || 'booking'
  const out = [root]
  if (studioSlug && studioSlug.length <= MAX_STUDIO_SUFFIX && !root.endsWith(`-${studioSlug}`) && root !== studioSlug) {
    out.push(`${root}-${studioSlug}`)
  }
  for (let n = 2; n <= MAX_COUNTER; n++) out.push(`${root}-${n}`)
  return out
}

/**
 * The first candidate not in `taken`. Past the counter it appends a random
 * tail rather than fail: twenty studios sharing one name is not a reason to
 * refuse a booking type.
 * @param {string} base — eventTypeSlug(name)
 * @param {Set<string>} taken — slugs held by OTHER rows
 * @param {string|null} studioSlug — locations.slug of the type's studio
 */
export function pickFreeSlug(base, taken, studioSlug) {
  const list = candidates(base, studioSlug)
  const free = list.find((s) => !taken.has(s) && !isReservedEventTypeSlug(s))
  return free ?? `${list[0]}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A free slug for `name` at `locationId`, ignoring the row `excludeId` (a
 * rename must not collide with itself). Returns `{ slug }` or `{ error }` —
 * a failed read is an error, never a guess that would surface as the raw
 * duplicate-key error this exists to prevent.
 */
export async function resolveEventTypeSlug(db, { name, locationId, excludeId = null }) {
  let studioSlug = null
  if (locationId) {
    const { data: loc, error: locErr } = await db.from('locations').select('slug').eq('id', locationId).maybeSingle()
    if (locErr) return { error: locErr.message }
    studioSlug = loc?.slug || null
  }
  const base = eventTypeSlug(name)
  const list = candidates(base, studioSlug)
  const { data, error } = await db.from('event_types').select('id, slug').in('slug', list)
  if (error) return { error: error.message }
  const taken = new Set((data || []).filter((r) => r.id !== excludeId).map((r) => r.slug))
  return { slug: pickFreeSlug(base, taken, studioSlug) }
}

/** Is `slug` held by a row other than `excludeId`? `{ taken }` or `{ error }`. */
export async function slugTaken(db, slug, excludeId = null) {
  if (isReservedEventTypeSlug(slug)) return { taken: true }
  const { data, error } = await db.from('event_types').select('id').eq('slug', slug)
  if (error) return { error: error.message }
  return { taken: (data || []).some((r) => r.id !== excludeId) }
}

/** A unique violation on the slug (the race between our read and the write). */
export function isSlugConflict(error) {
  return error?.code === '23505' && /slug/i.test(error.message || '')
}

export const SLUG_IN_USE = 'That booking link is already in use. Choose a different one.'
