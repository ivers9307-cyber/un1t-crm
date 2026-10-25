// SECFIX.3a — which KEY NAMES hold a credential, and a deep masker that hides
// their values before a row crosses to a browser or a phone.
//
// THE rule is mig 647's private.audit_is_secret_key() (AUDITSECRETS.1), the
// one the audit trigger redacts by. This file is its only JS copy:
// src/lib/secret-keys.test.js reads the migration and pins the regex text
// and the exact names to it character for character, and
// tests/helpers/audit-secret-keys.js re-exports from here. Changing the rule
// means a new migration AND this file, in the same PR.
//
// On the LOWERCASED name: ends in token | secret | password | passwd |
// passcode | credential | ciphertext (optionally plural and/or (_)hash), or
// ends in (^|_) + pat | pin | api_key | apikey | <private|signing|encryption|
// secret|access|auth>_key | key_hash | pin_hash, or is exactly
// deposit_revolut_checkout_url | bca_config. A camelCase fooApiKey is NOT
// matched (mig 647's accepted gap); has_token-style flags and token counts
// ARE (accepted false positives, see below for how booleans are kept).

export const SECRET_KEY_PATTERN =
  '(token|secret|password|passwd|passcode|credential|ciphertext)s?(_?hash)?$|(^|_)(pat|pin|api_?key|(private|signing|encryption|secret|access|auth)_?key|(key|pin)_?hash)$'

export const SECRET_KEY_EXACT = Object.freeze(['deposit_revolut_checkout_url', 'bca_config'])

const SECRET_KEY_RE = new RegExp(SECRET_KEY_PATTERN)

/** True when mig 647's private.audit_is_secret_key(name) is true. */
export function isSecretKeyName(name) {
  if (name == null) return false
  const k = String(name).toLowerCase()
  return SECRET_KEY_EXACT.includes(k) || SECRET_KEY_RE.test(k)
}

// What a masked value becomes. Starts with '••', which isFreshSecret()
// (integration-secret-merge.js, agent/channels.js) rejects, so a mask echoed
// back to a masked PUT/PATCH never overwrites the stored secret. It carries
// NO character of the value: presence only.
export const SECRET_MASK = '••••••'

// The same cap as mig 647's walkers: a container reached by 12 keys/indexes
// from the top is masked whole, so no document can recurse the walk deep.
export const SECRET_WALK_MAX_DEPTH = 12

const isContainer = (v) => v !== null && typeof v === 'object'

// A value worth hiding. Absence stays visible (null, undefined, blank), and a
// boolean is never a credential: keeping it leaves has_token-style flags
// meaning what they meant (a false one must not turn truthy).
const hasValue = (v) => {
  if (v == null || typeof v === 'boolean') return false
  if (typeof v === 'string') return v.trim() !== ''
  return true
}

/**
 * Copy of `value` with the value of every secret-named key (isSecretKeyName),
 * at any depth, arrays included, replaced by `mask`. Structure-preserving:
 * no key is added or removed, an untouched branch is shared (not copied), and
 * a value with nothing to mask is returned as the SAME object. Never mutates.
 *
 * @param {*} value
 * @param {{ mask?: string }} [opts]
 */
export function maskSecretKeysDeep(value, { mask = SECRET_MASK } = {}) {
  return walk(value, 0, mask)
}

function walk(value, depth, mask) {
  if (!isContainer(value)) return value
  if (depth >= SECRET_WALK_MAX_DEPTH) return mask
  if (Array.isArray(value)) {
    let out = value
    value.forEach((item, i) => {
      const next = walk(item, depth + 1, mask)
      if (next !== item) {
        if (out === value) out = value.slice()
        out[i] = next
      }
    })
    return out
  }
  let out = value
  for (const [k, v] of Object.entries(value)) {
    const next = isSecretKeyName(k) ? (hasValue(v) ? mask : v) : walk(v, depth + 1, mask)
    if (next !== v) {
      if (out === value) out = { ...value }
      out[k] = next
    }
  }
  return out
}

// AUDITRLS.1 (mig 655) — personal data (not a credential) that the audit
// trigger ALSO masks: private.audit_is_pii_key(), an exact-name list. It is
// NOT part of isSecretKeyName and NOT used by maskSecretKeysDeep: an owner
// sees and edits these values on the customer-agent settings screen. The
// audit log is the one place a copy is kept forever and read by someone else.
// src/lib/secret-keys.test.js pins this list to mig 655's in-list; change
// both in the same PR (and in a new migration).
export const AUDIT_PII_KEY_EXACT = Object.freeze(['test_phones'])

/** True when mig 655's private.audit_is_pii_key(name) is true. */
export function isAuditPiiKeyName(name) {
  if (name == null) return false
  return AUDIT_PII_KEY_EXACT.includes(String(name).toLowerCase())
}
