import { describe, it, expect, vi } from 'vitest'
import { metaPixelIdsForPath, pageLocationIdFromDocument, STUDIO_META_PIXELS_BY_LOCATION, SITE_META_PIXEL_ID } from './meta-pixel-paths.js'

const HATCH = '39174085025538525'
const HATCH_LOCATION = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILLORGAN_LOCATION = '11111111-2222-3333-4444-555555555555'

describe('metaPixelIdsForPath', () => {
  it('every page loads the site pixel, and only it, by default', () => {
    for (const p of ['/', '/start', '/stillorgan', '/free-class', '/welcome', '/welcome/stillorgan', '/start/stillorgan', '', null, undefined]) {
      expect(metaPixelIdsForPath(p)).toEqual([SITE_META_PIXEL_ID])
    }
  })

  it('Hatch Street pages load the Hatch dataset pixel as well', () => {
    for (const p of ['/hatch-street', '/hatch-street/events', '/welcome/hatch-street', '/start/hatch-street']) {
      expect(metaPixelIdsForPath(p)).toEqual([SITE_META_PIXEL_ID, HATCH])
    }
  })

  it('matches whole path segments, not string prefixes', () => {
    expect(metaPixelIdsForPath('/hatch-streets')).toEqual([SITE_META_PIXEL_ID])
    expect(metaPixelIdsForPath('/start/hatch-street-2')).toEqual([SITE_META_PIXEL_ID])
  })

  // PAGES.1: a studio page's pixel follows the page's studio, whatever its path.
  it('a page whose primary studio is Hatch Street loads the Hatch dataset, once, at any path', () => {
    expect(STUDIO_META_PIXELS_BY_LOCATION[HATCH_LOCATION]).toBe(HATCH)
    expect(metaPixelIdsForPath('/anything', { primaryLocationId: HATCH_LOCATION })).toEqual([SITE_META_PIXEL_ID, HATCH])
    expect(metaPixelIdsForPath('/hatch-street', { primaryLocationId: HATCH_LOCATION })).toEqual([SITE_META_PIXEL_ID, HATCH])
    expect(metaPixelIdsForPath('/corp', { primaryLocationId: HATCH_LOCATION })).toEqual([SITE_META_PIXEL_ID, HATCH])
  })

  it('the old Hatch paths still match without a page studio', () => {
    expect(metaPixelIdsForPath('/hatch-street')).toEqual([SITE_META_PIXEL_ID, HATCH])
    expect(metaPixelIdsForPath('/hatch-street', {})).toEqual([SITE_META_PIXEL_ID, HATCH])
  })

  it('a studio with no dataset of its own loads the site pixel only', () => {
    expect(metaPixelIdsForPath('/stillorgan', { primaryLocationId: STILLORGAN_LOCATION })).toEqual([SITE_META_PIXEL_ID])
    expect(metaPixelIdsForPath('/stillorgan', { primaryLocationId: null })).toEqual([SITE_META_PIXEL_ID])
  })
})

describe('pageLocationIdFromDocument', () => {
  it('is null on the server (no document)', () => {
    expect(pageLocationIdFromDocument()).toBeNull()
  })

  it('reads data-page-location off the rendered page root', () => {
    const doc = { querySelector: (sel) => (sel === '[data-page-location]' ? { getAttribute: (n) => (n === 'data-page-location' ? HATCH_LOCATION : null) } : null) }
    vi.stubGlobal('document', doc)
    try {
      expect(pageLocationIdFromDocument()).toBe(HATCH_LOCATION)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('is null when the page carries no attribute, or an empty one', () => {
    vi.stubGlobal('document', { querySelector: () => null })
    expect(pageLocationIdFromDocument()).toBeNull()
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => '' }) })
    expect(pageLocationIdFromDocument()).toBeNull()
    vi.unstubAllGlobals()
  })
})
