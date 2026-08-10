// GAPS-P6 — the consent-history CSV.
//
// This is the subject-access-request artefact: the file an operator hands
// over when somebody asks what we have recorded about their consent, and the
// file a regulator would read if we were ever asked to prove we honoured a
// withdrawal. Pure — the route does the tenancy gate and the paging; this
// module only turns rows into bytes, so it can be tested exhaustively without
// a database.
//
// Two decisions worth stating, because both are easy to get wrong quietly:
//
// FORMULA INJECTION is neutralised, not just escaped. A cell beginning =, +,
// - or @ is evaluated by Excel / LibreOffice / Sheets, and RFC-4180 quoting
// does NOT stop that (`"=1+1"` still evaluates). We reuse `csvCell` from
// attendee-csv.js, which prefixes a single quote FIRST and quotes second —
// the ordering matters, since quoting a value that already starts with `=`
// achieves nothing. The dirty fields here are real: `performed_by_name`
// comes from a profile someone typed, `ip_address` from a request header.
//
// THE LEGACY VOCABULARY is folded on read. Rows written before mig 516 spell
// an opt-out 'opted_out'. Normalising here means the export is correct
// whether or not the backfill has been applied, and stays correct for
// anything restored from an older dump — which is the point of the whole
// change: a consent withdrawal must never be invisible because of a spelling.

import { csvCell } from './attendee-csv'
import { normaliseConsentAction } from './consent-actions'

// CRLF, because that is what RFC 4180 specifies and what Excel expects.
const EOL = '\r\n'

export const CONSENT_CSV_HEADER = Object.freeze([
  'recorded_at',
  'channel',
  'action',
  'source',
  'location',
  'performed_by_name',
  'performed_by_email',
  'ip_address',
])

/**
 * Build the consent-history CSV for one contact.
 *
 * @param {{id?:string, first_name?:string, last_name?:string}} _contact
 *   accepted for symmetry with consentCsvFilename; the rows carry everything
 *   the body needs, and repeating the contact's identity on every line would
 *   only add PII to a file that is already about exactly one person.
 * @param {Array<{created_at?:string, channel?:string, action?:string, source?:string,
 *                location_name?:string|null, performed_by_name?:string|null,
 *                performed_by_email?:string|null, ip_address?:string|null}>} rows
 * @returns {string} CSV text, header first, CRLF line endings
 */
export function buildConsentCsv(_contact, rows) {
  const lines = [CONSENT_CSV_HEADER.join(',')]
  for (const r of (rows || [])) {
    lines.push([
      csvCell(r?.created_at),
      csvCell(r?.channel),
      csvCell(normaliseConsentAction(r?.action)),
      csvCell(r?.source),
      csvCell(r?.location_name),
      csvCell(r?.performed_by_name),
      csvCell(r?.performed_by_email),
      csvCell(r?.ip_address),
    ].join(','))
  }
  return lines.join(EOL) + EOL
}

/**
 * Download filename for a contact's consent export. Slugged hard: the name is
 * user-controlled text going into a `Content-Disposition` header, so anything
 * that is not [a-z0-9-] is collapsed to a hyphen — no quotes to break out of
 * the header, no path separators, no non-ASCII.
 * @param {{id?:string, first_name?:string, last_name?:string}} contact
 */
export function consentCsvFilename(contact = {}) {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
  const slug = String(name || contact.id || 'contact')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `consent-log-${slug || 'contact'}.csv`
}
