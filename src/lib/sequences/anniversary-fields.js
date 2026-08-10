// GAPS-P3.2 — the ONE list of contact date fields an anniversary
// sequence may fire from.
//
// Three places need it and they used to hold three copies:
//   - runAnniversaryTriggers (./cron-triggers.js) rejects anything
//     outside it with a logged error and skips the sequence;
//   - the "Anniversary of" dropdown in
//     src/components/sequences/SequenceSettings.jsx offers it;
//   - the packaged recipes in src/lib/sequence-templates.js drive it.
// A name that got into one copy and not the others produced a sequence
// the cron refuses to run: an error line per tick, forever, and no UI
// symptom at all. Tests now hold all three against this module.
//
// WHY ITS OWN FILE rather than an export from cron-triggers.js: that
// module imports createServerClient, ./enrol.js and ./audience.js at
// module scope, so a 'use client' component importing the constant from
// there would drag the service-role Supabase client and the whole
// sequence engine into the browser bundle. This file has NO imports, on
// purpose — same reasoning as ./tag-vocabulary.js.

/**
 * [value, label] pairs in the order the settings dropdown shows them.
 * Every value must be a real column on public.contacts that
 * runAnniversaryTriggers can query.
 *
 * Coverage notes (live Stillorgan figures, 2026-08-09) that decide which
 * field a recipe should pick:
 *   - joined_at       — set for 98% of contacts; the real membership
 *                       start date. This is the right field for a
 *                       membership anniversary.
 *   - lead_created_at — POISONED. It is the CRM row-import timestamp:
 *                       its date equals created_at's date for all 8,509
 *                       contacts, so an anniversary on it fires for
 *                       thousands of people at once on the anniversary
 *                       of a bulk import. Kept selectable only because
 *                       live sequences may already reference it (and the
 *                       runner still defaults to it when from_field is
 *                       unset); no packaged recipe may use it.
 *   - last_emailed_at — moves every send, so it only makes sense with a
 *                       short days_after.
 *   - dob             — on file for a minority of contacts; matched on
 *                       month+day, any birth year.
 */
export const ANNIVERSARY_FROM_FIELD_OPTIONS = Object.freeze([
  Object.freeze(['lead_created_at', 'Lead created date']),
  Object.freeze(['last_emailed_at', 'Last emailed date']),
  Object.freeze(['joined_at', 'Joined date']),
  Object.freeze(['dob', 'Birthday (date of birth)']),
])

/**
 * The allowed from_field values. Frozen array rather than a Set because
 * Object.freeze() does not stop Set.prototype.add — a "frozen" Set is a
 * lie, and this list is a security-shaped whitelist.
 */
export const ANNIVERSARY_FROM_FIELDS = Object.freeze(
  ANNIVERSARY_FROM_FIELD_OPTIONS.map(([value]) => value),
)

/** Default when trigger_config.from_field is unset (legacy sequence rows). */
export const DEFAULT_ANNIVERSARY_FROM_FIELD = 'lead_created_at'

export function isAnniversaryFromField(field) {
  return ANNIVERSARY_FROM_FIELDS.includes(field)
}
