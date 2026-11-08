// HOSTPAGE.2 — the extra sections of a host's public page (/h/<slug>) as
// data: about, photos, testimonials, the two show toggles, and the past
// events list. Pure; the list-page route validates writes with the two
// schemas, the public page re-validates on read and DROPS an invalid entry
// (a bad row must never blank the page). Nothing here imports a server
// module, so the editor can share the caps.

import { z } from 'zod'
import { eventDateLong } from '@/lib/event-day'

export const HOST_ABOUT_MAX = 2000
export const HOST_PHOTOS_MAX = 12
export const HOST_TESTIMONIALS_MAX = 6
export const HOST_PAST_EVENTS_MAX = 24

const PhotoSchema = z.object({
  url: z.string().trim().url().max(2000),
  caption: z.string().trim().max(120).optional().nullable(),
})
const TestimonialSchema = z.object({
  quote: z.string().trim().min(1).max(400),
  author: z.string().trim().max(80).optional().nullable(),
})
export const HostPhotosSchema = z.array(PhotoSchema).max(HOST_PHOTOS_MAX)
export const HostTestimonialsSchema = z.array(TestimonialSchema).max(HOST_TESTIMONIALS_MAX)

function validList(raw, schema, max) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    const r = schema.safeParse(item)
    if (r.success) out.push(r.data)
    if (out.length >= max) break
  }
  return out
}

/**
 * @param {object|null} host the event_hosts row (any subset of the five columns)
 * @returns {{ about: string, photos: {url:string, caption?:string|null}[], testimonials: {quote:string, author?:string|null}[], showPastEvents: boolean, showRatings: boolean }}
 */
export function hostPageExtras(host) {
  const h = host && typeof host === 'object' ? host : {}
  return {
    about: String(h.about_text ?? '').trim().slice(0, HOST_ABOUT_MAX),
    photos: validList(h.photos, PhotoSchema, HOST_PHOTOS_MAX).map((p) => ({ url: p.url, caption: p.caption ? p.caption : null })),
    testimonials: validList(h.testimonials, TestimonialSchema, HOST_TESTIMONIALS_MAX).map((t) => ({ quote: t.quote, author: t.author ? t.author : null })),
    showPastEvents: h.show_past_events !== false,
    showRatings: h.show_ratings !== false,
  }
}

/**
 * Past events for the collapsed archive: dates strictly before `today`
 * (ISO strings compare lexically), newest first, capped. No link: a past
 * event has nothing to sell.
 */
export function pastEventCards(rows, today, { max = HOST_PAST_EVENTS_MAX } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.race_date === 'string' && r.race_date < today)
    .sort((a, b) => b.race_date.localeCompare(a.race_date))
    .slice(0, max)
    .map((r) => ({ id: r.id, name: r.name, dateLabel: eventDateLong(r.race_date) }))
}
