import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { normaliseSlug, slugProblem, RESERVED_PAGE_SLUGS } from './page-slug.js'
import { appRouteSegments } from '../../tests/helpers/app-route-segments.js'

describe('page-slug', () => {
  it('normalises case and whitespace and refuses bad shapes', () => {
    expect(normaliseSlug(' 50Plus ')).toBe('50plus')
    expect(normaliseSlug('a')).toBeNull()                 // 1 char
    expect(normaliseSlug('-trial')).toBeNull()
    expect(normaliseSlug('trial-')).toBeNull()
    expect(normaliseSlug('x'.repeat(41))).toBeNull()
    expect(normaliseSlug('with space')).toBeNull()
    expect(normaliseSlug(null)).toBeNull()
  })
  it('reserves every top-level app route segment, route groups walked', () => {
    const segs = appRouteSegments(path.resolve(__dirname, '../app'))
    for (const s of segs) expect(RESERVED_PAGE_SLUGS.has(s), s).toBe(true)
    expect(segs).toContain('settings')
    expect(segs).toContain('contacts') // lives under a (group) directory
    expect(segs).not.toContain('[slug]')
  })
  it('reserves the fixed names and judges a slug', () => {
    for (const s of ['api', '_next', 'welcome', 'login', 'settings', 'admin', 'offers', 'embed', 'tv', 'present', 'host', 'h', 'book', 'event', 'race', 'deposit', 'legal', 'privacy', 'terms']) expect(RESERVED_PAGE_SLUGS.has(s), s).toBe(true)
    expect(slugProblem('settings')).toBe('reserved')
    expect(slugProblem('Bad Slug')).toBe('invalid')
    expect(slugProblem('january')).toBeNull()
  })
})
