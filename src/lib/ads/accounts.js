// src/lib/ads/accounts.js
// Resolve/mask/patch ad_accounts rows. Mirrors src/lib/agent/channels.js
// secret handling so tokens are never returned raw to the browser and a
// masked echo on save is not written back over the real token.
// N8NECHO.1: presence only. The mask carries no character of the token (it
// used to keep the last 4), and "fresh" is the shared •• rule, so no mask
// shape (this one, the old 8-bullet one) can ever overwrite a token. The old
// local rule checked an 8-bullet prefix, which the 6-bullet SECRET_MASK would
// have passed as a fresh token.

import { SECRET_MASK } from '../secret-keys.js'
import { isFreshSecret } from '../integration-secret-merge.js'

export { isFreshSecret }

export function maskSecret(value) {
  const s = String(value || '')
  if (!s) return ''
  return SECRET_MASK
}

/** Prepare a row for the browser: mask the token, add has_* booleans. */
export function maskAccountRow(row) {
  if (!row) return row
  return {
    ...row,
    access_token: maskSecret(row.access_token),
    has_access_token: Boolean(row.access_token),
  }
}

/** Build a DB patch from a submitted form: copy non-secret fields; only
 *  write access_token when it is a fresh value (not the masked echo). */
export function buildAccountPatch(body) {
  const patch = {}
  for (const k of ['external_account_id', 'business_account_id', 'display_name', 'is_active', 'currency', 'account_timezone']) {
    if (body[k] !== undefined) patch[k] = body[k]
  }
  if (isFreshSecret(body.access_token)) patch.access_token = body.access_token
  return patch
}

/** Resolve the active account for (location, provider). Returns row or null. */
export async function resolveAdsAccount(db, locationId, provider) {
  const { data } = await db.from('ad_accounts')
    .select('*').eq('location_id', locationId).eq('provider', provider).eq('is_active', true)
    .limit(1).maybeSingle()
  return data || null
}
