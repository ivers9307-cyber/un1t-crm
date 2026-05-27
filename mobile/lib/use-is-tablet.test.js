// STUDIO-IPAD.1 — coverage for the tablet breakpoint primitive.
//
// The hook itself (useIsTablet) is a thin useWindowDimensions wrapper
// — vitest can't easily exercise that without RN test infra the
// mobile suite doesn't bring. What we DO pin is the breakpoint number
// + the pure isTabletWidth predicate. Locking these prevents
// accidental drift if someone bumps the threshold without thinking
// about the device-class boundary.
//
// Import from the pure helper file directly — use-is-tablet.js
// transitively imports react-native, which vitest can't parse.

import { describe, it, expect } from 'vitest'
import {
  TABLET_BREAKPOINT_PT,
  MASTER_PANE_WIDTH_PT,
  isTabletWidth,
} from './tablet-breakpoint.js'

describe('TABLET_BREAKPOINT_PT', () => {
  it('is 700pt — the device-class boundary', () => {
    expect(TABLET_BREAKPOINT_PT).toBe(700)
  })

  it('iPhone widths (320–430pt) are below the breakpoint', () => {
    expect(isTabletWidth(320)).toBe(false)
    expect(isTabletWidth(390)).toBe(false)
    expect(isTabletWidth(430)).toBe(false)
  })

  it('iPad Mini portrait (768pt) is above the breakpoint', () => {
    expect(isTabletWidth(768)).toBe(true)
  })

  it('iPad 11" portrait (834pt) is above the breakpoint', () => {
    expect(isTabletWidth(834)).toBe(true)
  })

  it('iPad 12.9" portrait (1024pt) is above the breakpoint', () => {
    expect(isTabletWidth(1024)).toBe(true)
  })

  it('iPad 1/3 Slide Over (~320pt) is below — narrow side panel acts as a phone', () => {
    expect(isTabletWidth(320)).toBe(false)
  })

  it('iPad 1/2 split on 11" (~507pt) is below — half-split stays single-column', () => {
    expect(isTabletWidth(507)).toBe(false)
  })
})

describe('isTabletWidth', () => {
  it('returns false on non-number input', () => {
    expect(isTabletWidth(null)).toBe(false)
    expect(isTabletWidth(undefined)).toBe(false)
    expect(isTabletWidth('768')).toBe(false)
    expect(isTabletWidth(NaN)).toBe(false)
  })

  it('is exclusive at the boundary (>= TABLET_BREAKPOINT_PT)', () => {
    expect(isTabletWidth(TABLET_BREAKPOINT_PT - 1)).toBe(false)
    expect(isTabletWidth(TABLET_BREAKPOINT_PT)).toBe(true)
    expect(isTabletWidth(TABLET_BREAKPOINT_PT + 1)).toBe(true)
  })
})

describe('MASTER_PANE_WIDTH_PT', () => {
  it('is a reasonable list-pane size', () => {
    expect(MASTER_PANE_WIDTH_PT).toBeGreaterThan(280)
    expect(MASTER_PANE_WIDTH_PT).toBeLessThan(500)
  })
})
