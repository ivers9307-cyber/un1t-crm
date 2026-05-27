// STUDIO-IPAD.1 — useIsTablet() hook for adaptive layouts.
//
// Returns true when the current viewport is wide enough that a
// multi-column / master-detail layout makes sense. Used by screens
// like Schedule, Contacts, and Approvals to switch between phone-
// shape (single-column) and iPad-shape (split-view) renders.
//
// Re-evaluates on every dimension change — rotation, Stage Manager
// resize, Split View ratio change — because useWindowDimensions
// subscribes to those events.
//
// Pure breakpoint logic lives in tablet-breakpoint.js so it can be
// unit-tested without react-native in the runtime; the hook here is
// the RN-side wrapper.

import { useWindowDimensions } from 'react-native'
import {
  TABLET_BREAKPOINT_PT,
  MASTER_PANE_WIDTH_PT,
  isTabletWidth,
} from './tablet-breakpoint.js'

export { TABLET_BREAKPOINT_PT, MASTER_PANE_WIDTH_PT }

/** @returns {boolean} */
export function useIsTablet() {
  const { width } = useWindowDimensions()
  return isTabletWidth(width)
}

/** Convenience: 'phone' | 'tablet' for switch / memo keys. */
export function useDeviceClass() {
  return useIsTablet() ? 'tablet' : 'phone'
}
