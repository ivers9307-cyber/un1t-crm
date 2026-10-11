// ETSLUG.1 — event_types.slug is globally UNIQUE (mig 002) and is the public
// /book/[slug] address, but it was derived from the name alone: a second
// studio (or the same studio re-creating a deactivated name) got a raw
// duplicate-key error. pickFreeSlug keeps the plain slug when it is free,
// else appends the studio's slug, else counts.

import { describe, it, expect } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { pickFreeSlug, resolveEventTypeSlug, slugTaken, isSlugConflict, RESERVED_EVENT_TYPE_SLUGS, isReservedEventTypeSlug } from './event-type-slug.js'

describe('pickFreeSlug', () => {
  it('keeps the plain slug when nobody holds it', () => {
    expect(pickFreeSlug('free-consultation', new Set(), 'un1t-hatch-street')).toBe('free-consultation')
  })

  it('appends the studio slug when the plain one is taken', () => {
    expect(pickFreeSlug('free-consultation', new Set(['free-consultation']), 'un1t-hatch-street'))
      .toBe('free-consultation-un1t-hatch-street')
  })

  it('counts when the studio-suffixed one is taken too', () => {
    const taken = new Set(['free-consultation', 'free-consultation-un1t-hatch-street', 'free-consultation-2'])
    expect(pickFreeSlug('free-consultation', taken, 'un1t-hatch-street')).toBe('free-consultation-3')
  })

  it('skips a long studio slug (host locations are host-<uuid>) and counts instead', () => {
    const host = 'host-6db1ad24-7982-4e40-91ea-7400616e872a'
    expect(pickFreeSlug('intro', new Set(['intro']), host)).toBe('intro-2')
  })

  it('does not double the studio slug when the name already ends with it', () => {
    expect(pickFreeSlug('trial-un1t-hatch-street', new Set(['trial-un1t-hatch-street']), 'un1t-hatch-street'))
      .toBe('trial-un1t-hatch-street-2')
  })

  it('a name with no letters or digits still gets an address', () => {
    expect(pickFreeSlug('', new Set(), null)).toBe('booking')
  })
})

describe('resolveEventTypeSlug', () => {
  const tables = () => ({
    locations: [{ id: 'loc-h', slug: 'un1t-hatch-street' }, { id: 'loc-s', slug: 'un1t-stillorgan' }],
    event_types: [
      { id: 'e1', slug: 'free-consultation', location_id: 'loc-s', active: false },
      { id: 'e2', slug: 'consultation', location_id: 'loc-s', active: true },
    ],
  })

  it('a second studio naming "Free Consultation" gets its own address, not an error', async () => {
    const db = makeFakeDb(tables())
    expect(await resolveEventTypeSlug(db, { name: 'Free Consultation', locationId: 'loc-h' }))
      .toEqual({ slug: 'free-consultation-un1t-hatch-street' })
  })

  it('an inactive booking type still holds its address (old links must not be re-pointed)', async () => {
    const db = makeFakeDb(tables())
    const { slug } = await resolveEventTypeSlug(db, { name: 'free consultation', locationId: 'loc-s' })
    expect(slug).toBe('free-consultation-un1t-stillorgan')
  })

  it('the row being renamed does not collide with itself', async () => {
    const db = makeFakeDb(tables())
    expect(await resolveEventTypeSlug(db, { name: 'Consultation', locationId: 'loc-s', excludeId: 'e2' }))
      .toEqual({ slug: 'consultation' })
  })

  it('a failed read is an error, never a guess', async () => {
    const failing = makeFakeDb(tables())
    const db = {
      from: (t) => {
        if (t !== 'event_types') return failing.from(t)
        const b = { select: () => b, in: () => b, then: (r) => r({ data: null, error: { message: 'boom' } }) }
        return b
      },
    }
    expect(await resolveEventTypeSlug(db, { name: 'X', locationId: 'loc-h' })).toEqual({ error: 'boom' })
  })
})

describe('slugTaken', () => {
  it('true for another row, false for the row itself or a free slug', async () => {
    const db = makeFakeDb({ event_types: [{ id: 'e1', slug: 'yoga' }] })
    expect(await slugTaken(db, 'yoga')).toEqual({ taken: true })
    expect(await slugTaken(db, 'yoga', 'e1')).toEqual({ taken: false })
    expect(await slugTaken(db, 'pilates')).toEqual({ taken: false })
  })
})

// BOOKINGSELF.1 — /book/manage/<token> is a static route that beats [slug].
describe('reserved slugs', () => {
  it('pickFreeSlug never picks "manage", even when nothing holds it', () => {
    expect(RESERVED_EVENT_TYPE_SLUGS.has('manage')).toBe(true)
    expect(pickFreeSlug('manage', new Set(), 'un1t-stillorgan')).toBe('manage-un1t-stillorgan')
    expect(pickFreeSlug('manage', new Set(), null)).toBe('manage-2')
  })

  it('a type named "Manage" resolves to a free, unreserved slug', async () => {
    const db = makeFakeDb({ locations: [{ id: 'loc-s', slug: 'un1t-stillorgan' }], event_types: [] })
    expect(await resolveEventTypeSlug(db, { name: 'Manage', locationId: 'loc-s' })).toEqual({ slug: 'manage-un1t-stillorgan' })
  })

  it('an explicit "manage" (any case) reads as taken, so the routes answer the usual 409', async () => {
    const db = makeFakeDb({ event_types: [] })
    expect(await slugTaken(db, 'manage')).toEqual({ taken: true })
    expect(isReservedEventTypeSlug('Manage')).toBe(true)
    expect(isReservedEventTypeSlug('manage-me')).toBe(false)
  })
})

describe('isSlugConflict', () => {
  it('matches only a unique violation on the slug', () => {
    expect(isSlugConflict({ code: '23505', message: 'duplicate key value violates unique constraint "event_types_slug_key"' })).toBe(true)
    expect(isSlugConflict({ code: '23505', message: 'duplicate key value violates unique constraint "other_key"' })).toBe(false)
    expect(isSlugConflict({ code: '22P02', message: 'slug' })).toBe(false)
    expect(isSlugConflict(null)).toBe(false)
  })
})
