# Late-cancel & no-show fees for un1t.online studios (FEES.1 → FEES.2)

## Context

Hatch Street (and any studio with `membership_source = 'un1t_online'`) has no way to enforce its late-cancellation or no-show policy. un1t.online records the outcome (`un1t_bookings.status` = `cancelled` / `no_show`) but nobody acts on it, and un1t.online itself has no "late cancel" status or fee.

The operating model you asked for:
- **23:00 every night (studio time):** pull the day's no-shows and late cancellations for every class.
- **Email a designated contact** with a direct link to the list of people who will be charged.
- **That page lets staff waive** any fee.
- **17:00 the next day:** every fee not waived is charged to the member's stored payment method in un1t.online.
- **Penalty depends on plan:** credit-pack members lose the credit; unlimited/membership members pay a cash fee.

What exists today (from exploration):
- **Mirror data:** the 15-minute `un1t-online-sync` mirrors bookings into `un1t_bookings` (status, `credit_charged`, `remote_updated_at`) and classes into `un1t_events.starts_at`.
- **No cancel time:** nothing stores *when* a booking was cancelled, and that time is what makes a cancel "late".
- **Write rules:** un1t.online writes live only in `src/lib/un1t-online-write.js` + `src/lib/un1t-online-write-ops.js`. Two guard tests (`tests/un1t-online-write-guard.test.js`, `tests/mia-no-charge-no-refund-guard.test.js`) and spec §4 of `docs/superpowers/specs/2026-10-17-un1t-online-write-back-design.md` currently **forbid charging a card for anything but the €0 trial**.
- **This feature deliberately lifts that rule, for one op only.** That is your decision to make, and it is the first thing the plan records.
- **CRM never acts on Hatch bookings:** `src/lib/class-booking-platform.js` (`crmMayActOnClassBooking`) stops the CRM reminding, rewarding or messaging on Hatch bookings. Fees read the `un1t_*` mirror directly, not `class_bookings`, so that rule stays intact.

---

## Phase 0: confirm the un1t.online contract (blocking, ~½ day)

Nothing in the repo documents a saved-card charge or un1t.online's own cancel policy. Before building, confirm with un1t.online / the OpenAPI spec:

1. **Charging the stored card.** Preferred: create two products in the Hatch un1t.online console, **"Late cancellation fee"** and **"No-show fee"**. Then charge them with the endpoint already in our allowlist, `POST /purchases/charge {userId, productId}`.
   - The price stays operator-editable in un1t.online.
   - The charge appears in un1t.online's own transactions and receipts.
   - No new endpoint is needed.
   - Fallback: `/purchases/charge-custom`, whose contract we'd need.
2. **What `/purchases/charge` returns** when there is no saved card, when the card is declined, and when SCA is required.
3. **Pack members.** Does un1t.online already keep the credit on a late cancel or no-show (`credit_charged` stays true)? If yes, the credit forfeit is native and the CRM only records it. If no, we need a credit-deduct endpoint (not in scope until confirmed).
4. **Cancel timing.** Does the booking payload carry a cancel timestamp, or does `remote_updated_at` move on cancel? This decides how the CRM spots a late cancel.
5. **Who cancelled.** Is there a field for "who cancelled" (member vs staff)? Staff cancels must never be fined.

### Decision (28 Oct 2026): charge a custom amount, not a fee product

**What changes.** Use un1t.online's **"Charge custom amount"** (`POST /purchases/charge-custom`), the same action as the console's ⋯ menu, instead of the fee-product approach. The fee products and the `/purchases/charge` route for fees are dropped.
- **Description.** Every charge carries a description naming the class, for example: `Late cancellation: HYROX Engine, Tue 28 Oct 2026, 18:30` or `No-show: Strength, Mon 27 Oct 2026, 07:00`.
  - The class name comes from `un1t_events`.
  - The day and time are rendered in the studio's zone.
  - The member sees the same text on the review page, in the email and on their un1t.online receipt.
- **Amounts become CRM settings:** `late_cancel_fee_cents` and `no_show_fee_cents` per studio, operator-editable, shown on the review page. The price-changed check compares the amount staff saw with the amount sent.
- **Rule change.** `charge-custom` is banned by name today, in `tests/un1t-online-write-guard.test.js` (the banned-literal list and the "nowhere in src/" test) and in spec D §3.
  - FEES.1 allows it in exactly one place: the transport `ENDPOINTS` table plus a new `chargeClassFee` op, with `policy: 'verify'` and an idempotency key derived from the fee row id.
  - Every other mention stays banned, and the Mia guard still forbids any agent import of the op.
  - `/purchases/charge` stays limited to `grantTrial`.
  - The ledger `method` CHECK gains `charge_custom`.
### The contract (from the dev docs, `https://api-dev.un1t.online/docs-json`, "UN1T API 2.0", read 28 Oct)

- **`POST /purchases/charge-custom`**, permission `purchases:create`. Our prod token holds it.
  - Header `idempotency-key` is **required**.
  - Body `ChargeCustomDto`: `userId`\*, `amount`\* (integer, minimum 0), `currency`, `description`, `paymentMethodId` (when left out, un1t.online uses the member's default card).
  - Success is 201 `{ success: true, data: { transactionId } }`. **No error responses are documented.**
  - `amount` has no stated unit. Transactions are integer cents, so it is treated as cents, and the €1 test sends `100` to prove it.
- **Idempotency makes a resend safe.** The key is the fee row id, so a lost reply can be re-sent with the *same* key without a double charge.
  - The policy stays `verify`: read first, resend only when the read says `absent`. It is no longer "never resend".
- **Dedupe and reconcile reads.** `GET /transactions` returns `description`, `initiated_by`, `amount` and `stripe_payment_intent_id`.
  - The sync starts mirroring `description` onto `un1t_transactions`. A fee is "landed" when a transaction for that user has our exact description and amount.
- **Check for a card before charging.** `GET /payment-methods/client/{userId}` (`payment_methods:read`, held) returns `is_default`, `is_expired`, `last4` and `brand`.
  - With no usable card, the row goes straight to `failed: NO_CARD`, with no charge attempt. The review page shows the card status the night before, so staff can see who will fail.
- **Fallbacks the API also offers (for Phase 2):**
  - `POST /purchases/charge-custom/link` (emailed payment link) and `POST /payment-methods/client/{userId}/setup-requests` (emailed add-a-card link) exist, but **Richard ruled both out (28 Oct)**: the CRM never emails members a payment or card link for a fee.

- **Other useful pieces:**
  - **`POST /bookings/{id}/return-credit`** exists. A credit coming back on a late cancel therefore means staff returned it by hand, which confirms the "staff-excused" signal.
  - **`EventResponseDto.late_cancel_count`** and `/studios/{id}/analytics/attendance` `late_cancels` show un1t.online counts late cancels itself. On prod today the field comes back `null` (checked on 3 classes), so prod may be behind dev.
  - **`auto_attend_at`** on events, null at Hatch today. If Hatch turns auto-attend on, un1t.online marks people attended automatically, and no-shows would then only be the ones coaches mark.
  - `BookingCancelDto` is still only `forceRefund`. Neither booking DTO has a cancel time or a "cancelled by" field.
- **Proven on prod, 28 Oct 2026 14:32 UTC.** Richard ran the charge against his own Hatch account (default Mastercard ending 2613), idempotency key `fees-probe-richard-001`.
  - **The response:** HTTP 201 `{"success":true,"data":{"transactionId":"a85a637a-c52e-4b7c-a2f8-06d93a07aa4d"}}`.
  - **`GET /transactions/{id}` shows:**
    - `type: 'manual'`, `product_type: 'manual'`, `product_id: null`, `invoice_id: null`;
    - **`amount: 100`, `currency: 'eur'`, so the amount is in cents;**
    - **`description` stored exactly as sent;**
    - a Stripe payment intent was created;
    - `refunded: false`;
    - `initiated_by` is the API token's user (`b98cebb6-…`), so every CRM-made charge is identifiable.
  - **Consequences for the build:**
    - The mirror must keep `description` and `initiated_by`.
    - Readers of `un1t_transactions` that bucket by product (UN1TRADAR arrears, LTV) must not misread `manual` rows; check each one.
    - **A fee is landed when** there is a transaction with `type 'manual'`, our `initiated_by`, the user, the amount and our exact description.
  - Optional: refund this €1 in the un1t.online console.
- **Error tests, 28 Oct 2026** (Richard ran them):
  - **Same key replayed.** It returned HTTP 201 with the **same** `transactionId a85a637a-…`. Only one probe transaction exists, so the idempotency key works and a re-send with the same key is safe.
  - **No card (MIA TEST).** HTTP 402 `{"success":false,"error":{"status":402,"message":"This client has no card on file. Request a card from them first.","details":{"code":"NO_CARD_ON_FILE"}}}`. Nothing is charged, and the row becomes `failed: NO_CARD_ON_FILE`.
  - **Unknown card id.** HTTP 404 `{"success":false,"error":{"status":404,"message":"PaymentMethod not found"}}`, with no code. FEES.1 never sends `paymentMethodId`; it always charges the default card, so this case cannot arise.
- **How the 5pm run judges a reply:**
  - **2xx** with `success:true` and a `transactionId` means `charged`.
  - **4xx**, or `success:false`, is refused and marked `failed`, keeping `error.details.code` (or `http_<status>`) and the message.
  - **5xx, 429 or no reply** is `unknown`, then a transactions read, then a re-send with the same key only if the read says `absent`.
- **Still unproven:** the body for a real **declined** card, which can't be produced safely on prod. It is expected to be a 402 with its own code, and is handled by the 4xx rule above. The first real decline gets recorded in `UN1T_REFUSAL_CODES`.
- **Superseded:** the earlier list of things the €1 test charge on MIA TEST was to prove (some items remain unproven, above):
  - whether the endpoint is live on **prod** (these docs are dev);
  - the amount unit;
  - that the description shows on the member's receipt;
  - the error body for a declined card or no card.
  - The test is a real charge, made only on your go-ahead.

### Phase 0 findings (probed 28 Oct 2026)

**What I checked:** un1t.online's public docs are offline: every spec URL returns 404. I worked from the 16 Oct OpenAPI snapshot quoted in spec D §5, plus read-only queries of the prod mirror (514 Hatch bookings).

1. **Charging.** `POST /purchases/charge {userId, productId}` returns 201 `{success, data:{transactionId}}`, needs the `purchases:create` permission (which our token holds), and **requires an Idempotency header**.
   - That header lets a retry be safe against double-charging.
   - The snapshot does not say whether it charges a saved card for a *paid* product. We have only ever sent it €0 products (7 trial charges, all done).
   - **Hatch has no fee products yet**: no product is titled fee, cancel or no-show.
   - Superseded by the custom-amount decision above.
2. **Failure shapes.** Unknown. The same test charge, on a client with no card, gives us the refusal body.
3. **Pack credit on cancel.** The mirror cannot tell. `credit_charged` stays `true` on every cancelled pack booking, whether it was cancelled under 2h or 24h+ before the class (3 / 8 / 8 / 6 / 17 across the buckets). So it means "a credit was spent at booking", not "the credit was kept".
   - The answer lives in `GET /credits/ledgers/{userId}/{studioId}`, which shows whether a refund line follows the cancel.
   - The cancel call takes an optional `forceRefund`, which implies un1t.online has its own refund rule for late cancels. Its window is set in the un1t.online console.
4. **Cancel time.** The booking payload has no cancel timestamp. The keys are `id, user_id, studio_id, event_id, status, source, credit_charged, created_at, created_by, updated_at, external_*`.
   - `updated_at` does move on cancel: all 90 cancelled rows were updated before class start, with medians of 10.8h and 17.7h before.
   - **Use it, frozen when first seen**: stamp `cancelled_at` the first time the sync sees `cancelled`, so a later edit can't move it. Accuracy is about the cancel time itself, not the 15-minute sync cycle.
5. **Who cancelled.** Not exposed. `created_by` names the creator only, and only for API-made bookings (104 of 514 rows, one actor: our API token). Everything else is null.
   - **v1 therefore cannot tell a staff cancel from a member cancel.** Staff waive those on the review page. The page shows "booked by CRM" where `created_by` is set.

**Second probe (28 Oct, read-only GETs with the local token, plus your answers):**
- **The window comes from un1t.online.** `GET /studios/{id}` returns `default_cancelation_window_hours = 2` for Hatch. Events carry no override field, so the CRM reads this value live and never stores its own (you chose "match un1t.online"). The `late_cancel_window_hours` setting is dropped.
- **Pack credit: un1t.online keeps it inside the window (confirmed).**
  - Three pack cancels at 13, 32 and 96 minutes before the class have a `booking` debit and no `cancel_refund` in `GET /credits/ledgers/{user}/{studio}`.
  - A cancel 16.9 hours out got `cancel_refund`.
  - So `credit_forfeit` is native, and the CRM only records it.
- **Who cancelled: not identifiable from un1t.online.**
  - `GET /bookings/{id}` has the same fields as the list. `created_by` is null for member bookings.
  - None of `/bookings/{id}/history`, `/audit`, `/events`, `/audit-logs`, `/activity` exists (all 404).
  - Two partial signals the CRM *can* use:
    - (a) **cancels the CRM made itself** (Mia, contact page) are in `un1t_write_events`, so they are auto-excluded;
    - (b) **a late cancel whose credit came back anyway** (a `cancel_refund` inside the window) means staff forced the refund, so it is treated as staff-excused and excluded.
  - Everything else is listed, and staff waive their own cancels. Asking un1t.online for a `cancelled_by` field stays a follow-up.
- **Swap pattern seen:** a member cancelled and rebooked another class 45 seconds later. This feeds Phase 2 item 5 (a swap is not an offence).

**Live activity at Hatch (whole mirror):** 90 cancels, 45 of them inside 12 hours of the class. 13 no-shows. 368 attended. 43 bookings are still at `booked`; I haven't split those into future and past.

---

## Phase 1: basic features (FEES.1)

### 1. Data (one migration, forward-only)
- **`un1t_bookings.cancelled_at`**: stamped by the sync the first time it sees `status = cancelled`, from the payload's own timestamp if Phase 0 finds one, else from `remote_updated_at`. Nothing is backfilled for older rows; fees start from go-live.
- **New table `class_fees`**, service-role only (`REVOKE ALL … FROM anon, authenticated`, RLS on, no policy):
  - Identity: `location_id`, `un1t_booking_id` (UNIQUE with location), `contact_id`, `un1t_user_id`, `event_id`, `class_name`, `starts_at`.
  - The offence: `kind` (`late_cancel` | `no_show`), `cancelled_at`, `minutes_before_start`.
  - The penalty: `penalty` (`fee` | `credit_forfeit`), `amount_cents`, `charge_description`.
  - Lifecycle: `status` (`pending` → `waived` | `charging` → `charged` | `failed` → `retry_scheduled` → `outstanding` | `skipped`), `attempts` (int), `next_attempt_at`, `waived_by`, `waived_reason`, `waived_at`, `charge_due_at`, `charge_started_at` (claim lease), `charged_at`, `un1t_transaction_id`, `failure_code`, `failure_message`, `detected_run_id`.
- **Widen `un1t_write_events.op`** to include `fee_charge`.
- **Two `cron_heartbeats` rows**, one per cron arm.

### 2. Settings (operator-editable, per studio)
Stored under `locations.settings.un1t_online.fees` and edited on the studio's un1t.online card in the Integrations hub:
- `enabled`: default false. This is separate from `writes_enabled`, and both must be true before anything is charged.
- No window setting: the late-cancel window is un1t.online's `default_cancelation_window_hours`, read live (2h at Hatch).
- `late_cancel_fee_cents` and `no_show_fee_cents`: the custom amounts charged.
- `fee_applies_to`: which plan types pay cash. Pack members get `credit_forfeit`.
- `review_contact_emails`: the designated contacts.
- `detect_hour`: 23. `charge_hour`: 17.
- `charging_paused`: a kill switch that still lets detection and the email run.

### 3. Detection (23:00 studio time)
- **New lib `src/lib/class-fees-detect.js`**, run by the new cron `src/app/api/cron/class-fees`.
  - The cron is scheduled hourly in `vercel.json`, and each studio acts only when its local hour matches, using `@/lib/location-time` (DST-safe, no UTC maths).
- **Steps:**
  1. Run `runUn1tSync` for the studio first, so the list reflects the latest no-show marks.
  2. Select the studio-local day's `un1t_events`, excluding cancelled classes (`class_occurrences.cancelled_at`).
  3. For each event, read its `un1t_bookings`:
     - `no_show` is an offence.
     - `cancelled` with `cancelled_at` inside the window before `starts_at` is an offence, unless a staff member cancelled it.
     - A past booking still at `booked` is **undecided**: it is listed for staff to mark in un1t.online and never charged.
  4. Classify the penalty from the member's active plan (`un1t_subscriptions` / `un1t_clients.credit_unlimited`).
  5. Upsert `class_fees` rows with `onConflict` on the booking, so a re-run never duplicates, and set `charge_due_at` to the next day at 17:00 local time.
  6. Paginate with `.range()` and an explicit `.order()`.
- **Then email** each `review_contact_emails` address via Postmark with a summary (counts, total €, undecided count) and a link to the review page. One email per studio per night, sent even when there are zero fees, so silence never reads as "it ran".

### 4. Review page: `/classes/fees` (web, signed-in)
- **Access:** new `WEB_PERMISSIONS` key `class_fees` (default manager, owner), with a mobile parity decision (`WEB_ONLY_OK` for v1).
- **Tabs:**
  - **Due tonight** groups pending rows by class and shows member, kind, minutes before start, plan and amount, with **Waive** (reason required) and **Waive all for this class**.
  - **Undecided** shows past bookings still at `booked`.
  - **History** shows charged, waived, retry-scheduled and outstanding rows.
- **Routes** `/api/class-fees` (GET) and `/api/class-fees/[id]/waive` (POST) follow the normal mutation skeleton: `getCurrentUser` → permission → `validateBody` → `assertLocationAccess` → service role. Detail reads return 404, not 403. Every waive is written to the audit log. Register both routes in `openapi.js`.
- **Approvals hub:** add a provider in `src/lib/approvals/providers/class-fees.js` so the pending count shows on the approvals badge.

### 5. Charging (17:00 studio time)
- **New op `chargeClassFee`** in `src/lib/un1t-online-write-ops.js`, the only new caller of `/purchases/charge` besides `grantTrial`. Before charging it:
  1. Re-reads the row and requires `status = pending`.
  2. Takes a compare-and-set claim to `charging` with `charge_started_at`.
  3. Checks the amount staff saw still matches the current setting. If it changed, it does not charge and marks the row `failed: AMOUNT_CHANGED`.
- **Policy `verify`, never a blind retry.** On a 5xx or no reply, a dedupe read of `un1t_transactions` (user + amount + description + since claim) decides `landed` / `absent` / `unknown`.
  - `unknown` stays at `charging` with a `failure_code` and is surfaced on the page. It may be re-sent only with the SAME idempotency key, once a transactions read says `absent`.
  - A stale `charging` lease is reconciled by the next sync against the transactions mirror (description + amount), never with a new key.
- **Penalties:**
  - **First attempt refused** (a decline, `NO_CARD_ON_FILE`, any 4xx; a no-card result from the card check counts too): the row becomes `retry_scheduled`, with `next_attempt_at` = 7 days later at the studio's charge hour.
  - **The second attempt at day 7 runs the same way.** If it is refused again, the row becomes **`outstanding`**. There are no further automatic attempts and no emailed links.
  - **Keys per attempt.** Each attempt uses its own idempotency key, `fee:<row id>:<attempt>`, because a refused attempt took no money. A re-send *within* one attempt (after a lost reply) reuses that attempt's key. An `unknown` attempt never moves to a new key until a transactions read says it is `absent`.
  - **Outstanding balance on the member's profile.**
    - The contact page (web) shows an **"Outstanding fees"** card at studios where `class_fees` is held: the total owed, each unpaid fee with its class, day and time, and un1t.online's last refusal reason.
    - A **"Retry charge"** button runs one attempt per outstanding fee, each with its own class description, against the member's default card. The card shows which fees cleared and which were refused again, and a cleared fee becomes `charged`.
    - **"Waive"** is on the same card.
    - The route is `POST /api/class-fees/retry` with `{ contactId }`, on the normal mutation skeleton, and is rate-limited.
  - **Visible elsewhere:**
    - An outstanding balance also shows as a chip on the contact header.
    - The nightly email has an "outstanding" count.
    - The review page has an **Outstanding** tab listing everyone who owes, with the same Retry and Waive buttons.
  - `credit_forfeit` rows make no write. They move to `charged` (meaning "recorded"): un1t.online keeps the credit inside its window (confirmed 28 Oct).
- **Budget and logging:** the per-studio 30/min write budget still applies, so charges are paced and paginated. Every attempt lands in `un1t_write_events`. Failures go through `logError`, with a structured summary per run.
- **Gates:** the run does nothing unless `fees.enabled && writes_enabled && !charging_paused`.

### 6. Guard and test changes (deliberate, reviewed in the PR)
- **`tests/un1t-online-write-guard.test.js`:** allow `/purchases/charge-custom` only inside `chargeClassFee` and the transport's `ENDPOINTS` table. `/purchases/charge` stays limited to `grantTrial`, and `charge-custom/link` and `setup-requests` stay banned.
- **`tests/mia-no-charge-no-refund-guard.test.js`:** Mia and agent modules still cannot import `chargeClassFee`. Keep that ban explicit: only the 17:00 cron and the staff `POST /api/class-fees/retry` route charge.
- **Spec §4 anti-goal:** amend it to "never charge a card except the €0 trial and a staff-reviewed class fee".
- **Schema and readers:** the new table goes in `tests/table-default-acl-guard`. The new readers stay off `class_bookings`, so `class-bookings-readers-guard` is untouched.
- **Unit tests:**
  - the late-window boundary in Dublin and New York across a DST change;
  - staff cancels and cancelled classes are excluded;
  - undecided rows are never charged;
  - idempotent re-detection, the waive race (waive vs claim), the price-changed refusal, and the verify branches.
- **Fake-timer rules** apply to the page tests.

### 7. Docs
- Changelog entry `docs/changelog/entries/<PR>.md`.
- A CLAUDE.md invariant one-liner: "Class fees are the only paid charge the CRM makes on un1t.online; cron-only, staff-reviewed, verify-not-retry."

---

## Phase 2: next features for the member experience (FEES.2+)

Ordered by impact on how fair the policy feels to members:

1. **Tell the member before they're charged.** At 23:00, send each member an email (and WhatsApp where an administrative consent exists) saying what happened, the amount, when it will be charged (17:00 tomorrow) and how to appeal. This is a transactional message, so it uses `_administrative` consent and is never a MARKETING template. It needs a narrow, documented carve-out from the "CRM never messages on Hatch bookings" rule.
2. **Self-serve appeal.** A tokenised public page (all four public-path allowlists) where the member gives a reason (illness, emergency, injury). It files a note on the fee row, which is flagged on the review page. Staff still decide.
3. **Warn at the moment of cancelling.** When a member cancels through Mia inside the window, Mia states the fee first and offers alternatives: swap to another class, or keep the booking. The fee amount comes from the settings, not the prompt.
4. **Automatic forgiveness rules** (settings-driven):
   - The first offence in a rolling 30/60 days is a warning.
   - A late cancel is waived if the spot was re-filled from the waitlist.
   - Fees are auto-waived for first-week members and trials.
   - A monthly cap per member applies.
   - Each auto-waive records which rule fired.
5. **Swap instead of cancel.** Moving to another class the same week inside the window counts as no offence.
6. **Member visibility.** Fee history and receipts in the member app's account area. Repeat-offender badges and a nudge before their next booking. (Staff-side outstanding balance is in FEES.1.)
7. **Outstanding fee follow-up.** Optional: Mia mentions an outstanding fee when the member next talks to her, and a setting can stop CRM-side bookings until it is cleared. No payment or card links are emailed (Richard, 28 Oct).
8. **Reporting.** No-show and late-cancel rate by class, coach and time slot. Fee revenue against waive rate. Before and after comparison of attendance since the policy went live.
9. **Phone surface.** Waive from the staff mobile app (parity counterpart to `class_fees`).

---

## Verification

- **Unit and guard tests:** `npm test` plus the full thirteen-check CI mirror from CLAUDE.md, and `npm run build`.
- **Dry run first:** ship with `fees.enabled = true` and `charging_paused = true` at Hatch for a week.
  - Detection runs, the email arrives, the page shows real rows, waives work, and nothing is charged.
  - Compare the nightly list against what Hatch's coaches marked in un1t.online.
- **First live charge:** turn charging on for one staff test member with a €1 custom charge. Confirm in sequence:
  1. the `un1t_write_events` row;
  2. the un1t.online transaction and receipt;
  3. the `un1t_transactions` mirror after the next sync;
  4. `class_fees.status = charged`.
- **After applying the migration:** run `get_advisors` (security), and confirm the new heartbeat rows stamp.

## Open decisions to confirm when approving

- **The rule change:** lifting the "no paid charges on un1t.online" rule for `chargeClassFee` only.
- **Policy numbers:** late-cancel window hours and fee amounts, set in un1t.online as product prices.
- **Grace before 17:00:** whether a member messaging before 17:00 should hold their fee automatically (Phase 2 item 2 makes this possible).
