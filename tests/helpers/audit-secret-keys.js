// AUDITSECRETS.1 (mig 647) — the rule private.audit_is_secret_key() applies,
// mirrored in JS so the guard test can check names without a database.
// tests/migration-647-audit-redact-secrets.test.js pins the migration's regex
// to AUDIT_SECRET_KEY_PATTERN character for character, so the two can never
// drift. Change both in the same PR (and in a new migration).

export const AUDIT_SECRET_KEY_PATTERN =
  '(^|_)(api_?key|token|secret|password|passwd|passcode|pat|ciphertext|credentials?|(private|signing|encryption|secret|access|auth)_?key|(key|token|pin)_hash)$'

export const AUDIT_SECRET_EXACT = Object.freeze(['deposit_revolut_checkout_url', 'bca_config'])

const RE = new RegExp(AUDIT_SECRET_KEY_PATTERN)

/** True when private.audit_is_secret_key(name) is true. */
export function isAuditSecretKey(name) {
  if (name == null) return false
  const k = String(name).toLowerCase()
  return AUDIT_SECRET_EXACT.includes(k) || RE.test(k)
}

/** The tables mig 191 attached `audit_mutation` to (prod, 28 Sep 2026). */
export const AUDITED_TABLES = Object.freeze([
  'cars', 'invoices_queue', 'locations', 'organizations', 'profile_locations', 'profiles',
])

/** Every secret-bearing name found on prod, 28 Sep 2026: audited columns and
 *  the locations.settings sub-keys. Each MUST be redacted. */
export const KNOWN_SECRET_NAMES = Object.freeze([
  'api_key', 'api_token', 'webhook_secret',           // settings.glofox
  // settings.unifi.api_token is 'api_token' above
  'sensibo_api_key', 'thinq_pat', 'bca_config',       // locations columns
  'deposit_token', 'deposit_revolut_checkout_url',    // cars columns
  'pin_hash',                                         // profiles column
  // Estate-wide secret columns (not audited today; if a table holding one is
  // ever given the audit trigger, the rule already covers it):
  'access_token', 'refresh_token', 'app_secret', 'client_secret', 'imap_password',
  'auth_key', 'glofox_passcode', 'postmark_server_token', 'secret_ciphertext',
  'oauth_access_token_ciphertext', 'oauth_refresh_token_ciphertext', 'key_hash', 'token_hash',
  'api_token_hash', 'previous_token_hash', 'device_token_hash', 'expo_push_token',
  'webhook_token', 'share_token', 'view_token', 'download_token', 'unsubscribe_token',
  'payment_checkout_token', 'token',
])

/** Names on the audited tables / in audit details that look secret-ish but are
 *  not credentials. Each MUST stay visible in the audit log. */
export const KNOWN_NOT_SECRET_NAMES = Object.freeze([
  'deposit_token_expires_at', 'content_hash', 'password_changed',
  'pin_set_at', 'pin_failed_count', 'pin_locked_until',
  'branch_id', 'namespace', 'host', 'allow_self_signed', 'thinq_client_id',
  'booking_url', 'membership_signup_url', 'xero_invoice_url', 'xero_invoice_online_url',
  'attachment_path', 'home_screen_path', 'token_expires_at', 'token_invalid_at', 'token_type',
  'test_phones', 'dataset_id', 'flow_id', 'accounts',
  // Estate-wide look-alikes that are not credentials:
  'automation_key', 'dedup_key', 'device_key', 'event_key', 'bucket_key', 'xero_line_key',
  'auth_key_fingerprint', 'token_fingerprint', 'passcode_sent', 'token_refreshed_at',
  'last_refreshed_at', 'token_issued_at', 'previous_token_expires_at', 'share_token_expires_at',
  'compat', 'public_path',
])
