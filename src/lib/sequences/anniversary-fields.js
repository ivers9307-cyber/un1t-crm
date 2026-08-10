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
 *
 * ANNIVSAFE.1 — joined_at leads the list and lead_created_at's LABEL now says
 * what the column actually is. The label used to read "Lead created date",
 * which describes a field this database does not have: it sounds like the day
 * the lead came in, it sits first in the dropdown, and it is the runner's
 * default, so the plausible option was also the wrong one and the trap that
 * GAPS-P3.1 already sprang once was left armed for the next operator.
 */
export const ANNIVERSARY_FROM_FIELD_OPTIONS = Object.freeze([
  Object.freeze(['joined_at', 'Joined date']),
  Object.freeze(['dob', 'Birthday (date of birth)']),
  Object.freeze(['last_emailed_at', 'Last emailed date']),
  Object.freeze(['lead_created_at', 'CRM import date (not the lead date)']),
])

/**
 * Fields whose dates are not what their name suggests. Selectable, because
 * live sequence rows may already reference them, but never without the UI
 * saying so out loud.
 */
export const UNRELIABLE_ANNIVERSARY_FROM_FIELDS = Object.freeze(['lead_created_at'])

/**
 * The operator-facing explanation, shown whenever an unreliable field is the
 * effective from_field. Kept beside the list so a future addition to one is
 * an obvious omission in the other.
 */
export const UNRELIABLE_ANNIVERSARY_FIELD_WARNINGS = Object.freeze({
  lead_created_at:
    'This is the date the contact row was imported into the CRM, not the date the lead came in. '
    + 'Every one of the 8,509 Stillorgan contacts has it set to the same date as their CRM created date, '
    + 'so an anniversary on it fires for thousands of people at once on the anniversary of a bulk import. '
    + 'Use Joined date for a membership anniversary.',
})

export function isUnreliableAnniversaryFromField(field) {
  return UNRELIABLE_ANNIVERSARY_FROM_FIELDS.includes(field)
}

/**
 * What a NEW anniversary sequence should start on. Deliberately NOT the same
 * constant as DEFAULT_ANNIVERSARY_FROM_FIELD below: this one is the UI's
 * suggestion, written explicitly into trigger_config the moment the operator
 * picks the anniversary trigger, so the saved row never relies on the runner's
 * legacy default. See the note on that constant for why the runner's default
 * is left where it is.
 */
export const SUGGESTED_ANNIVERSARY_FROM_FIELD = 'joined_at'

/**
 * The allowed from_field values. Frozen array rather than a Set because
 * Object.freeze() does not stop Set.prototype.add — a "frozen" Set is a
 * lie, and this list is a security-shaped whitelist.
 */
export const ANNIVERSARY_FROM_FIELDS = Object.freeze(
  ANNIVERSARY_FROM_FIELD_OPTIONS.map(([value]) => value),
)

/**
 * Default when trigger_config.from_field is unset (legacy sequence rows).
 *
 * STILL lead_created_at, and deliberately NOT changed by ANNIVSAFE.1. Changing
 * it is a live behaviour change on rows nobody is looking at: every existing
 * anniversary sequence saved without a from_field would silently start firing
 * off a different column on the next cron tick, re-dating cohorts that are
 * mid-flight and re-triggering people whose joined_at anniversary has passed
 * but whose import anniversary has not (source_ref is
 * `${from_field}:${days_after}:${year}`, so the dedup key changes too and the
 * re-fire is not even caught). Nobody would see it happen; the first symptom
 * would be a send.
 *
 * The trap is closed at the other end instead: SequenceSettings writes
 * SUGGESTED_ANNIVERSARY_FROM_FIELD into trigger_config the moment the trigger
 * is picked, so no NEW sequence reaches this default, and any sequence that
 * does land here renders the warning above. If the remaining legacy rows are
 * ever audited and found to be zero or safe, this can move to 'joined_at' as
 * its own deliberate change.
 */
export const DEFAULT_ANNIVERSARY_FROM_FIELD = 'lead_created_at'

export function isAnniversaryFromField(field) {
  return ANNIVERSARY_FROM_FIELDS.includes(field)
}
