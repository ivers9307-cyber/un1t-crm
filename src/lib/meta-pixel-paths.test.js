import { describe, it, expect } from 'vitest'
import { metaPixelIdsForPath, SITE_META_PIXEL_ID } from './meta-pixel-paths.js'

const HATCH = '39174085025538525'

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
})
