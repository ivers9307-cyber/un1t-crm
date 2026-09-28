// ACDEVLOC.1 — the `locations` row as it may cross to the browser from
// /settings/locations/[id].
//
// That page reads the row with select('*') through the service role and hands
// it to client components, which serialises every column into the HTML. The
// two AC vendor credentials are replaced by booleans here: nothing on the page
// needs their values (the AC tab saves through the write-only
// PUT /api/locations/[id]/integrations/ac, which answers has_* flags).
//
// NOT a general secret filter. `settings` (Glofox credentials, the UniFi
// token) still crosses, because the Glofox and UniFi tabs prefill from it and
// write the slice back from the browser; moving those tabs onto the masked
// integrations route comes first (follow-up SECFIX.3).

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
