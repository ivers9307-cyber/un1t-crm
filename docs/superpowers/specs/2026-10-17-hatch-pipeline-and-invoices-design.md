# Hatch Street: acquisition pipeline from un1t.online data, and invoices

**Date:** 2026-10-17
**Status:** design, ready to plan. Spec A of five (build order A, C, B, D, E).
**Roadmap:** `docs/superpowers/plans/2026-10-17-un1t-online-followups.md` (P1.2 step 2), `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` ("Pipeline classifier (Hatch funnel)", P1.2 order step 2). Integration spec: `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md` (its line 150 already rules out writing un1t state into `glofox_*` columns).

---

## 1. Intent and why

Hatch Street sells memberships, packs and its free trial on un1t.online, and the CRM now mirrors all of it every 15 minutes. Two things a Glofox studio gets for free are still missing at Hatch:

1. **An automatic acquisition board.** Stillorgan's board places every contact as new lead, 1st class, 2nd class, trial done, converted, member, class pack or dormant from Glofox data. Hatch's acquisition board has been switched off since mig 598, because the classifier reads Glofox-only `contacts` columns that no Hatch contact has, so it filed nearly every Hatch lead as a ghost. Hatch kept a manual Waitlist board, which stays. Richard wants the automatic board back, driven by un1t.online bookings, attendance and subscriptions.
2. **Payment history and overdue on the contact page**, the same data Mia and the radars will read. Today a Hatch member's page shows a plan name and nothing about money.

This spec feeds the existing classifier from un1t data without touching `contacts`, re-enables Hatch's board without disturbing the waitlist or Stillorgan, adds the seam reads for invoices and past-due that specs B and E reuse, and flips the `invoices` capability.

## 2. Goals

- G1. Every Hatch contact with a un1t.online account sits on the right acquisition column, recomputed hourly and nightly, from un1t data only.
- G2. A dual-studio member (contact owned by Stillorgan) gets a Hatch acquisition deal that reflects Hatch activity, and nothing about it changes Stillorgan's view of that person.
- G3. `contacts.pipeline_stage_slug` for every contact comes only from boards **at the contact's own studio** (primary first), never another studio's board, and is never NULLed as a side effect (§6.6).
- G4. Hatch staff see, on the contact page and the inbox command centre: current un1t.online subscription(s), recent payments, invoice states, and an overdue flag with amount and date when there is one.
- G5. Two seam reads, `pastDue` and `paymentsFor`, return un1t billing in a stable shape that B (radar, arrears, briefing) and E (Mia) consume unchanged.
- G6. `un1tOnlineSource.capabilities.invoices` becomes `true`, and every reader of it is correct for a un1t studio first.

## 3. Non-goals

- Churn and lead radar tiers, arrears chase-list, briefing pulse, flipping `memberships` (spec B).
- Projecting `un1t_bookings` into `class_bookings`, fill and no-show (spec C).
- Any un1t.online write (spec D). This spec is read-only against un1t.online data.
- Mia tools at Hatch, the `credits` capability (spec E). E builds Mia's billing answers on `pastDue`/`paymentsFor`.
- The returning board (parked, `shared/pipelines/returning.js`).
- The Hatch waitlist board's columns, entry rules or manual moves.
- The phone Studio dashboard funnel counts (`shared/dashboard-data.js:446-486` count `pipeline_stage_slug`, which at Hatch is the waitlist board and stays so).

## 4. Anti-goals (must never happen)

- No un1t-derived value is ever written to a `contacts` column, least of all a `glofox_*` one, `last_attended_at`, `recent_bookings`, `joined_at`, `converted_at`, `pack_customer_at` or `trial_credits_remaining`.
- A Hatch board's stage never becomes a dual-studio contact's `pipeline_stage_slug`, and no Hatch deal move enrols anyone in a Stillorgan sequence. Membership status and the pipeline are separate per studio; only the contact row is shared (G1).
- Nothing here routes an outbound send through Stillorgan's WhatsApp number (G7); this spec sends nothing at all.
- The Hatch acquisition board is never classified from `contacts` columns (that is the "every lead is dormant" failure, recreated in one cron tick).
- Nothing in this spec sends a customer message, starts a sequence or schedules a Mia follow-up.
- No Glofox API call is ever made for a Hatch location (see §5.7 for the one path that would).
- No guessed amount owed: an overdue with no open invoice shows "amount not reported", never a number we made up.

## 5. Current state (main at `d75b064d`)

### 5.1 The classifier and its writers
- `classifyContact(contact, now)` (`shared/pipeline-classifier.js:216-415`) is pure. It reads `glofox_membership_status` (`:218`; member or credit_member → converted within 60 days of `converted_at`, else member, `:221-247`), `gympass_member_id` (`:257`), `pack_customer_at` or `trial_credits_remaining >= 4` (`:281-286`), `pipeline_dismissed_at` + `last_attended_at` + `last_lead_source_at` for Cold (`:297-332`), then attended count = max(attended entries in `recent_bookings`, 1 if `last_attended_at`) (`:370-373`), an upcoming `BOOKED` entry in `recent_bookings` (`:399`, `nextBookedClass` `:196-206`, `time_start` in unix seconds, status uppercase), and `joined_at` within 60 days (`:412-414`). Everything else is `dormant`.
- The board module `shared/pipelines/acquisition.js` wraps it: 11 stages (`:18-30`) and `requiredFields` (`:34-54`), the 19 `contacts` columns above. `shared/pipelines/index.js` registers only `acquisition`.
- `reclassifyAllContacts(db, { locationId })` (`src/lib/pipeline-reclassify.js:63`) loads the location's enabled boards, skips `mode='manual'` ones (`:108-129`), selects `contacts` with `.eq('location_id', locationId)` (`:186-200`, the select list from `requiredFields`, `:145`), loads open deals on those boards at that location (`:237-253`), classifies each contact from its own columns (`:280-301`), bulk-moves deals and creates missing ones (`:397-416`), and audits to `pipeline_classification_runs`. It fires **no** sequence trigger, by design.
- Cron `pipeline-classify` (`src/app/api/cron/pipeline-classify/route.js:40-61`) runs it for **every active location** at 03:30 (`vercel.json:72-73`).
- `ensureDealForContact` (`src/lib/glofox-sync.js:491`) is the per-contact writer, called from the Glofox member sync (`:2145`, `:2195`) and the Cold route (`src/app/api/contacts/[id]/pipeline-status/route.js:95`). It only ever places on the location's **primary** board and only when it is derived (`:506-509`), and a `move` fires `triggerSequencesForDealPlacement` (`:2292`).

### 5.2 Why every Hatch contact sits at new_lead or dormant
The un1t sync writes only `contacts.un1t_user_id` / `un1t_synced_at` (mig 726 §1) and the `un1t_*` mirror. Every column the classifier reads is null for a Hatch-only contact, so status is null, attended is 0, and the only live rule is `joined_at`, also null: dormant, or new_lead when some other path stamped `joined_at`. A dual-studio contact is worse: it carries Stillorgan's Glofox values, so a Hatch board read from `contacts` would show their Stillorgan journey.

### 5.3 Hatch's boards and the slug trigger
- Mig 597 created the manual `waitlist` board at Hatch. Mig 598 moved every open Hatch deal onto it, made it primary, set Hatch's `acquisition` board `is_primary=false, enabled=false` (`598:88`) and archived its stages (`598:98-99`). Closed deals still point at those archived stages.
- `sync_contacts_pipeline_stage_slug()` (mig 595 `:26-72`, fired AFTER INSERT/UPDATE/DELETE on `deals`, mig 155:144) picks the newest open deal on **any** `is_primary` board (`595:49`), **not scoped to the contact's studio**, and when that finds nothing, the newest open deal on any board at all (`595:55-64`).
- **Live defect.** A dual-studio contact with an open Hatch waitlist deal (12 such contacts per the P1 plan) has two primary-board deals, and whichever was created last sets `pipeline_stage_slug`. A newer waitlist deal makes a Stillorgan member read as `waitlist_new_enquiry` to Stillorgan's audiences, member pricing (`src/lib/member-validation.js:41,128` treats only `converted`/`member` as a member by stage) and Mia check-ins (`src/lib/agent/followups.js:61,856,955`).
- **Latent defect.** The "any board" branch is not scoped either, so once any studio runs two boards a contact's slug can come from another studio's non-primary board. A1 (§6.6) replaces both branches with one own-studio rule.

### 5.4 What a stage change can trigger
- `triggerSequencesForPipelineStageChange` (`src/lib/sequences/triggers.js:225`) finds active `pipeline_stage_change` sequences at **`contact.location_id`** (`:239`). Callers: `ensureDealForContact` moves, the manual waitlist move route (`src/app/api/deals/[id]/stage/route.js:129`, which refuses derived boards at `:102`), `PUT /api/deals/[id]` (`src/app/api/deals/[id]/route.js:115-116`), the Cold route, and contact creation. So a manual waitlist move of a dual-studio contact enrols them in **Stillorgan's** stage sequences today.
- Audience filters, sequence auto-exit and goals (`src/lib/sequences/scheduler.js:259-266`), Mia check-ins and follow-ups, member pricing and booking outcomes all read `contacts.pipeline_stage_slug`, never `deals`.
- `log_deal_stage_change` (mig 004:262) writes a staff timeline activity "Pipeline: moved to …" on every stage change. Not customer-facing.
- The board's next-class badge (`src/lib/pipeline-board.js:19,95-107`) keys on `contacts.pipeline_stage_slug` and Glofox `recent_bookings`.

### 5.5 un1t billing data (mig 726)
- `un1t_transactions` (`726:133-155`): `un1t_id`, `un1t_user_id`, `contact_id`, `product_id`, `product_title`, `invoice_id`, `type`, `product_type`, `amount_cents`, `currency`, `refunded`, `refund_status`, `remote_created_at`, `raw` (minus `description`), `synced_at`.
- `un1t_invoices` (`726:156-172`): `un1t_id`, `un1t_user_id`, `contact_id`, `subscription_id`, `status`, `amount_cents`, `currency`, `remote_created_at`, `raw` (minus `invoice_url`, `user`), `synced_at`. No due date, no paid-at column.
- `un1t_subscriptions`: `status`, `price_cents`, `billing_interval(_count)`, `current_period_start/end`, `cancel_at_period_end`, `trial_end`, `paused_at`, `paused_until`, `past_due_at`, `product_title`.
- **Statuses.** `mapInvoice` copies `status` verbatim (`src/lib/un1t-online-map.js:197`); the snapshot's `InvoiceResponseDto.status` is a bare string with no enum, and the DTO carries a `stripe_invoice_id`, so the values are probably Stripe's (`draft`, `open`, `paid`, `uncollectible`, `void`), unconfirmed. The 16 Oct probe saw only `paid` (36 of 36). Transactions: `type` ∈ {`one_time`, `sub_initial`, `sub_renewal`}, `product_type` ∈ {`pack`, `subscription`} (the €0 trial is a `pack`), `refund_status` ∈ {`none`, `full`}. Subscriptions: `MEMBERSHIP_ACTIVE_STATUSES = active, trialing, past_due` (`un1t-online-map.js:18-19`); the seam counts `active`, `past_due` as members (`reads/un1t-online-shape.js:21`); the probe saw only `active`.
- Every table is a full pull upserted with `synced_at`, never pruned, so a row un1t.online stopped returning keeps its last status. The seam already guards subscriptions with a relative freshness window (`reads/un1t-online.js:46-61`, rows within 10 min of the studio's newest `synced_at`).
- The seam (`src/lib/membership/reads/`) has location-aggregate reads only (`READ_KEYS`, `reads/index.js:21-23`) and deliberately no `arrears` (`reads/un1t-online.js:14-15`).

### 5.6 Contact page billing today
- `loadContactArrears(db, contactId)` (`src/lib/churn-radar-data.js:589-603`) sums netted Glofox `PAST_DUE` invoices for one contact. The page (`src/app/(sales)/contacts/[id]/page.js:102`) and the command centre (`src/app/api/contacts/[id]/command-centre/route.js:97,112`) feed it into churn `classifyContact`, whose overdue branch fires only for a Glofox member status (`src/lib/churn-radar.js:203-209`). The page's "Payment overdue" pill says "Membership locked in Glofox" (`page.js:167`); the header metric is `metricArrearsCents` (`:342`).
- `ContactWhoRail` renders `StudioMembershipsCard` (plan name, active/ended, studio) then `GlofoxProfileCard` (last payment, LTV, Glofox price) (`src/components/contact/ContactWhoRail.jsx:69-71`). There is no payments-history card for either source. A Hatch member's page shows no money at all.

### 5.7 The `invoices` capability
`un1tOnlineSource.capabilities` is all false (`src/lib/membership/sources/un1t-online.js:16`, pinned by `sources/un1t-online.test.js:22`). Readers of `invoices`, exhaustively:
- `get_my_payment_reminder` (`src/lib/agent/account-tools.js:605-613`): `if (!provider.capabilities.invoices) return result`, then **unconditionally** reads Glofox credentials for `locationId || owner.location_id` and calls `getGlofoxOverdueInvoices`. With `invoices: true` at Hatch, a Hatch thread whose verified contact is a Stillorgan-owned dual-studio member (who has a `glofox_member_id`) would call Glofox with Hatch's placeholder credentials. Today the tool is unreachable at Hatch only because `bookings` is false (`tool-capability.js:29`), which spec D flips.
- `locationIdsWithoutCapability(db, 'invoices')` and `providesCapability(m, 'invoices')`: no callers. `MembershipSourceGate` has copy for it (`MembershipSourceGate.jsx:34`) but no page passes it. Mobile reads no capability flags.

## 6. Design

### 6.1 The core decision: a per-location input, never `contacts` columns
**Chosen:** the orchestrator asks the location's membership read adapter for classifier inputs. For a un1t.online location the adapter builds, per contact, the same snapshot object `classifyContact` already takes (its field names are the classifier's input vocabulary, not columns) from `un1t_*` rows scoped to that location. `classifyContact` and the 11 stages do not change.

This is Richard's principle G1: membership status and the pipeline are separate per studio; only the contact is shared.

**Rejected:** writing un1t-derived values onto `contacts`. A dual-studio contact is one row shared with Stillorgan: writing `glofox_membership_status`, `last_attended_at` or `recent_bookings` from Hatch would overwrite Stillorgan's Glofox state (and the Glofox sync would overwrite it back, so both studios flap), light up Stillorgan's churn radar, KPIs, audiences, Mia tools and check-ins with Hatch data, and for Hatch-only contacts quietly switch on every Glofox-shaped surface the capability flags exist to keep dark.

### 6.2 un1t pipeline input (new seam read `pipelineInputs`)
`pipelineInputs(db, locationId, { now })` on `un1tOnlineReads` returns `{ success, data: { contacts: [{ id, name, email, location_id }], snapshots: Map<contactId, snapshot> } }`, or `{ success: false, error }`. All reads are `location_id = locationId`, `range()`-paginated with an explicit order (`selectAll`). Shaping is a pure function in `reads/un1t-online-shape.js` (`shapePipelineSnapshot`), tested without a database.

| Snapshot field | Built from (this location only) |
|---|---|
| `glofox_membership_status` | First match wins, in Glofox's order: (1) `member`: a fresh subscription with status in `MEMBER_STATUSES` (active, past_due), or `paused_at` set and not ended. (2) `credit_member`: paid credits remaining > 0 (below), as Glofox's Plan A labels a pack holder. (3) `classpass_payg`: an aggregator user (below, A-3). (4) `trial`: a fresh `trialing` subscription, or trial credits remaining > 0. (5) `ex_member`: an ended membership at this studio (ended `contact_memberships` row, source `un1t_online_api`) with no active one, **and** no paid pack bought since it ended, **and** no attended class since it ended. (6) `lead`. So an ex-member who buys a pack, holds credits or keeps attending is placed as a pack or credit member or by attendance, never dormant (A-2). |
| `gympass_member_id` | for a Wellhub / Gympass aggregator user (a booking `source` of `wellhub` or `gympass`): the booking's `external_member_ref`, else the marker `un1t:aggregator`, so the classifier's existing Gympass pile takes them (A-3). Otherwise null. |
| `converted_at` | earliest `sub_initial` transaction for the user (same rule as `firstSales`). |
| `pack_customer_at` | earliest transaction with `product_type='pack'`, `amount_cents > 0`, not refunded, whose product is not a trial product. |
| `trial_credits_remaining` | `credit_balance` when the user has bought a paid pack, else trial credits remaining; null when `credit_unlimited`. |
| `recent_bookings` | the user's last 10 bookings by event start (`un1t_bookings` ⨝ `un1t_events` on `event_id = un1t_id`), each `{ attended: status === 'attended', status: upper(status), time_start: epoch seconds of starts_at }`. Cancelled bookings are kept with `attended:false`. |
| `last_attended_at` | max of `un1t_clients.last_attended_at` and the newest attended booking's start. |
| `joined_at` | the later of `un1t_clients.remote_created_at` and the user's newest trial transaction. |
| `pipeline_dismissed_at`, `last_lead_source_at` | from `contacts`, **only** when `contacts.location_id = locationId` (Hatch-owned); null for a dual-studio contact. |
| Glofox state/expiry, `total_attended_*`, `last_payment_at`, `created_at` | null (the classifier does not need them for these rules). |

**Trial (G10, R1).** New people get the public "The UN1T Trial", and only when eligible (R1, below). A user **took a trial** when they hold a transaction for a product where `isTrialProduct` holds (`one_time`, €0; `reads/un1t-online-shape.js:30`: today "The UN1T Trial" and the private "1) The UN1T Trial"; keyed on product id, never the title), or spec D's ledger (`un1t_write_events`) has a `done` row with `op='trial'` for them at this studio (it covers the minutes between D's grant and the next sync). **Trial credits remaining** = the trial's credits (the product's `credits_per_period`, 3 today) minus the user's `credit_charged` bookings since the trial, floored at 0 and capped at `credit_balance`. **Paid credits remaining** = `credit_balance` minus trial credits remaining, counted only when a paid pack exists. The whole balance is never read as "trial" (A-2).

**Trial eligibility, one shared check (R1).** A exports `trialEligibility(db, locationId, { un1tUserId, contactId })` on `un1tOnlineReads` (pure decision `shapeTrialEligibility` in `reads/un1t-online-shape.js`), built from the same rows as the snapshot above, so the board, D's grant and E's upsell agree on one definition. Answer `{ success, data: { eligible, reasons: [] } }` or `{ success: false, error }`. Not eligible when, at this studio, any of these exist: a trial (as defined above, any trial product); any past or present subscription in `un1t_subscriptions`; any `contact_memberships` row, source `un1t_online_api` or `un1t_online_export`, active or ended; a `un1t_transactions` row for a recurring product (`sub_initial`, `sub_renewal`, or `product_type='subscription'`); any paid pack purchase (`product_type='pack'`, `amount_cents > 0`). Reasons: `trial_used`, `membership_history`, `paid_pack`. Subscription and transaction history is read in full here, not only fresh rows: a lapsed member is history. A failed read is `success:false`, never "eligible"; D and E treat it as "do not grant, staff card". **Claude's call:** the check lives in A's seam because A already derives trial and membership history for the classifier; D calls it before any grant, E before offering the trial.

**Aggregator users (A-3).** Anyone with a booking at this studio whose `source` is not `direct` or whose `external_member_ref` is set is kept off the funnel from day one: Wellhub / Gympass sources go to the Gympass pile (above), every other aggregator to the ClassPass pile (`classpass_payg`). A real membership or paid credits outrank both, as at Stillorgan (classifier order `:221-260`). 0 such bookings today (P1 plan).

"Fresh" means within the existing relative window of the studio's newest `synced_at` for that table; refactor `listActiveSubs`' window into one helper (`freshCutoff(db, table, locationId)`) and use it for subscriptions, invoices and clients.

### 6.3 Who is on Hatch's board, and dual-studio deals
- **Population:** every contact with a `un1t_clients` row at the location (`contact_id` not null), whoever owns the contact. A waitlist lead with no un1t.online account is not on the acquisition board; they appear at new_lead when the sync links their new account.
- **One deal per studio board.** A dual-studio member's Hatch acquisition deal has `deals.location_id = Hatch` and `pipeline_id = Hatch acquisition`; their Stillorgan acquisition deal is untouched. Mig 598's unique index (one open deal per contact per board) holds. A person can hold three open deals (Stillorgan acquisition, Hatch waitlist, Hatch acquisition), and each board shows its own studio's truth.
- Contact visibility for Hatch staff is already handled by mig 732 (`canViewContact` admits a un1t client row), so opening the card works.
- The shared contact page (one contact, every studio) lists a dual-studio member's Hatch deal and its "Pipeline: moved to …" timeline rows next to Stillorgan's. Accepted as is (A-4, consistent with G1).

### 6.4 Board module and orchestrator changes
**A second board module, so Stillorgan's path cannot change.** Register `acquisition_un1t` in `shared/pipelines/index.js` (new file `shared/pipelines/acquisition-un1t.js`): the same `stages` and `classify` as `acquisition`, `requiredFields: ['id', 'name', 'email', 'location_id']`, and `inputSource: 'un1t_online'`. It stays pure (shared/ cannot import `src/lib`); the declaration only tells the orchestrator where inputs come from. Hatch's acquisition row gets `module='acquisition_un1t'` (A2). Editing `shared/` publishes a no-op OTA group (accepted over-trigger, CLAUDE.md).

**Orchestrator (`src/lib/pipeline-reclassify.js`).** After step 1b, if an active board declares `inputSource: 'un1t_online'`:
- resolve the seam with `membershipReadsFor(db, locationId)`; it must be `source === 'un1t_online'`, `state === 'configured'` and `supportsRead(r, 'pipelineInputs')`. Anything else, `state === 'unknown'` included, skips the un1t boards this run: close the audit row `status:'failed', error_message:'un1t inputs unavailable: <state>'`, `logWarn` structured, retried next tick. A failed adapter read skips the same way. Never fall back to `contacts` columns.
- on success, `contacts` = the adapter's list and the classify loop uses `snapshots.get(c.id)` instead of the `contacts` columns. `contactIdSet`/`dealByContact` then include dual-studio contacts.
- a location mixing a `contacts`-input board with a un1t-input board is refused for the un1t board with a logged reason (no such location exists or is planned).

**Every other location, Stillorgan included, is byte for byte unchanged (A-6):** no membership-state read, no new query, the same calls in the same order; the existing reclassify tests stay green untouched and a new test pins Stillorgan's call sequence. The new-deal title fallback becomes `'Member'` only on the un1t path. No change to manual-board fencing. A bonus of the separate module: a pipelines row naming `acquisition_un1t` on a deploy that lacks it is "no board module registered", skipped and reported (`:122-127`), never classified from `contacts`.

### 6.5 Cadence
The nightly cron covers Hatch automatically once the board is enabled. **Claude's call:** also run `reclassifyAllContacts` for a un1t location at the end of a `un1t-online-sync` run that returned ok, at most once an hour (skip when that location's newest `pipeline_classification_runs` row finished under 55 minutes ago), under its own `try/catch` so it can never fail the sync or its heartbeat. Audit `source` stays `'cron'` (mig 149's CHECK allows only cron/manual/backfill). This is the only writer of Hatch acquisition deals, so there is no second writer to flap against.

### 6.6 Migration A1: scope the slug trigger to the contact's studio
Richard approved shipping it (G6). `CREATE OR REPLACE FUNCTION public.sync_contacts_pipeline_stage_slug()` (keeps the ACL; trigger functions need no grant). **The one rule (A-1):** with `v_loc := contacts.location_id`,
1. the newest open deal on the **enabled primary board at `v_loc`**; else
2. the newest open deal on **any other enabled board at `v_loc`**; else
3. **leave the slug unchanged.** The trigger never NULLs a slug as a side effect (old mig 595 wrote NULL when the last open deal closed).

Keep the `IS DISTINCT FROM` guard. In the same migration, recompute by this rule for every contact holding an open deal at a studio other than its own (the trigger fires only on deal writes); step 3 applies there too, so a contact with no own-studio deal keeps its current slug.

**Expected counts, checked by the migration** (the builder measures each before applying and writes the numbers into the migration's assertions and the PR):
- (a) dual-studio contacts whose slug now comes from a Hatch deal → their own studio's slug: at most 12 (P1 plan figure).
- (b) Hatch-owned contacts: **0 changes in A1**. Hatch has no open acquisition deals yet (mig 598 moved every open deal to the waitlist), and the waitlist is the primary at their own studio, so the rule gives what they hold now.
- (c) contacts at a studio with no enabled board (CCF Autos, SourceIt, Test Studio): 0 changes (step 3).
- (d) every other contact: 0 changes.
The self-check raises if any count differs from its measured value, and if any contact whose own studio has an open deal for them holds a slug from another studio's stage.

**Later effect, at A2 (by this rule, intended):** a Hatch-owned contact with **no open waitlist deal** takes their acquisition stage as their slug once the board creates their deal (step 2). Expected: the linked Hatch-owned un1t clients without a waitlist deal (builder counts; it includes the sync-created contacts). A Hatch-owned contact with a waitlist deal keeps the waitlist slug.

Grants: no table or column change. `-- grant: none (function body only, CREATE OR REPLACE keeps the ACL)`.

### 6.7 Sequence fence (`src/lib/sequences/triggers.js`)
`triggerSequencesForDealPlacement(contactId, dealResult, { dealLocationId, pipelineId })` enrols only when all three hold:
- the caller passed both the deal's location and its board; if either is missing it **refuses** (`stage_trigger_skipped`, reason `missing_board`), so a new caller cannot forget (A-5);
- the deal's location is the contact's own studio (else `cross_location`);
- the contact's `pipeline_stage_slug`, re-read after the move, equals `to_slug`, i.e. this move is what A1's rule now shows (else `not_slug_source`).
Sequences are then looked up at that studio. Callers, all passing the deal's location and pipeline: `glofox-sync.js:2292` (the board `ensureDealForContact` used), `deals/[id]/stage/route.js:129` (`deal.location_id`, `deal.pipeline_id`), `PUT /api/deals/[id]` (`deals/[id]/route.js:115-116`; its select at `:36` gains `pipeline_id`), and the Cold route. Bulk reclassify still never calls it. This closes §5.4's live defect and makes any Hatch placement safe by construction.

### 6.8 Migration A2: re-enable Hatch's acquisition board
Applied **after** the code in §6.2-6.7 is deployed and after A1. Data only, guarded, one transaction:
- Upsert Hatch's 11 acquisition stages from `shared/pipelines/acquisition.js` (`on conflict (location_id, slug)`, conflict-targeted; mig 559's lesson), set `archived=false`, `pipeline_id` = Hatch acquisition, `is_dormant` per the module.
- `pipelines` row `key='acquisition'` at Hatch: `enabled=true`, `is_primary=false`, `mode='derived'`, `module='acquisition_un1t'`, `display_order=1` (waitlist stays `0` and primary).
- Self-check: waitlist is Hatch's enabled primary; exactly one enabled primary at Hatch; 11 live acquisition stages; Hatch's open waitlist deal count is unchanged; no `pipeline_stage_slug` changed in the migration itself (it creates no deals; the slug changes in §6.6 "later effect" happen on the first run).
- Grants: none (no new relation).

The board then appears as a second tab on `/pipeline` at Hatch (tabs come from enabled `pipelines`, `src/app/(sales)/pipeline/page.js:72-83`), read-only like Stillorgan's. The phone's pipeline tab keeps showing the primary (waitlist) board (`mobile/lib/pipeline-api.js` `listStages`), no mobile change. **Claude's call:** at a un1t location the board's next-class badge is hidden in v1 (it would show a dual-studio member's Stillorgan class); a un1t-sourced badge is a follow-up.

### 6.9 What fires once Hatch stages move (flag for Richard)

| Mechanism | Fires? | Customer message? |
|---|---|---|
| `pipeline_stage_change` sequences | No. Bulk reclassify never fires them, and §6.7 refuses a cross-studio or board-less call | No |
| Audiences, campaigns, sequence auto-exit and goals on `pipeline_stage_slug` | Hatch-owned contacts with a waitlist deal keep the waitlist slug; dual-studio contacts keep their own studio's (A1). **Hatch-owned contacts with no waitlist deal take their acquisition slug** (§6.6 later effect), so a Hatch campaign or sequence filtered on an acquisition stage could now match them | Only if such a Hatch campaign or sequence exists and is sent (§9 lists them before A2) |
| Mia check-ins and follow-ups (`followups.js`) | No: Mia is off at Hatch and will be replies only (decision 3) | No |
| Event member pricing | Unchanged in effect: a `converted`/`member` slug and an active `contact_memberships` row say the same thing | No |
| `log_deal_stage_change` (AFTER UPDATE, mig 003:136-139) | Yes: one staff timeline row per move, at Hatch | No |
| Initial backfill | ~190 deal inserts in the first run (inserts log nothing; later moves log) | No |

**A1 at Stillorgan (approved, G6):** dual-studio contacts whose slug is currently a waitlist slug get their Stillorgan stage back, so they are eligible again for Stillorgan's live Mia check-ins and stage-filtered campaigns. That is the correct behaviour restored.

### 6.10 Invoices: normaliser and seam reads
`normaliseUn1tInvoiceStatus(raw)` (pure, `reads/un1t-online-shape.js`): `paid` → `paid`; `open`, `past_due`, `unpaid`, `failed`, `uncollectible` → `open` (owed); `void`, `draft`, `deleted` → `void`; `refunded` → `refunded`; anything else → `unknown` (shown verbatim to staff, never counted as owed, logged once per read with the value). Case-insensitive.

New keys on `un1tOnlineReads` beside `pipelineInputs` and `trialEligibility` (§6.2) (add all to `READ_KEYS`; the Glofox adapter does not implement them, so `supportsRead` is false there and Glofox surfaces stay on their own readers):

```
pastDue(db, locationId, { contactIds? }) →
  { success: true, data: [{ contactId, un1tUserId, subscriptionId, productTitle,
      since, amountCents, currency, openInvoiceIds, cancelAtPeriodEnd, pausedUntil }] }
  | { success: false, error }

paymentsFor(db, locationId, contactIds, { limit = 25 }) →
  { success: true, data: { subscriptions: [{ productTitle, status, priceCents, currency,
      interval, periodEnd, cancelAtPeriodEnd, pausedUntil, pastDueAt }],
    transactions: [{ at, productTitle, type, amountCents, currency, refunded }],
    invoices: [{ at, status, rawStatus, amountCents, currency }],
    pastDue: <one pastDue row>|null } }
  | { success: false, error }
```

**Past due** (fresh rows only): a subscription with `status='past_due'` or `past_due_at` set, or an `open` invoice not netted out by a later `paid` invoice on the same subscription with the same amount (the Glofox `nettedOutByRetry` idea). `since` = earliest of `past_due_at` and the oldest surviving open invoice. `amountCents` = sum of surviving open invoices, or `null` when the signal is only `past_due_at`. `contactIds` lets E pass a person group. Money is integer cents; nothing here reads `contacts`.

### 6.11 Contact page and command centre
- New loader `loadUn1tBilling(db, user, contactId)` (`src/lib/contact-un1t-billing.js`): locations from the contact's `un1t_clients` rows; keep those whose source is `un1t_online`, state configured, `capabilities.invoices` true, **and where the viewer has location access** (`assertLocationAccess`; Claude's call, §8 item 16); per location call `paymentsFor`. Never throws; a failed read hides the card and logs.
- New `Un1tPaymentsCard` (server component) in `ContactWhoRail`, between `StudioMembershipsCard` and `GlofoxProfileCard`: per studio, an overdue band (since, amount or "amount not reported by un1t.online"), current subscription(s), the last 10 payments (date, product, amount, Refunded chip), invoice statuses. Staff-only copy, so no customer-copy setting; chips `bg-<c>-500/10 text-<c>-700`.
- Header band: if any studio is past due, `risk` = Payment overdue with title "Payment overdue on un1t.online at <studio> since <date>", independent of churn `classifyContact` (which needs a Glofox status). `metricArrearsCents` adds the un1t amounts (EUR both today; add only like currencies). `deriveNeedsAttention` gets an `overdue` boolean so a null amount still raises the chip.
- Command centre route: the same loader joins its `Promise.all`; the response gains `un1t_billing: { overdue, arrears_cents, studios: [{ location_id, since }] }` (additive), and `churnLabel` becomes Payment overdue when set.

### 6.12 Flip `invoices`
1. Fix `account-tools.js:609`: the Glofox overdue check runs only when `provider.key === 'glofox'`; any other provider returns `result` (`still_overdue: 'unknown'`) untouched. E later answers Hatch members from `pastDue`.
2. Then set `invoices: true` in `sources/un1t-online.js:16`, update `sources/un1t-online.test.js:22`, and the module's header comment.
3. Add a guard test listing every reader of `capabilities.invoices` (§5.7) so a new one has to be classified.

### 6.13 Files
`src/lib/membership/reads/un1t-online.js`, `reads/un1t-online-shape.js`, `reads/index.js` (READ_KEYS); `shared/pipelines/acquisition-un1t.js` (new), `shared/pipelines/index.js`; `src/lib/pipeline-reclassify.js`; `src/app/api/cron/un1t-online-sync/route.js` (post-sync reclassify); `src/lib/sequences/triggers.js` + its four callers (`glofox-sync.js`, `deals/[id]/stage/route.js`, `deals/[id]/route.js`, `contacts/[id]/pipeline-status/route.js`); `src/lib/pipeline-board.js` / pipeline page (badge off at un1t locations); `src/lib/contact-un1t-billing.js` (new); `src/components/contact/Un1tPaymentsCard.jsx` (new), `ContactWhoRail.jsx`; `src/app/(sales)/contacts/[id]/page.js`; `src/app/api/contacts/[id]/command-centre/route.js`; `src/lib/agent/account-tools.js`; `src/lib/membership/sources/un1t-online.js`; migrations A1, A2 (next free numbers, 736+ today; siblings also take numbers, so allocate at build time).

### 6.14 Failure modes
- un1t sync stale or down: inputs come from the last good pull; freshness is relative, so a dead sync keeps last values rather than emptying the board. The sync's own health check pages for it.
- A contact unresolved by the sync (`contact_id` null): not on the board; counted in the run's samples as `unlinked`.
- Unknown invoice status: shown, not owed, logged.
- un1t membership state unreadable or unconfigured: the un1t board is skipped this run, never classified from `contacts`. Glofox locations are not consulted and cannot be affected (A-6).
- Post-sync reclassify throws: caught, logged, sync result and heartbeat unaffected.
- A1 recompute touches many rows: bounded by contacts with a cross-studio open deal plus Hatch-owned contacts (hundreds), one statement.

### 6.15 Logging
`logWarn('pipeline-reclassify', 'inputs unavailable', { locationId, source, state, reason })`; the run result carries `input_source: 'un1t_online' | 'contacts'` and `unlinked`; `logWarn('sequences', 'stage_trigger_skipped', { reason, dealLocationId })`; `logWarn('un1t-billing', 'unknown invoice status', { locationId, status })`. No PII in any log line (ids only).

## 7. Decided (Richard, 17 Oct 2026)
- Keep Hatch's manual waitlist board exactly as is and primary; re-enable the automatic acquisition board at Hatch, driven by un1t.online bookings, attendance and subscriptions (decision 1; P1 plan decision 4).
- Invoices same as Glofox: Hatch staff see payment history and anything overdue on the contact page; Mia and the radars read the same data; `invoices` flips true (decision 2).
- Hatch staff see Hatch members whose contact lives at Stillorgan (P1 plan decision 3).
- Sync-created contacts stay marketing-opted-in (decision 13). Testing runs live with the MIA TEST account (decision 11).
- G1: membership status and the pipeline are separate per studio; only the contact is shared. This is the basis of §6.1 and §6.3.
- G6: ship migration A1, restoring dual-studio members' Stillorgan stage (and with it their eligibility for Stillorgan's Mia check-ins and stage-filtered campaigns).
- G7: WhatsApp shared across the organisation is a separate follow-up; until it ships nothing routes a new outbound send through Stillorgan's number. This spec sends nothing.
- G10, as changed by R1: new people get the public "The UN1T Trial", and eligibility is checked BEFORE any grant. Not eligible: any earlier trial (any trial product, transaction or D's `op='trial'` ledger row), any past or present membership or subscription (`un1t_subscriptions`, `contact_memberships` from the API or the export, a recurring-product transaction), or any paid pack. An ineligible person is told the trial was used and offered memberships and packs (spec E's offer list, spec D's checkout link); D owns the grant path, its refusal handling and the new-person form and /start wording. `POST /credits/grant` is not used anywhere. A provides the check as `trialEligibility` (§6.2).
- R2-R4 (refunds, Instagram, duplicate emails) do not touch this spec: A issues no refund, sends nothing and has no Instagram path.
- G4: the paid checkout path is tested by Richard by hand after go-live. Nothing in this spec takes a payment.
- G2, G3, G5, G8, G9 and G11 do not touch this spec (forms, roster permission, digest recipient, TVs, `class_bookings` data). Everything A adds is staff-only; no aggregate studio number reaches a customer screen.

## 8. Claude's calls (Richard to check)
1. Claude's call: per-studio classifier input, never `contacts` columns. Reason: the contact row is shared with Stillorgan (G1) (§6.1).
2. Claude's call: board population = contacts with a un1t.online account at Hatch; waitlist-only enquiries stay off it. Reason: without an account there is no un1t signal, so they would only pile up as dormant (§6.3).
3. Claude's call: a dual-studio member gets a separate Hatch acquisition deal; Stillorgan's deal is untouched. Reason: each studio's board shows that studio's journey (§6.3).
4. Claude's call: one slug rule in A1 (own studio's primary board, else its other enabled board, else unchanged, never NULL), with expected counts asserted. Reason: one rule is checkable, and a side-effect NULL silently drops people out of audiences (§6.6, A-1).
5. Claude's call: the sequence fence also covers `PUT /api/deals/[id]` and refuses a caller that does not pass the deal's location and board. Reason: a future caller cannot quietly bypass it (§6.7, A-5).
6. Claude's call: status order matches Glofox, so an ex-member with a new pack, credits or recent attendance is never dormant, and "trial" means the trial purchase and its own credits, not the whole balance. Reason: a lapsed member who comes back is a live lead (§6.2, A-2).
7. Claude's call: aggregator users (non-`direct` booking source or an `external_member_ref`) are off the funnel from day one, in the existing ClassPass / Gympass piles. Reason: they are not sold a membership the normal way, as at Stillorgan (§6.2, A-3).
8. Claude's call: the shared contact page shows a dual-studio member's Hatch deal and timeline rows as is. Reason: one person, one page; consistent with G1 (§6.3, A-4).
9. Claude's call: a separate `acquisition_un1t` board module, so the "skip when state is unknown" rule applies to un1t.online studios only. Reason: Stillorgan's Glofox path stays byte for byte unchanged, with no new read or failure mode (§6.4, A-6).
10. Claude's call: A's `invoices` flip is a hard prerequisite for B's `memberships` flip. Reason: arrears then agree on every surface from day one (§11, A-7).
11. Claude's call: no Hatch acquisition stage starts a sequence in this spec; switching any on is a later, explicit change Richard makes. Reason: nothing customer-facing fires from this work, and upsell is handled by Mia in spec E (§6.9).
12. Claude's call: hourly post-sync reclassify for un1t studios, plus the nightly run. Reason: no webhooks, and one writer cannot flap (§6.5).
13. Claude's call: `joined_at` = later of account creation and newest trial. Reason: a returning trialist re-enters at new_lead (§6.2).
14. Claude's call: Cold (`pipeline_dismissed_at`) and form re-entry count only for contacts Hatch owns. Reason: a Stillorgan dismissal is a Stillorgan judgement (§6.2).
15. Claude's call: the invoice status table, unknown never owed, and a null amount rather than an estimate when only `past_due_at` is set. Reason: never show a made-up debt (§6.10).
16. Claude's call: a viewer sees a studio's un1t payments only with access to that studio, so a Stillorgan-only manager does not see a dual-studio member's Hatch payments. Reason: G1, membership and billing are per studio; only the contact is shared (§6.11).
17. Claude's call: next-class badge hidden on a un1t studio's board in v1. Reason: it would show a dual-studio member's Stillorgan class (§6.8).

## 9. Left to the builder
- Confirm the live invoice and subscription status spellings (including paused and cancelled) with a read of `un1t_invoices`/`un1t_subscriptions` distinct statuses, and adjust the normaliser table; record the answer in the integration spec §0.
- Measure before A1 each expected count in §6.6 (a)-(d) and the A2 "later effect" count, write them into the migration's assertions, and put them in the PR.
- Check Hatch's archived acquisition stage rows before A2 (all 11 slugs present? names unique per pipeline).
- A dry run of Hatch's board before A2: `reclassifyAllContacts` with `dryRun: true` and an `includeDisabled: ['acquisition']` option (the dry run treats the disabled row as `module='acquisition_un1t'`) honoured only when `dryRun`; paste the stage histogram in the PR.
- List active `email_sequences` and scheduled campaigns at Hatch with an audience on `pipeline_stage_slug` or a `pipeline_stage_change` trigger, before A2; any that would now match Hatch-owned contacts on an acquisition stage goes to Richard first.
- Command-centre 404 for a Hatch-only viewer of a Stillorgan-owned contact (`assertLocationAccess(user, contact.location_id)`) predates this spec; check with P1.3 owners and leave behaviour unchanged unless trivially `canViewContact`.

## 10. Tests
- `shapePipelineSnapshot` table tests: active member; past_due member; trialing → trial; trial with 3 credits is not pack; €0 trial `pack` transaction is not a pack customer; paid pack → pack_member; ex member → dormant; ex member who bought a pack after ending → pack_member; ex member holding paid credits → credit_member; ex member who attended after ending → placed by attendance; trial credits 3 with no paid pack → trial, not credit_member; trial then a 5-pack with balance 7 → credit_member with paid credits 5 (1 trial credit used, 2 left); D ledger `op='trial'` with no transaction → trial; `trialEligibility`: new person → eligible; any trial product used → `trial_used`; ended or export-only membership → `membership_history`; recurring transaction with no subscription row → `membership_history`; paid pack → `paid_pack`; history older than the freshness window still counts; a failed read → `success:false`; aggregator booking (`source` not direct) → classpass; Wellhub source → gympass; aggregator who is also a member → member; 1/2/3 attended → first/second/trial_done; upcoming booked → new_lead; aged-out lead → dormant; stale subscription row ignored; a dual-studio contact's populated `contacts` columns are never read (pass contacts rows full of Glofox values, assert the snapshot ignores them).
- `reclassifyAllContacts`: a un1t location uses `pipelineInputs`, selects no Glofox column, issues no `contacts` write; unknown state and unconfigured un1t skip with no deal writes; a failed adapter read skips; a Glofox location's calls and output are unchanged (existing tests stay green untouched, plus a test pinning Stillorgan's exact call sequence with no membership-state read); an unregistered `acquisition_un1t` row is skipped; manual waitlist board never read or written.
- Migration A1 guard test reading the file: every branch filters on the contact's location and `enabled`; no branch assigns NULL; the expected-count assertions are present. A trigger-behaviour table (fixture in SQL or a JS mirror of the rule): primary deal wins; no primary deal → other own-studio board; no own-studio deal → unchanged; closing the last deal → unchanged. Migration A2 guard: waitlist remains primary, Hatch's acquisition module is `acquisition_un1t`.
- Sequence fence: missing location or board → refused; cross-location move; a move that is not the slug source; own-studio slug-source move enrols; `PUT /api/deals/[id]` passes both.
- `pastDue` / `paymentsFor`: shapes, netting, null amount, unknown status, freshness, `contactIds` scoping, pagination; normaliser table.
- Contact page and command centre: Hatch member past due shows the pill and amount; null amount shows the text and the chip; Stillorgan-only viewer sees no Hatch card; Glofox-only contact renders exactly as before.
- `account-tools`: a un1t provider with `invoices: true` never calls `glofoxCredentialsForLocation` or `getGlofoxOverdueInvoices`.
- Capability flag test updated; reader-guard test (§6.12).
- Full CI mirror, `check:select-columns` (new selects name real columns), `check:location-scoping`, `npm run build`.

## 11. Rollout and live verification
1. PR 1: A1 + §6.7 fence. Apply A1 via Supabase MCP on `iyvtbjjxdggiadzwwvdj` before merge, `get_advisors` (security). Verify against the expected counts (§6.6): (a) the dual-studio contacts with a Hatch deal now carry their own studio's slug; (b), (c), (d) zero changes.
2. PR 2: `pipelineInputs`, orchestrator, post-sync hook, badge, seam billing reads, contact page, command centre, account-tools fix. Board still disabled, so inert. Run the Hatch dry run (§9), review the histogram with Richard.
3. Apply A2. Watch the first hourly run: `pipeline_classification_runs` for Hatch `status='success'`, `deals_created` ≈ linked un1t clients, `errors=0`; Hatch-owned contacts without a waitlist deal now carry an acquisition slug, and their number matches the measured "later effect" count; Stillorgan's 03:30 run shows the same `deals_moved` order as the previous nights.
4. Spot-check 3 Hatch members against un1t.online's admin (stage, last payment, subscription) and the MIA TEST account once D has given it a trial booking (it should move new_lead → 1st class after attendance is marked).
5. PR 3: flip `invoices`. Verify one past-due case if one exists (none on 16 Oct); otherwise verify the empty state on a paid member. This flip must be live before spec B flips `memberships` (A-7).

The MIA TEST checks here stop short of paying (G4).

## 12. Dependencies on sibling specs
- **B** (`2026-10-17-hatch-radar-arrears-briefing-design.md`) reuses `pastDue` for arrears, the radar's "cancelling / past-due to the top" and the briefing, and `freshCutoff`. **A's `invoices` flip is a hard prerequisite for B's `memberships` flip** (A-7). B's lead rows should use the same trial rule (purchase or D ledger row, trial credits only) and the same aggregator rule (any non-`direct` booking or `external_member_ref`) as §6.2, so a person is the same thing on the radar and the board. B's studio KPI acquisition numbers at a un1t location must count deals on Hatch's acquisition board, not `pipeline_stage_slug` (which is the waitlist there).
- **C** (`2026-10-17-hatch-bookings-projection-design.md`): independent. A reads `un1t_bookings` directly, so C's projection does not change pipeline inputs.
- **D** (`2026-10-17-un1t-online-write-back-design.md`): D's `bookings` flip makes `get_my_payment_reminder` reachable at Hatch, so §6.12 step 1 must ship first. New people D creates appear on the board at new_lead on the next sync. D's trial grant is read as a trial through its minimal `un1t_transactions` mirror row or its `un1t_write_events` row with `op='trial'`. **D calls A's `trialEligibility` before any trial grant (R1), and E calls it before offering the trial.**
- **E** (`2026-10-17-mia-at-hatch-design.md`) answers billing from `pastDue` / `paymentsFor`, uses `trialEligibility` to choose between offering the trial and the offer list (R1), and decides the "trial finished" upsell trigger itself; it does not read the board.
