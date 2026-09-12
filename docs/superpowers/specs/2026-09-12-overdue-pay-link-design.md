# Overdue payment reminders carry a Glofox pay link — design

**Date:** 2026-09-12
**Status:** approved by Richard in conversation, 2026-09-12
**Follows:** DUNNING.1–.7 (PR #1502), GLOFOX-SPEC-2026-09 (PR #1681)

## Why

The overdue-payment reminder automation (gallery template `overdue_payment_dunning`) tells a member whose membership payment failed to "update your card in the Glofox app". On 2026-09-12 a live probe showed that Glofox's `POST /v3.0/payment-links/invoices/{invoiceID}` returns a hosted payment page for the exact overdue invoice when called with our three integration headers plus `x-glofox-impersonated-member-id: <member id>`. Verified on a real €209 overdue renewal: `is_retriable: true`, `invoice_payment_link: https://pay.glofox.com/payment-collector/v2/#/i/<invoice_id>`, amount in cents, a human summary. The reminder can therefore carry a one-tap "Pay now" instead of asking the member to find the card screen in an app.

## Decisions (Richard, 2026-09-12)

1. **Direct Glofox link.** The WhatsApp button and the email link open `pay.glofox.com` directly. No CRM redirect. If Meta refuses a URL-button base containing `#/i/`, a CRM redirect (`/pay/<token>`) is the documented fallback, built as a follow-up, not now.
2. **WhatsApp and all three emails** carry the link. Emails need no Meta approval, so that half is live the moment the updated gallery template is installed.
3. **New WhatsApp template copy** (Richard's approval, Garrett's voice kept): body `Hi {{1}}, Garrett from UN1T here. Your membership payment of {{2}} didn't go through. You can pay it now with the button below, or update your card on file if you'd prefer. Thanks`, one URL button labelled `Pay now`, base `https://pay.glofox.com/payment-collector/v2/#/i/{{1}}`.
4. **Richard submits the template to Meta** himself in the CRM's WhatsApp → Templates editor. Name `outstanding_payment_link_` (trailing underscore, the house convention), category UTILITY, language `en`, example values: `{{1}}` = `Julie`, `{{2}}` = `€209`, button example = a real invoice id.
5. **Fetch once when the run starts** (approach A). One Glofox call per overdue run, stored on the run. Steps never call Glofox.

## Design

### 1. Glofox client helper — `src/lib/glofox.js`

`getGlofoxInvoicePaymentLink(creds, { memberId, invoiceId })` → `{ ok, status, retriable, link, amountCents, currency, summary, invoiceId, error }`.

- `memberId` must be a 24-hex Glofox id (the existing `GLOFOX_OBJECT_ID_RE`); `invoiceId` a non-empty string of at most 200 characters. Anything else → `{ ok: false, status: 400, error: 'INVALID_ARGS' }` with no call made.
- `POST /v3.0/payment-links/invoices/{invoiceId}` via `glofoxFetch` with `Content-Type: application/json` and `x-glofox-impersonated-member-id: memberId`, empty JSON body.
- 2xx with `is_retriable: true` → `ok: true, retriable: true, link, amountCents, currency, summary`.
- 2xx with `is_retriable: false` → `ok: true, retriable: false, link: null` (the invoice cannot be paid by link right now; Glofox's own retry may be mid-flight).
- Non-2xx → `ok: false, status, error: 'Glofox HTTP <n>'`. A thrown fetch → `ok: false, status: 0, error: <message>`. Never throws.

### 2. Run payment metadata — new `src/lib/dunning-payment.js`

Pure helpers plus one IO function, kept out of `dunning.js` so the manual reminder route and the webhook path share one implementation.

- `paymentRunMetadata(linkResult, { invoiceId, now })` (pure) → `{ invoice_id, link, amount, currency, retriable, fetched_at, error }`. `amount` is display text from `formatMoneyMinor(amountCents, currency)` (`€209`, `€29.50`), `''` when unknown. `link` is `null` unless `ok && retriable`.
- `capturePaymentForRun(db, { locationId, contactId, invoiceId, glofoxUserId })` (IO) → `{ payment }` where `payment` is the object above. Resolves credentials with `glofoxCredentialsForLocation`; the member id is `glofoxUserId` when given, else `contacts.glofox_member_id`. Missing creds, missing member id, or a helper failure all produce a `payment` with `link: null` and `error` set. Never throws; logs a warning on failure.
- `paymentFromEnrollment(enrollment)` (pure) → the `payment` object from `enrollment.metadata.payment`, or `null`.
- `paymentCtaHtml(payment)` (pure) → the sentence fragment the emails splice in. With a link: `<a href="LINK">pay it now here</a>, it takes a few seconds, or update your card in the Glofox app`. Without: `update your card in the Glofox app`. The link is HTML-escaped.
- `payAmountPhrase(payment)` (pure) → `' of €209'` (leading space) or `''`.

### 3. Enrolment carries run metadata — `src/lib/sequences/enrol.js`

`enrolContacts` gains an optional `metadata` object. On insert it is written as the row's `metadata`. On DUNNING.2 re-activation it is merged as `{ ...prevMeta, ...metadata, previous_runs }`, so `previous_runs` is always preserved and a stale `payment` from an earlier run is replaced. No change when omitted.

### 4. Both entry points capture the payment

- **Webhook (automatic):** `maybeEnrolDunning(db, locationId, contactId, { invoiceId, isMembership, glofoxUserId })` calls `capturePaymentForRun` after every existing gate passes and just before `enrolContacts`, and passes `metadata: { payment }`. The webhook route passes `glofoxUserId: ltvResult.glofox_user_id ?? null` (falls back to the contact's linked id inside the capture). A failed capture never blocks the enrolment.
- **Manual (Send payment reminder):** `src/app/api/churn-radar/action/route.js` already reads the contact's PAST_DUE invoices; the select gains `invoice_date, glofox_user_id`, the newest PAST_DUE membership invoice (by `invoice_date` desc) is chosen, and `capturePaymentForRun` runs with its id. `source_ref` stays `payment_<kind>` (the DUNNING.2 re-run semantics are unchanged); the invoice id lives in `metadata.payment.invoice_id`.

### 5. WhatsApp step — `src/lib/whatsapp.js`, `src/lib/sequences/steps.js`

- `resolveContactField` (whatsapp.js) gains two reserved names resolved from `opts.payment`, never from the contact: `pay_amount` → `payment.amount`, `pay_link_suffix` → `payment.invoice_id`. Both are `''` when there is no payment. Existing names and the literal fallback are unchanged.
- `sendWhatsappStep` derives `payment = paymentFromEnrollment(enrollment)` and passes `{ payment }` in the opts to both `buildTemplateComponents` and `renderTemplateBody`.
- **Skip rule:** if the step's `whatsapp_variables[url_button] === 'pay_link_suffix'` and `payment?.link` is empty, the step is a recorded skip (`recordStepSkip`, reason `no payment link for this invoice`) and returns `null`. Meta would reject a dynamic-URL template sent without its suffix, and a button that opens an unpayable invoice is worse than no message. The run continues to its email steps.

### 6. Email steps — `src/lib/postmark.js`, `src/lib/sequences/steps.js`

`applyMergeTags` gains `{{pay_amount_phrase}}` and `{{payment_cta}}` from `extras`. `sendEmailStep` supplies them from `paymentFromEnrollment(enrollment)` via `payAmountPhrase` and `paymentCtaHtml`. Runs with no payment render the old wording, so no email ever contains an empty link.

### 7. Gallery template — `src/lib/sequence-templates.js`

`overdue_payment_dunning` changes in place (same id, same step shape and delays):

- Both WhatsApp steps: `whatsapp_template_name: 'outstanding_payment_link_'`, `whatsapp_variables: { '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' }`.
- All three emails use `{{pay_amount_phrase}}` after "membership payment" and `{{payment_cta}}` in place of the "update your card in the Glofox app" clause. Copy stays low-key, no em-dashes, no emoji (the existing pinned test).
- Description mentions the "Pay now" button and that the WhatsApp template must be approved first.

### 8. Install guard — `src/lib/sequences/template-install.js`, `src/app/api/sequences/from-template/route.js`

New pure `missingWhatsappTemplateNames(steps, rows)` returns the distinct names a gallery template asks for that are not APPROVED at the location. The install route calls it after loading the location's templates and, when non-empty, deletes nothing (nothing has been inserted yet) and returns **409** with `WhatsApp template "outstanding_payment_link_" is not approved at this location yet. Create it under WhatsApp → Templates, wait for Meta's approval, then install.` This replaces the previous behaviour of installing with a null template id.

### 9. Rollout

1. Richard installs the CURRENT gallery version today (already walked through) so reminders start.
2. Richard creates `outstanding_payment_link_` in WhatsApp → Templates and submits it. The CRM's template webhook records the approval.
3. Once APPROVED, install the updated gallery template (a second automation), Publish it, pick it under Churn radar → Payment reminders, and pause the first one. Runs already in flight finish on the old automation.

### 10. Testing

TDD throughout. Unit tests, written first: the Glofox helper (happy, not retriable, 403, invalid args, network), `dunning-payment.js` pure helpers and the capture (creds missing, member id fallback, helper failure), `enrolContacts` metadata on insert and on re-activation, `maybeEnrolDunning` passing `metadata.payment`, the two reserved WhatsApp names, the URL-button skip rule, the email tags with and without a payment, the gallery pins, and the install guard. Live check after merge: the helper against the same €209 invoice (already known to answer), read-only.

## Out of scope

- A CRM redirect page for the pay link (only if Meta rejects the button base).
- Showing the pay link on the churn radar or contact drawer.
- Any change to the Xero side or to how `glofox_invoices` is kept fresh.
