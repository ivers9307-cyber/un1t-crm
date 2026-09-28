// ACDEVLOC.1 — the `locations` row as /settings/locations/[id] passes it in
// its `location` PROP.
//
// That page reads the row with select('*') through the service role and hands
// it to client components, which serialises every column into the HTML. The
// two AC vendor credentials are replaced by booleans here: nothing on the page
// needs their values (the AC tab saves through the write-only
// PUT /api/locations/[id]/integrations/ac, which answers has_* flags).
//
// SECFIX.3b — and every other stored credential on the row is masked
// (redactLocationSecrets): settings.glofox.{api_key, api_token,
// webhook_secret}, settings.unifi.api_token and any other secret-named key
// keep their presence as '••••••', never their value. The Glofox and UniFi
// tabs are write-only clients of the masked
// PUT /api/locations/[id]/integrations/[provider]. The `user` object is
// redacted at its source (getCurrentUser, SECFIX.3a).
//
// ONE exception: `bca_config`. Mig 647's secret-key rule names that column
// (so redactLocationSecrets masks it whole), but it holds no credential (the
// send-from / send-to / cc addresses, subject and body templates and the
// document-slot labels; audited in the integrations route's BCA
// descriptor), and this page needs it: BcaIntegrationTab prefills its form
// from it and LocationIntegrations reads bca_config.send_from for the status
// dot. Masked, the tab would show the defaults and a Save would overwrite the
// stored config with them. So it crosses with its fields intact, but walked by
// the same secret-key rule: a secret-named key added inside it later (an
// smtp_password, say) is masked, while today's keys (send_from, send_to, cc,
// subject_template, body_template, documents) all pass unchanged.

import { LOCATION_SECRET_MASK, redactLocationSecrets } from './location-secrets.js'
import { maskSecretKeysDeep } from './secret-keys.js'

export const LOCATION_SECRET_COLUMNS = Object.freeze(['sensibo_api_key', 'thinq_pat'])

/**
 * @param {object|null} row  a `locations` row
 * @returns {object|null}    the row without the AC credentials, plus
 *                           has_sensibo_key / has_thinq_pat, every other
 *                           credential masked (bca_config kept, its
 *                           secret-named sub-keys masked)
 */
export function toClientLocation(row) {
  if (!row || typeof row !== 'object') return row
  const { sensibo_api_key: sensiboApiKey, thinq_pat: thinqPat, ...rest } = row
  const out = { ...redactLocationSecrets(rest), has_sensibo_key: !!sensiboApiKey, has_thinq_pat: !!thinqPat }
  if (Object.prototype.hasOwnProperty.call(rest, 'bca_config')) {
    out.bca_config = maskSecretKeysDeep(rest.bca_config, { mask: LOCATION_SECRET_MASK })
  }
  return out
}
