# Overdue membership payment → card-update reminders — design

**Date:** 2026-08-23 · **Status:** approved (Richard: transactional lane yes, 3 touches) · **Ticket prefix:** DUNNING

## Problem

Richard: "once a member lands in the Overdue category, send them a WhatsApp
and an email reminding them to update their card."

The machinery exists and has been dormant since July (GLOFOX-REACTIVE,
PR #994, mig 428):

- `INVOICE_UPDATED` → `PAST_DUE` calls `maybeEnrolDunning` (`src/lib/dunning.js`),
  which enrols the contact into the location's `dunning_sequence_id` when
  `locations.dunning_auto_enroll` is true; `PAID` / `FORGIVEN` call
  `exitDunningForContact`; a membership pause exits too.
- `dunning_auto_enroll` has **no UI** — only the column. No location has a
  dunning sequence set. Nothing has ever fired.
- Gallery template `overdue_payment_dunning` (email + SMS) uses the retired
  `segment_added` "Membership State = locked" model.
- An approved **UTILITY** WhatsApp template exists at Stillorgan:
  `outstanding_payment_` — "Hi {{1}}, Garrett from UN1T here. Your membership
  payment is outstanding, could you please update your card on file. Thanks".

Three things are wrong for the Overdue rule shipped this morning (PR #1501):

1. It fires on **any** `PAST_DUE` invoice. A €5 late-cancel fee would start
   "update your card" reminders. It must fire only for a membership payment
   (`isMembershipInvoice`, the Overdue category).
2. It exits on **any** `PAID` invoice. A member with a failed renewal who then
   pays a €5 fee would have their reminders cancelled.
3. Sequence email and WhatsApp steps gate on **marketing** consent
   (`contact_location_preferences.email_marketing` / `whatsapp_marketing`).
   A card-update reminder is a service message about the member's own
   account. Of 190 subscription members at Stillorgan, 28 have opted out of
   marketing email and 8 of WhatsApp marketing; under the marketing gate they
   would silently never be reminded.

And one engine constraint: `sequence_enrollments` carries a FULL unique index
on `(sequence_id, contact_id)` — one enrolment per contact per sequence ever
(ENROLDEDUP.1, PR #1480, deliberately kept). A member whose card fails again
in three months could never be reminded again.

## Design

### 1. Trigger and exit follow the Overdue category

`applyInvoiceWebhook` (`src/lib/glofox-invoices.js`) returns
`is_membership: isMembershipInvoice(parsed)` alongside `invoice_status`.

Webhook 7b (`src/app/api/webhooks/glofox/route.js`):

- `PAST_DUE` → `maybeEnrolDunning(db, locationId, contactId, { invoiceId, isMembership })`.
  `maybeEnrolDunning` returns `{ enrolled: 0, reason: 'not_membership_invoice' }`
  unless `isMembership === true` (fail closed — undefined never enrols). The
  existing guards stay: auto-enrol on, sequence set/active/at this location,
  member not paused, `paymentTroubleKind` confirms a member.
- `PAID` / `FORGIVEN` → `exitDunningForContact` **only when `is_membership`**.
  A settled fee never touches an in-flight reminder run.
- Pause exit unchanged.

Manual "Send payment reminder" (`/api/churn-radar/action`): the server-side
"is behind" check now looks for a `PAST_DUE` **membership** invoice
(`line_item_subtypes` / backfill `glofox_event` via `isMembershipInvoice`), not
any `PAST_DUE`. The button renders on the Overdue tab only (not Unpaid
charges / Awaiting authorization), since the copy says "membership payment".

### 2. Re-runs: re-activate the terminal enrolment (dunning paths only)

`enrolContacts` gains an opt-in `allowReenrol` flag. Default behaviour is
byte-identical (the ENROLDEDUP.1 decision stands for every trigger, cron,
segment and sweep). With `allowReenrol: true`:

- Tier 1 (active → skip) unchanged.
- Tier 2: a contact with a terminal (`completed` / `exited`) row that is
  **outside** the sequence's `re_enrolment_cooldown_days` is **re-activated**
  in place instead of inserted (which would hit the unique index):
  `status='active', current_step_order=0, next_step_at=now, enrolled_at=now,
  exit_reason=null, completed_at=null, exited_at=null, last_error=null,
  error_count=0, last_processed_at=null, source_type, source_ref`, and
  `metadata.previous_runs[]` appended with the prior run's
  `{ source_type, source_ref, status, enrolled_at, ended_at, exit_reason }`.
  The UPDATE is guarded with `.eq('status', <terminal status read>)` so a
  concurrent activation cannot be clobbered.
- Same-invoice guard: if the new `sourceRef` equals the terminal row's
  `source_ref`, do **not** re-run (Glofox re-sends `PAST_DUE` on every retry
  of one invoice — subscription dunning reuses the invoice id). A null
  `sourceRef` (operator click) always qualifies.
- A contact inside the cooldown, or with no cooldown configured on the
  sequence, is skipped exactly as today.
- Returns `{ enrolled, skipped, reactivated }`; `increment_sequence_enrolled`
  counts re-activations.

Only two callers pass `allowReenrol: true`: `maybeEnrolDunning` and the manual
`payment_reminder` action. Pure helper `planReenrolments(history, cooldownDays,
sourceRef, nowMs)` in `src/lib/sequences/cooldown.js` decides per contact:
`'blocked' | 'same_source' | 'reactivate'`.

### 3. Transactional lane — derived from how they were enrolled

A dunning enrolment is a service message regardless of which sequence it
points at, so the flag is a property of the **enrolment**, not the sequence
(which also means an operator cannot mark a promo sequence "transactional").

`src/lib/sequences/steps.js`:

```js
export const TRANSACTIONAL_SOURCE_TYPES = Object.freeze(['invoice_past_due', 'churn_radar'])
export function isTransactionalEnrolment(enrollment)  // source_type ∈ the set
```

(`'churn_radar'` is used by exactly one caller today: the payment-reminder
click. `'invoice_past_due'` is the webhook path.)

For a transactional enrolment:

- **Email step**: skips the `email_marketing !== true` gate and the frequency
  cap. Keeps: location feature gate, **must be on the location's list** (row
  present — "row absent = may never send"), `email_status` not
  bounced/complained, not `email_suppressed_at`, has an email.
- **WhatsApp step**: resolves the template first; when its `category` is
  `UTILITY`, skips the `whatsapp_marketing !== true` gate and the frequency
  cap. Keeps: feature gate, on the location's list, has `wa_phone`,
  `wa_status` not opted_out/blocked/undeliverable, template APPROVED and at
  the sequence's location. A **MARKETING**-category template keeps the
  marketing gate even inside a transactional enrolment.
- SMS step unchanged (the template no longer uses it).

Skip reasons are recorded as today so run history shows why someone was not
messaged.

### 4. Operable from the churn-radar settings card

`GET/PUT /api/churn-radar/dunning-settings` gains `dunning_auto_enroll`
(boolean). PUT with `dunning_auto_enroll: true` and no sequence (after applying
the same request's `dunning_sequence_id`) → 400. The settings card in
`ChurnRadar.jsx` gets a checkbox under the picker: "Start reminders
automatically when a membership payment fails", with a one-line explanation
that fees and class packs never trigger it, paid/forgiven stops it.

### 5. The gallery template becomes the ready-made automation

`overdue_payment_dunning` in `src/lib/sequence-templates.js` is rewritten:

- name "Overdue membership payment → card update reminders",
  `trigger_type: 'manual'` (the dunning picker lists manual sequences only;
  auto-enrol and the radar button enrol directly), `re_enrolment_cooldown_days: 14`,
  send window 9–19 every day.
- Steps (each step's delay is relative to the previous step; the first step
  fires on the next scheduler tick):
  1. `wait` — 0 (anchor)
  2. `whatsapp` — +1h, `whatsapp_template_name: 'outstanding_payment_'`, `whatsapp_variables: { '1': 'first_name' }`
  3. `email` — +0, "A quick heads-up about your payment"
  4. `email` — +3d, "Still no luck with your membership payment"
  5. `whatsapp` — +4d (day 7), same template
  6. `email` — +0, "Action needed to keep your UN1T membership"

  The one-hour wait lets Glofox's own quick retry succeed first — a `PAID`
  webhook in that hour exits the run before anything sends.
- Copy: low-key, no em-dashes, no emoji. The WhatsApp copy is the approved
  template's and cannot be edited without Meta re-approval; the emails are
  editable in `/automations`.
- Installer (`/api/sequences/from-template`): a step with
  `whatsapp_template_name` resolves to the location's APPROVED
  `whatsapp_templates` row of that name → `whatsapp_template_id`. Not found →
  `null`; the pre-publish validation flags "WhatsApp needs a template" and the
  operator picks one. The 14-day cooldown only means anything through
  `allowReenrol` (section 2); for every other caller it behaves as before.

### Go-live at Stillorgan (operator, after deploy)

1. `/automations` → Templates → install "Overdue membership payment → card
   update reminders" → review copy → **Activate**.
2. Churn radar → settings card → pick it as the reminder sequence → tick
   "Start reminders automatically" → Save.
3. The seven members in Overdue today: click "Send payment reminder" on each
   row (the trigger is event-driven; Glofox's next retry would also catch
   most of them).

### Out of scope

- Changing the unique index (ENROLDEDUP.1 stands).
- A bulk "remind everyone overdue" button (seven clicks today; YAGNI).
- A transactional-email footer variant (the unsubscribe footer stays).
- Mobile: no surface.
- No migration: `dunning_auto_enroll` (mig 428) and `metadata` already exist.

## Testing

- `dunning.test.js`: non-membership invoice never enrols (including undefined);
  membership invoice enrols with `allowReenrol: true` and
  `sourceType 'invoice_past_due'`; existing guards unchanged.
- Webhook route: `PAID` for a fee does not exit; `PAID` for a membership
  invoice exits (unit test on the 7b decision via a small pure helper
  `dunningActionFor(invoiceStatus, isMembership)` → `'enrol' | 'exit' | null`).
- `cooldown.test.js`: `planReenrolments` — inside cooldown → blocked; outside →
  reactivate; same `sourceRef` → same_source; null sourceRef → reactivate; no
  cooldown configured → blocked.
- `enrol.test.js`: `allowReenrol` re-activates via UPDATE with the status
  guard, appends `metadata.previous_runs`, bumps the counter; default path
  untouched.
- `per-location-consent.test.js`: transactional enrolment + opted-out email →
  SENDS; not on the list → SKIPS; bounced → SKIPS. Transactional + UTILITY
  WhatsApp + opted-out marketing → SENDS; MARKETING template → SKIPS;
  `wa_status` opted_out → SKIPS.
- `frequency-cap-steps.test.js`: transactional enrolment ignores the cap.
- `sequence-templates.test.js`: the template is manual, 6 steps in the order
  above, cooldown 14, both WhatsApp steps name `outstanding_payment_`, no
  em-dashes in any email body.
- `from-template` resolution: pure `resolveWhatsappTemplateIds(steps, rows)`.
- `radar action`: the membership-invoice check (pure helper + route test if a
  harness exists).
- Dunning settings route: PUT rejects auto-enrol without a sequence.
