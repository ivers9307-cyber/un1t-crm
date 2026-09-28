// ACDEVLOC.1 — the `locations` row as /settings/locations/[id] passes it in
// its `location` PROP.
//
// That page reads the row with select('*') through the service role and hands
// it to client components, which serialises every column into the HTML. The
// two AC vendor credentials are replaced by booleans here: nothing on the page
// needs their values (the AC tab saves through the write-only
// PUT /api/locations/[id]/integrations/ac, which answers has_* flags).
//
// Scope, precisely: this keeps the key and PAT out of the `location` prop
// ONLY. They still reach the browser through the `user` object:
// getCurrentUser() loads full `locations` rows, and the page and AppShell
// pass `user` to client components. That leak is follow-up C35 SECFIX.3.
//
// NOT a general secret filter either. `settings` (Glofox credentials, the
// UniFi token) still crosses in this prop too, because the Glofox and UniFi
// tabs prefill from it and write the slice back from the browser; moving
// those tabs onto the masked integrations route is also SECFIX.3.

export const LOCATION_SECRET_COLUMNS = Object.freeze(['sensibo_api_key', 'thinq_pat'])

/**
 * @param {object|null} row  a `locations` row
 * @returns {object|null}    the row without the AC credentials, plus
 *                           has_sensibo_key / has_thinq_pat
 */
export function toClientLocation(row) {
  if (!row || typeof row !== 'object') return row
  const { sensibo_api_key: sensiboApiKey, thinq_pat: thinqPat, ...rest } = row
  return { ...rest, has_sensibo_key: !!sensiboApiKey, has_thinq_pat: !!thinqPat }
}
