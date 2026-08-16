// BUNDLES.5 final-review fix 2 — "toggle silent flip". Shared pure
// logic for the two per-location feature-toggle UIs
// (src/components/LocationFeatures.jsx,
// src/components/AdminFeatureMatrix.jsx), factored out here so the two
// can't independently drift on either half of the bug this closes:
//
//   1. What a click WRITES. Before this fix, both components computed
//      the next value from the DISPLAYED (bundle-aware composite,
//      isFeatureEnabledAtLocation) state: `!isOn(features, key)`. For
//      a key that's denied only by its BUNDLE (raw features[key]
//      unset or true, but bundlesDenyKey(features, key) is true), the
//      composite reads OFF — so a click computed `true` and silently
//      wrote an explicit `features[key] = true` that had ZERO visible
//      effect (the bundle still denies it) but would spring to life
//      the moment the bundle was re-enabled, as a stray override
//      nobody remembers setting. nextRawFeatureValue() below always
//      flips the RAW value instead, matching what the write has
//      always actually meant.
//   2. Whether a row's toggle should even be CLICKABLE. A per-key
//      toggle CANNOT override a bundle denial — bundlesDenyKey wins
//      regardless of the individual key's own value (see
//      shared/permissions.js isFeatureEnabledAtLocation:
//      `features[key] !== false && !bundlesDenyKey(features, key)`,
//      both conditions ANDed). So once a key is bundle-denied, leaving
//      its toggle enabled is misleading either way — isBundleDenied()
//      + bundleDenialNote() let the UI disable the control and say WHY
//      ("Off via Sales bundle") instead.
//
// Plain JS — these two components are the only consumers, but keeping
// this file free of React/Next imports (same convention as shared/)
// means it stays trivially unit-testable with no DOM.

import { bundlesDenyKey, KEY_BUNDLES, BUNDLE_LABELS } from '@shared/permission-bundles'

/**
 * The RAW (un-bundled) on/off state of a key — missing or explicit
 * `true` → on, explicit `false` → off. Mirrors the individual-key half
 * of isFeatureEnabledAtLocation's polarity ONLY; deliberately ignores
 * the bundle layer, because this is "what is actually stored", not
 * "what is effectively enabled" (use the real isFeatureEnabledAtLocation
 * for that — this file never re-derives it).
 *
 * @param {object|null|undefined} features
 * @param {string} key
 * @returns {boolean}
 */
export function rawFeatureOn(features, key) {
  return features?.[key] !== false
}

/**
 * The next RAW value a toggle click should WRITE for `key` — always
 * the flip of the current raw value, never the bundle-aware composite.
 * See the header comment for why this matters.
 *
 * @param {object|null|undefined} features
 * @param {string} key
 * @returns {boolean}
 */
export function nextRawFeatureValue(features, key) {
  return !rawFeatureOn(features, key)
}

/**
 * Is `key` denied by the bundle layer (independent of its own raw
 * value)? Thin re-export of bundlesDenyKey under a UI-facing name —
 * kept here rather than importing bundlesDenyKey directly in both
 * components so a reader sees the UI's own vocabulary ("is this row
 * disabled") rather than the resolver's ("is this key denied").
 *
 * @param {object|null|undefined} features
 * @param {string} key
 * @returns {boolean}
 */
export function isBundleDenied(features, key) {
  return bundlesDenyKey(features, key)
}

/**
 * Human copy for a bundle-denied row, e.g. "Off via Sales bundle" or
 * (a dual-owned key) "Off via Members + Operations bundle" — joins
 * every owning bundle, though a denial only ever fires when ALL of
 * them are explicitly off (OR semantics — see
 * shared/permission-bundles.js KEY_BUNDLES). Returns null for a key
 * owned by zero bundles (core/exempt keys, and bundle keys themselves
 * — there is no meta-bundle), which also means "never disabled".
 *
 * @param {string} key
 * @returns {string|null}
 */
export function bundleDenialNote(key) {
  const owners = KEY_BUNDLES[key]
  if (!owners || owners.length === 0) return null
  const names = owners.map((b) => BUNDLE_LABELS[b]).join(' + ')
  return `Off via ${names} bundle`
}
