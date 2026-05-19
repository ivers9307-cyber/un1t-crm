// MOBILE-A11Y-REDUCED-MOTION — coverage for the motion-aware helper.
//
// The hook itself (useReducedMotion) is a thin wrapper around
// AccessibilityInfo.isReduceMotionEnabled() + the
// 'reduceMotionChanged' event subscription. It's three lines of
// React plumbing — exercising it under vitest would require pulling
// in @testing-library/react and a react-test-renderer (~3MB of
// transitive deps), which isn't worth it for the surface area.
//
// What IS worth pinning is motionAwareStackOptions — every consumer
// (_layout.jsx files for schedule / invoices / impersonate) calls
// this directly and its semantics determine whether the user's
// accessibility preference actually reaches the navigator. Tests
// below pin the four behaviours that matter:
//   1. reduceMotion=false returns the base options untouched
//      (referential equality preserved — no unnecessary re-renders)
//   2. reduceMotion=true adds animation='fade'
//   3. Other base options carry through verbatim
//   4. An existing 'animation' value gets overridden — user
//      accessibility preference outranks developer aesthetics
//
// The hook contract is asserted only via mobile/parity-check
// integration: if you delete the hook or change its signature, the
// _layout.jsx files that import it will fail to bundle and the
// EAS build itself will surface that. So the test surface here is
// scoped to where bugs can hide silently.

import { describe, it, expect } from 'vitest'
// Import from the pure helper file directly — use-reduced-motion.js
// transitively imports react-native, which vitest can't parse.
import { motionAwareStackOptions } from './motion-aware-stack-options.js'

describe('motionAwareStackOptions', () => {
  it('returns the base options unchanged when reduceMotion is false', () => {
    const base = { presentation: 'modal', headerStyle: { backgroundColor: '#FFFFFF' } }
    const out = motionAwareStackOptions(base, false)
    // Referential equality — no unnecessary new object allocation,
    // which keeps React.memo'd Stack screenOptions stable across
    // re-renders.
    expect(out).toBe(base)
    expect(out).not.toHaveProperty('animation')
  })

  it('adds animation=fade when reduceMotion is true', () => {
    const base = { presentation: 'modal' }
    const out = motionAwareStackOptions(base, true)
    expect(out).toEqual({ presentation: 'modal', animation: 'fade' })
  })

  it('preserves all other base options when reduceMotion is true', () => {
    const base = {
      title: 'New invoice',
      presentation: 'modal',
      headerStyle: { backgroundColor: '#FFFFFF' },
      headerBackTitle: 'Back',
      headerTitleStyle: { fontWeight: '600' },
    }
    const out = motionAwareStackOptions(base, true)
    expect(out.title).toBe('New invoice')
    expect(out.presentation).toBe('modal')
    expect(out.headerStyle).toEqual({ backgroundColor: '#FFFFFF' })
    expect(out.headerBackTitle).toBe('Back')
    expect(out.headerTitleStyle).toEqual({ fontWeight: '600' })
    expect(out.animation).toBe('fade')
  })

  it('overrides an explicit animation when reduceMotion is on', () => {
    // If a caller explicitly sets animation: 'slide_from_right',
    // the reduce-motion override wins. This is the right priority —
    // accessibility preference outranks developer aesthetic choice.
    const base = { animation: 'slide_from_right', title: 'Detail' }
    const out = motionAwareStackOptions(base, true)
    expect(out.animation).toBe('fade')
    expect(out.title).toBe('Detail')
  })

  it('leaves an explicit animation alone when reduceMotion is off', () => {
    // The override only kicks in for reduced motion; a developer
    // who wants a specific animation still gets it in the default
    // (motion-on) case.
    const base = { animation: 'slide_from_right' }
    const out = motionAwareStackOptions(base, false)
    expect(out.animation).toBe('slide_from_right')
  })
})
