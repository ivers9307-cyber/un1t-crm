import { describe, it, expect } from 'vitest'
import { placeToken, dateToken, timeToken, eventSlug, shouldRederiveSlug, uniqueEventSlug } from './event-slug'

describe('placeToken', () => {
  it('strips UN1T and bracketed text and keeps the first word, lowercase', () => {
    expect(placeToken('UN1T Hatch Street (Harcourt Luas stop)')).toBe('hatch')
    expect(placeToken('UN1T STILLORGAN')).toBe('stillorgan')
    expect(placeToken('UN1T Stillorgan')).toBe('stillorgan')
    expect(placeToken('SAINT Studios')).toBe('saint')
    expect(placeToken('UN1T HATCH')).toBe('hatch')
  })
  it('skips a leading "the"', () => {
    expect(placeToken('The Marker Hotel')).toBe('marker')
  })
  it('drops non-ASCII and falls back to "event"', () => {
    expect(placeToken('Café Bleu')).toBe('caf')
    expect(placeToken('')).toBe('event')
    expect(placeToken(null)).toBe('event')
    expect(placeToken('UN1T ()')).toBe('event')
  })
})

describe('dateToken', () => {
  it('is lowercase 3-letter month plus unpadded day, parsed as a plain date', () => {
    expect(dateToken('2026-11-22')).toBe('nov22')
    expect(dateToken('2026-12-05')).toBe('dec5')
    expect(dateToken('2026-10-01')).toBe('oct1')
  })
  it('returns null for a missing or malformed date', () => {
    expect(dateToken(null)).toBeNull()
    expect(dateToken('22/11/2026')).toBeNull()
    expect(dateToken('2026-13-01')).toBeNull()
  })
})

describe('timeToken', () => {
  it('accepts HH:MM and HH:MM:SS', () => {
    expect(timeToken('11:00')).toBe('1100')
    expect(timeToken('18:35:00')).toBe('1835')
    expect(timeToken('09:05')).toBe('0905')
  })
  it('returns null for missing or malformed times', () => {
    expect(timeToken(null)).toBeNull()
    expect(timeToken('11am')).toBeNull()
    expect(timeToken('25:00')).toBeNull()
  })
})

describe('eventSlug', () => {
  it('joins place-date-time', () => {
    expect(eventSlug({ place: 'UN1T Hatch Street (Harcourt Luas stop)', date: '2026-10-18', time: '11:00:00' })).toBe('hatch-oct18-1100')
    expect(eventSlug({ place: 'UN1T STILLORGAN', date: '2026-11-22', time: '13:45' })).toBe('stillorgan-nov22-1345')
  })
  it('uses the EARLIEST of several times', () => {
    expect(eventSlug({ place: 'UN1T Stillorgan', date: '2026-10-17', times: ['12:00:00', '10:30:00', '11:15:00'] })).toBe('stillorgan-oct17-1030')
  })
  it('falls back to the name slug when the date or time is missing (lead-gen forms)', () => {
    expect(eventSlug({ place: 'UN1T Hatch Street', date: null, time: null, name: 'UN1T Hatch Street' })).toBe('un1t-hatch-street')
    expect(eventSlug({ place: 'UN1T Hatch Street', date: '2026-10-18', times: [], name: 'Open Day!' })).toBe('open-day')
  })
  it('falls back to "event" when nothing usable exists', () => {
    expect(eventSlug({ place: '', date: null, time: null, name: '' })).toBe('event')
  })
  it('always satisfies the route slug rule', () => {
    const rule = /^[a-z0-9]+(-[a-z0-9]+)*$/
    for (const s of [
      eventSlug({ place: 'UN1T Hatch Street (Harcourt Luas stop)', date: '2026-10-18', time: '11:00:00' }),
      eventSlug({ place: 'Café Bleu', date: '2026-01-01', time: '00:00' }),
      eventSlug({ place: '', date: null, time: null, name: '  Hello   World ' }),
    ]) expect(s).toMatch(rule)
  })
})

describe('shouldRederiveSlug', () => {
  it('re-derives while unpublished and freezes once published', () => {
    expect(shouldRederiveSlug('draft')).toBe(true)
    expect(shouldRederiveSlug('rejected')).toBe(true)
    expect(shouldRederiveSlug('pending_review')).toBe(true)
    expect(shouldRederiveSlug('published')).toBe(false)
    expect(shouldRederiveSlug(undefined)).toBe(false)
  })
})

describe('uniqueEventSlug', () => {
  function dbWithTaken(taken) {
    return {
      from: () => ({
        select: () => {
          const q = { _slug: null, _neq: null }
          q.eq = (col, v) => { q._slug = v; return q }
          q.neq = (col, v) => { q._neq = v; return q }
          q.maybeSingle = async () => {
            const hit = taken.find((t) => t.slug === q._slug && t.id !== q._neq)
            return { data: hit ? { id: hit.id } : null, error: null }
          }
          return q
        },
      }),
    }
  }
  it('returns the base when free', async () => {
    expect(await uniqueEventSlug(dbWithTaken([]), 'hatch-oct18-1100')).toBe('hatch-oct18-1100')
  })
  it('suffixes -2, -3 until free', async () => {
    const db = dbWithTaken([{ id: 'a', slug: 'hatch-oct18-1100' }, { id: 'b', slug: 'hatch-oct18-1100-2' }])
    expect(await uniqueEventSlug(db, 'hatch-oct18-1100')).toBe('hatch-oct18-1100-3')
  })
  it('ignores the event being edited', async () => {
    const db = dbWithTaken([{ id: 'me', slug: 'hatch-oct18-1100' }])
    expect(await uniqueEventSlug(db, 'hatch-oct18-1100', { excludeId: 'me' })).toBe('hatch-oct18-1100')
  })
  it('treats a read error as taken (never hands back a slug it could not check)', async () => {
    let n = 0
    const db = { from: () => ({ select: () => { const q = {}; q.eq = () => q; q.neq = () => q; q.maybeSingle = async () => (n++ === 0 ? { data: null, error: { message: 'boom' } } : { data: null, error: null }); return q } }) }
    expect(await uniqueEventSlug(db, 'x')).toBe('x-2')
  })
})
