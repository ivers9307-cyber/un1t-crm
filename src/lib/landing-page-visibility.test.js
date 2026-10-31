import { describe, it, expect } from 'vitest'
import {
  PUBLISH_STATES, PAGE_PUBLISH_STATES, tileModeFor, isPubliclyVisible,
  tileStateToPageState, pageStateToTileState,
} from './landing-page-visibility'

describe('landing-page visibility helpers', () => {
  it('lists exactly the three states in order', () => {
    expect(PUBLISH_STATES).toEqual(['live', 'coming_soon', 'hidden'])
  })

  it('tileModeFor maps each known state', () => {
    expect(tileModeFor('live')).toBe('active')
    expect(tileModeFor('coming_soon')).toBe('coming_soon')
    expect(tileModeFor('hidden')).toBe('hidden')
  })

  it('tileModeFor fails closed on unknown / null / undefined', () => {
    expect(tileModeFor(null)).toBe('hidden')
    expect(tileModeFor(undefined)).toBe('hidden')
    expect(tileModeFor('bogus')).toBe('hidden')
  })

  it('isPubliclyVisible is true only for live', () => {
    expect(isPubliclyVisible('live')).toBe(true)
    expect(isPubliclyVisible('coming_soon')).toBe(false)
    expect(isPubliclyVisible('hidden')).toBe(false)
    expect(isPubliclyVisible(null)).toBe(false)
  })

  // PAGES.1 — the chooser tile keeps its three states; the page row has four.
  it('PAGE_PUBLISH_STATES is the four states a landing_pages row holds', () => {
    expect(PAGE_PUBLISH_STATES).toEqual(['draft', 'live', 'coming_soon', 'retired'])
  })

  it('tileModeFor answers hidden for a draft or retired page', () => {
    expect(tileModeFor('draft')).toBe('hidden')
    expect(tileModeFor('retired')).toBe('hidden')
  })

  it('a tile state maps onto a page state (hidden is draft) and back (draft and retired are hidden)', () => {
    expect(tileStateToPageState('live')).toBe('live')
    expect(tileStateToPageState('coming_soon')).toBe('coming_soon')
    expect(tileStateToPageState('hidden')).toBe('draft')
    expect(tileStateToPageState('bogus')).toBe('draft')
    expect(pageStateToTileState('live')).toBe('live')
    expect(pageStateToTileState('coming_soon')).toBe('coming_soon')
    expect(pageStateToTileState('draft')).toBe('hidden')
    expect(pageStateToTileState('retired')).toBe('hidden')
    expect(pageStateToTileState(null)).toBe('hidden')
  })
})
