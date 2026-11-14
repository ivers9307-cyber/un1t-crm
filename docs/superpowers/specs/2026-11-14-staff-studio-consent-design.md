# Staff switch for per-studio marketing email consent (STAFFCONSENT.1) — short design

Branched off `origin/main` at `a92e29257`.

## Why

A person who unsubscribes from one studio's marketing email (one-click
unsubscribe or the preference centre) can today only be switched back on by
themselves, through the preference centre link in their own emails. Staff have
no way to do it when a member asks at the desk, by phone or by email. Found on
14 Nov 2026 when Richard's own test addresses could not be re-subscribed
without the recipient's private preference-centre key.

The existing staff switch on the contact page (`ContactMarketingPreferencesCard`,
`PATCH /api/contacts/[id]/marketing-preferences`) changes only the overall
`contact_preferences` setting. A studio opt-out lives in
`contact_location_preferences`, so that switch cannot undo it.

## What Richard decided (14 Nov 2026)

- Staff switch the studio setting **directly**, and **must give a reason**. No
  confirm-by-email step.

## Calls Claude made (stated to Richard before writing this; not objected to)

- **Who:** owners and managers at that studio, and masters — `ADMIN_ROLES` at
  the studio, the same people as the existing staff switch.
- **Both directions:** staff can switch a studio off as well as on, with a
  reason either way.
- **Reasons:** a fixed list — `in_person`, `phone`, `email`, `signed_form`,
  `other` — plus an optional note, required when the reason is `other`
  (at most 500 characters).
- **Linked addresses:** the CRM copies an opt-out to a person's other
  addresses (`propagateOptOut`) but never an opt-in. A staff re-subscribe
  changes only the contact it is done on. A staff opt-out follows the existing
  opt-out propagation, like every other opt-out.
- **A migration** adds `reason text` and `note text` to `consent_log`
  (nullable; nothing else writes them).

## Approaches considered

1. **A per-studio row with its own switch in the consent card, saved through a
   new staff route that calls the existing per-studio consent function.**
   Chosen: one set of consent rules for forms, preference centre and staff.
2. Extend the existing overall staff switch to also write per-studio rows.
   Rejected: it mixes the overall and per-studio settings on one control.
3. Call the preference centre route from staff screens. Rejected: it is keyed
   to the person's private token, which staff must never handle.

## The design

- **Card:** `ContactMarketingPreferencesCard` lists each studio the contact
  has a `contact_location_preferences` row for, with that studio's email
  marketing state. For a studio where the viewer holds `ADMIN_ROLES` (or is
  master), the row has a switch. Switching opens a small dialog: the reason
  list, the note, and Save / Cancel. Studios the viewer cannot act at are shown
  read-only. Only email marketing is in scope (not SMS or WhatsApp).
- **Route:** `POST /api/contacts/[id]/studio-consent` with
  `{ location_id, email_marketing: boolean, reason, note? }`. Session only.
  Checks, in order: signed in; `ADMIN_ROLES` at `location_id` (or master);
  the contact is readable at that studio (homed there or holding a
  `contact_studios` row there); otherwise the ordinary not-found. Validates the
  reason list and the note rule. A no-op (already in that state) returns
  success with no write and no log row.
- **Write:** through the shared per-studio function the forms use
  (`applyFormMarketingConsent` in `src/lib/marketing-consent.js`), extended
  to accept `performedBy`, `reason` and `note`, so the `contact_location_preferences`
  row, the `consent_log` row (with `location_id`, `performed_by`, `reason`,
  `note`) and the email-reputation rule are exactly the forms' behaviour. A
  write error is surfaced, never reported as success.
- **Source:** a new `consent_log.source` value `staff_studio`, registered in
  `src/lib/consent-sources.js` as voluntary (staff acting on the person's
  stated request), so list-health reporting classifies it.
- **Docs:** CLAUDE.md's consent invariant names this route among the consent
  writers.

## Non-goals

SMS and WhatsApp consent; bulk changes; changing the overall
`contact_preferences` switch; a re-subscribe email to the person; any change to
the preference centre or one-click unsubscribe.

## Anti-goals

- A studio switched on with no reason recorded.
- Staff at one studio changing another studio's consent.
- Any staff screen or route touching the person's preference-centre token.

## Left to the builder

Component layout and wording; the exact shape of the shared function's new
arguments; the migration number (next free after the latest on main).

## Rollout

Apply the migration before the deploy. Then re-subscribe Richard's two test
addresses at Stillorgan with reason "email" as the first live use.
