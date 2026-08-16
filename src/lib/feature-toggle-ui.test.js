// BUNDLES.5 final-review fix 2 — "toggle silent flip". Pure helpers
// shared by LocationFeatures.jsx and AdminFeatureMatrix.jsx so the two
// per-location feature-toggle UIs can't independently drift on either
// half of the bug this closes:
//   1. what a click WRITES — the raw, un-bundled value of the key
//      (never the bundle-aware composite isFeatureEnabledAtLocation
//      value), so a bundle-denied key's raw features[key] is never
//      silently promoted to an explicit `true` with zero visible
//      effect today that springs to life the moment the bundle is
//      re-enabled.
//   2. whether a row's toggle should even be CLICKABLE — a key denied
//      by its bundle can't be un-denied by flipping its own raw value
//      (bundlesDenyKey wins regardless of the individual key — see
//      shared/permissions.js isFeatureEnabledAtLocation), so leaving
//      the control enabled is just misleading.

import { describe, it, expect } from 'vitest'
import {
  rawFeatureOn,
  nextRawFeatureValue,
  isBundleDenied,
  bundleDenialNote,
} from './feature-toggle-ui.js'

describe('rawFeatureOn', () => {
  it('missing key or explicit true → on', () => {
    expect(rawFeatureOn({}, 'pipeline')).toBe(true)
    expect(rawFeatureOn({ pipeline: true }, 'pipeline')).toBe(true)
  })

  it('explicit false → off', () => {
    expect(rawFeatureOn({ pipeline: false }, 'pipeline')).toBe(false)
  })

  it('ignores the bundle layer entirely — a bundle-denied-but-individually-unset key still reads raw-ON', () => {
    // pipeline is owned by bundle_sales only; bundle_sales:false denies
    // it at the COMPOSITE level, but the raw individual value is unset
    // (never explicitly false), so rawFeatureOn must still say true.
    expect(rawFeatureOn({ bundle_sales: false }, 'pipeline')).toBe(true)
  })

  it('null/undefined features treated as {}', () => {
    expect(rawFeatureOn(null, 'pipeline')).toBe(true)
    expect(rawFeatureOn(undefined, 'pipeline')).toBe(true)
  })
})

describe('nextRawFeatureValue — what a click should WRITE', () => {
  it('flips the RAW value, not the bundle-aware composite', () => {
    // Composite isFeatureEnabledAtLocation would read this as OFF
    // (bundle_sales denies it) — but the raw value is unset (on), so
    // the correct next value to write is `false` (turning the
    // individual key off), not `true` (which would be a silent flip:
    // promoting an unset key to an explicit true with zero visible
    // effect while the bundle stays off).
    expect(nextRawFeatureValue({ bundle_sales: false }, 'pipeline')).toBe(false)
  })

  it('an individually-off key with its bundle ON flips back to true (the ordinary case, unaffected)', () => {
    expect(nextRawFeatureValue({ pipeline: false }, 'pipeline')).toBe(true)
  })

  it('an unset key (on) flips to explicit false', () => {
    expect(nextRawFeatureValue({}, 'contacts')).toBe(false)
  })
})

describe('isBundleDenied', () => {
  it('true when every bundle owning the key is explicitly false', () => {
    expect(isBundleDenied({ bundle_sales: false }, 'pipeline')).toBe(true)
  })

  it('false when the bundle is on/unset', () => {
    expect(isBundleDenied({}, 'pipeline')).toBe(false)
    expect(isBundleDenied({ bundle_sales: true }, 'pipeline')).toBe(false)
  })

  it('false for a key owned by zero bundles (core/exempt), regardless of bundle state', () => {
    expect(isBundleDenied({ bundle_sales: false, bundle_money: false }, 'settings')).toBe(false)
  })

  it('OR semantics — a dual-owned key (studio_management) is denied only when BOTH owners are off', () => {
    expect(isBundleDenied({ bundle_members: false, bundle_operations: true }, 'studio_management')).toBe(false)
    expect(isBundleDenied({ bundle_members: false, bundle_operations: false }, 'studio_management')).toBe(true)
  })

  it('a bundle key itself (e.g. bundle_sales) is never bundle-denied — there is no meta-bundle', () => {
    expect(isBundleDenied({ bundle_sales: false }, 'bundle_sales')).toBe(false)
  })
})

describe('bundleDenialNote', () => {
  it('names the single owning bundle for a single-owner key', () => {
    expect(bundleDenialNote('pipeline')).toBe('Off via Sales bundle')
  })

  it('joins every owning bundle for a dual-owner key', () => {
    expect(bundleDenialNote('studio_management')).toBe('Off via Members + Operations bundle')
  })

  it('null for a key owned by zero bundles', () => {
    expect(bundleDenialNote('settings')).toBeNull()
  })

  it('null for a bundle key itself', () => {
    expect(bundleDenialNote('bundle_sales')).toBeNull()
  })
})
