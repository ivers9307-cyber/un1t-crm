// AUDITSECRETS.1 (mig 647) — the rule private.audit_is_secret_key() applies,
// mirrored in JS so the guard test can check names without a database.
// SECFIX.3a: the rule itself now lives in src/lib/secret-keys.js (the app
// masks browser-bound rows by it too), re-exported here under the names the
// audit tests use, so there is ONE JS copy. Both
// tests/migration-647-audit-redact-secrets.test.js and
// src/lib/secret-keys.test.js pin it to the migration's regex character for
// character. Change both in the same PR (and in a new migration).

import { SECRET_KEY_PATTERN, SECRET_KEY_EXACT, isSecretKeyName } from '../../src/lib/secret-keys.js'

export const AUDIT_SECRET_KEY_PATTERN = SECRET_KEY_PATTERN

export const AUDIT_SECRET_EXACT = SECRET_KEY_EXACT

/** True when private.audit_is_secret_key(name) is true. */
export const isAuditSecretKey = isSecretKeyName

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
  // Review fix (28 Sep): camelCase, plurals and hash shapes. The key is
  // lowercased first, so accessToken is "accesstoken".
  'accessToken', 'refreshToken', 'clientSecret', 'webhookSecret', 'webhookSigningSecret',
  'appPassword', 'apiKey', 'privateKey', 'tokens', 'push_tokens', 'secrets', 'credentials',
  'password_hash', 'secret_hash', 'passwordHash', 'apiTokenHash',
  // A PIN is a secret: a bare `pin` key, and `<x>_pin` (door_pin).
  'pin', 'door_pin',
])

/** Accepted false positives: not credentials, but the rule masks them
 *  (token COUNTS, has_token-style flags). None is on an audited table today;
 *  masking fails toward hiding a number, never toward leaking a secret. */
export const KNOWN_MASKED_LOOKALIKES = Object.freeze([
  'max_tokens', 'input_tokens', 'output_tokens', 'has_token', 'hasApiToken',
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
  // Review fix (28 Sep): the prod census look-alikes the wider rule must
  // still leave visible, and the pin_* bookkeeping columns.
  'signature_method', 'email_signature', 'email_signature_html', 'emailSignature',
  'tokenExpiresAt', 'passwordChanged', 'avatar_path', 'logo_url',
  'pinned', 'is_pinned', 'pin_hint', 'spin', 'token_count', 'secret_name',
])
