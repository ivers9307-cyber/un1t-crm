// INTEG hub inline #4 (Phase 2) — write-only secret merge for the in-hub
// integration Manage forms.
//
// The Phase-2 Manage drawer edits each provider's credential slice INLINE in
// the Integrations hub. Secret inputs render BLANK (or a masked "••••••"
// echo), so the browser never receives the stored secret and never sends it
// back on a no-op save. This module is the PURE seam that turns an incoming
// form patch + the CURRENT stored slice into the slice to persist, WITHOUT
// ever wiping a secret the operator didn't intend to change.
//
// ── THE GLOFOX NULL-COLLAPSE TRAP (why this file exists) ──────────────────
//   The old GlofoxIntegrationTab.save() computed
//       glofox: (branchId || apiKey || apiToken || webhookSecret || … ) ? {…} : null
//   i.e. "if every field is empty, collapse the whole slice to null". With
//   the inline fields now starting blank/masked, a naive port of that rule
//   would see "every field empty" on a no-op save and collapse the slice to
//   null — WIPING Stillorgan's LIVE Glofox connection (the only
//   Glofox-connected location) and, via syncConnectionFromLegacy, DEACTIVATE
//   its registry row.
//
//   The fix, enforced here: keep-vs-clear is decided from the STORED slice,
//   NEVER from the blank inputs.
//     • a blank OR masked-echo incoming secret  → KEEP the stored value
//     • a fresh (real, non-masked) secret        → overwrite
//     • a non-secret field                       → set normally (blank clears it)
//   Because the merged slice always carries the stored secrets forward, a
//   save that changed nothing yields a NON-EMPTY slice — so the "empty →
//   null" collapse can never fire on a live connection. Clearing the whole
//   slice happens ONLY through an explicit disconnect (a separate code path),
//   never as a side effect of a blank save.
//
// Pure + dependency-free so it unit-tests hard (integration-secret-merge.test.js)
// and can be imported by both the service-role route and any future caller.

// A masked secret echo always starts with the bullet run the UI renders.
const MASK_PREFIX = '••'

/**
 * Is a submitted secret a REAL new value, versus blank or the masked echo?
 * Mirrors the isFreshSecret contract already used by ads/accounts.js and
 * agent/channels.js so every write-only secret path agrees on "fresh".
 * Pure.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFreshSecret(value) {
  if (value == null) return false
  const s = String(value).trim()
  if (!s) return false
  if (s.startsWith(MASK_PREFIX)) return false
  return true
}

/**
 * Mask a secret for display: keep the last `keep` chars behind dots, or a
 * bare bullet run when the value is shorter. null for empty input. Pure.
 *
 * @param {unknown} value
 * @param {number} [keep=4]
 * @returns {string|null}
 */
export function maskSecret(value, keep = 4) {
  if (!value) return null
  const s = String(value)
  if (s.length <= keep) return '••••••'
  return `••••••${s.slice(-keep)}`
}

/** Trim a string-ish patch value; pass non-strings straight through. */
function normalize(value) {
  if (typeof value === 'string') return value.trim()
  return value
}

/**
 * Merge an incoming form patch onto a stored credential slice, WRITE-ONLY
 * for secrets. The returned object starts from a shallow copy of `stored`
 * (so any stored field the form does NOT expose — e.g. Glofox's
 * trial_membership_id / hidden_class_keywords — is preserved), then applies
 * each key the patch actually carries:
 *
 *   • secret field  → overwritten ONLY when isFreshSecret(patch[key]); a
 *                     blank or masked-echo value keeps stored[key].
 *   • non-secret    → set to the (trimmed) patch value, with '' normalised
 *                     to null so a cleared field reads as absent.
 *
 * Keys whose patch value is `undefined` are skipped entirely (the form
 * didn't send them). NEVER decides to null the whole slice — that is the
 * caller's explicit-disconnect concern, judged via sliceHasValue().
 *
 * @param {{ stored?: object|null, patch?: object|null, secretFields?: string[] }} args
 * @returns {object}
 */
export function mergeSecretSlice({ stored, patch, secretFields = [] } = {}) {
  const secrets = new Set(secretFields || [])
  const merged = { ...(stored && typeof stored === 'object' ? stored : {}) }
  const incoming = patch && typeof patch === 'object' ? patch : {}

  for (const [key, raw] of Object.entries(incoming)) {
    if (raw === undefined) continue // form didn't touch this field
    if (secrets.has(key)) {
      // Write-only: keep the stored secret unless a FRESH value arrived.
      if (isFreshSecret(raw)) merged[key] = String(raw).trim()
      // else: leave merged[key] as the stored value (the keep case).
      continue
    }
    const v = normalize(raw)
    merged[key] = v === '' ? null : v
  }

  return merged
}

/**
 * Does a merged slice carry any MEANINGFUL value? Used by JSONB-slice
 * providers (Glofox / UniFi) + BCA to decide whether to persist the object
 * or store null — so an all-empty slice reads as "unconfigured" (the legacy
 * `glofox: … ? {…} : null` shape) WITHOUT the blank-save wipe: because
 * mergeSecretSlice carries stored secrets forward, a live connection always
 * has a value here, so this returns true and the slice is never collapsed.
 *
 * A value counts when it is a non-empty string, a number, or `true`. Empty
 * strings, null/undefined and `false` do NOT count (mirrors the legacy
 * truthiness collapse, which ignored boolean toggles like allow_self_signed).
 * Keys in `ignore` are never counted.
 *
 * @param {object|null} slice
 * @param {{ ignore?: string[] }} [opts]
 * @returns {boolean}
 */
export function sliceHasValue(slice, { ignore = [] } = {}) {
  if (!slice || typeof slice !== 'object') return false
  const skip = new Set(ignore)
  for (const [key, v] of Object.entries(slice)) {
    if (skip.has(key)) continue
    if (v == null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (v === false) continue
    if (Array.isArray(v) && v.length === 0) continue
    return true
  }
  return false
}
