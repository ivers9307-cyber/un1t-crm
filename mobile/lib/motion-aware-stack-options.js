// MOBILE-A11Y-REDUCED-MOTION — pure helper. Split out from
// use-reduced-motion.js so this file has zero react-native imports
// and stays testable under vitest (RN's index.js can't be parsed
// by vitest's rolldown loader, so anything that transitively
// imports react-native becomes untestable).
//
// Given a base expo-router Stack screenOptions object, returns
// the same options with `animation: 'fade'` injected when the
// reduceMotion preference is on. When off, returns the base
// object by reference (no allocation, no re-render churn).
//
// 'fade' is preferable to 'none' for reduced-motion users — a slow
// cross-fade preserves the sense of transition without the
// vestibular trigger of horizontal slides or vertical sheet pulls.

export function motionAwareStackOptions(baseOptions, reduceMotion) {
  if (!reduceMotion) return baseOptions
  return {
    ...baseOptions,
    animation: 'fade',
  }
}
