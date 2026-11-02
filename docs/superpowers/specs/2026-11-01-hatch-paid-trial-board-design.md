# Hatch Street: €39 Trial board, Waitlist retired — design

Date: 2026-11-01. Decided with Richard in conversation the same day. Status: complete, awaiting Richard's approval of the whole document. Builds on `docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md` (PIPE3, live at Stillorgan since 1 Nov 2026).

## Intent

Hatch Street sells two trials through un1t.online: the free 3-class trial ("1) The UN1T Trial", €0, 3 credits, 7 days) and the **€39 14-day trial** ("The UN1T Trial", €39, unlimited classes, expires after 14 days). The CRM's Hatch pipeline shows the free trial's journey on its Acquisition board and nothing for the paid one. Worse, un1t.online records the €39 purchase as a `pack` transaction, so the CRM files every €39 buyer as a **Class Pack customer** (69 purchases to date), the exact misread PIPE3 fixed at Stillorgan.

Richard's decisions (1 Nov 2026):
- A **€39 Trial board at Hatch, identical to Stillorgan's** ("board for each same as stillorgan"; "no [differences], straight copy"): New Leads → 1st Class → Day 7 → Trial Done → Converted.
- The free trial keeps today's Acquisition board.
- **Retire the Waitlist board.** It holds 180 open cards, every one still in New Enquiry; nobody has ever moved one. 108 of those people are already on the Acquisition board, 4 more have an account and will be placed by its next pass, and **68 are form-only enquiries** (no un1t.online account).
- Form-only enquiries **show on the Acquisition board as New Leads**, age to Dormant after 60 days, and take the normal rules the moment they create an account and book. **Acquisition becomes Hatch's primary board.** The 68 move there now.

## Goals

- Hatch shows two tabs on web and phone: **Acquisition** (primary) and **€39 Trial**. The Waitlist is switched off, its cards closed or moved, its history kept.
- A person whose newest paid-trial purchase is live sits on the €39 board; everyone else is placed by today's Acquisition rules. One person, one board.
- A €39 purchase is **never** a Class Pack on any Hatch reading: not the board, not `pack_customer_at`, not `credit_member`.
- A form-only website enquiry gets a New Leads card on Acquisition the moment the form lands, and the hourly pass keeps it (New Leads for 60 days from the enquiry, then Dormant; Cold respected).
- The same router, claims shape, exits and shared piles as PIPE3: 60 quiet days, Cold by hand, converted window 60 days, a pack bought after the trial's end is Converted.

## Non-goals

- Stillorgan: nothing changes there.
- A Programmes board at Hatch (no 50+ / natal programme sells there).
- Any change to the free trial's rules (TRIALDONE.2 stays: two attended + an expired free trial is Trial Done on Acquisition).
- Sequence triggers on the new slugs (same reasoning as PIPE3: the hourly un1t pass does fire stage triggers, TDSEQ.1, but Richard has asked for no new automations here).
- Deleting data. A board is retired by `enabled = false`; its stage rows and closed deals stay.

## Anti-goals

- Two open deals for one person at Hatch (the Waitlist cutover must leave exactly one).
- A €39 buyer counted as a pack customer anywhere at Hatch, or read as "Converted" because of their own trial purchase.
- A form-only enquiry disappearing from every board (the one thing the Waitlist did for them).
- `ensureDealForContact` writing Hatch deals from Glofox-shaped columns once Acquisition is primary (today it is a no-op at Hatch only because the primary is manual).

## What exists today (constraints the builder inherits)

- Hatch (`28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`) boards: `acquisition` (module `acquisition_un1t`, `inputSource 'un1t_online'`, enabled, display_order 0, **not** primary) and `waitlist` (manual, **primary**, display_order 1). `returning` does not exist at Hatch.
- The un1t path in `reclassifyAllContacts` (`src/lib/pipeline-reclassify.js`): inputs come from `membershipReadsFor(db, locationId).reads.pipelineInputs` (`src/lib/membership/reads/un1t-online.js` → `shapePipelineSnapshot` in `un1t-online-shape.js`), which covers **only contacts linked to a `un1t_clients` row**; a location mixing contacts-input and un1t boards refuses the un1t boards; **one** `classify` (the first un1t board's) places everyone; moves fire `pipeline_stage_change` triggers (TDSEQ.1, mass-move guard 50). It runs hourly after a good sync (`maybeReclassifyAfterSync`, `src/lib/un1t-pipeline-cadence.js`) and nightly.
- `shapePipelineSnapshot` output keys = `classifyContact`'s inputs plus `trial_expires_at`. `isTrialProduct(p)` = `one_time` **and €0**; `isPaidPack(t)` = `product_type 'pack'`, `amount_cents > 0`, not refunded, not a trial product. The €39 product (`un1t_products.un1t_id 674d62bf-4d4b-4231-b1ba-d53543657bea`, `type one_time`, `price_cents 3900`, `credits_per_period -1`, `raw.expire_credits_in_days 14`) therefore reads as a **paid pack**: `pack_customer_at` = its purchase time, `paidCredits > 0` → `credit_member`. `firstSales` counts only `sub_initial` transactions, so the €39 purchase does not stamp `converted_at`.
- The paid-trial product is already configured in one place: the studio page's `paid_trial` landing block, `un1t_product_id` (`src/lib/trial-studios.js`, `trialEntryFromRow`). CRM-side purchases also land in `trial_purchases` (`un1t_product_id`, settled from the `un1t_transactions` mirror), but a purchase made directly on un1t.online has no such row, so **the mirror is the source**.
- PIPE3 pieces to reuse as they are: `shared/pipelines/paid-trial.js` (`stages`, `paidTrialClaim`, `claimLive`, `classify`), `shared/pipelines/router.js` (`routeContact(contact, claims, now, boards)`), the `boards_moved` / `duplicate_deals_closed` handling in the orchestrator, the web labels/colours/chips for the `paid_trial_*` slugs, the phone's board picker, `OWN_STUDIO_MEMBER_SLUGS` and `EXCLUDING_MODULES`.
- `contacts.pipeline_stage_slug` follows the enabled primary (mig 736). 162 Hatch contacts carry `waitlist_new_enquiry` today; no Hatch sequence or campaign filters on a `waitlist_*` slug (checked 1 Nov).
- `placeWaitlistEntry` (`src/lib/waitlist-entry.js`): on a derived primary it opens a deal at the board's entry column when the person has none at the location (PIPE3 made that read location-wide); on a manual primary it also bumps a re-submission back to the entry column.
- `ensureDealForContact` (`src/lib/glofox-sync.js`) leaves a location alone when its primary is manual. Once Hatch's primary is the derived `acquisition_un1t`, it would place Hatch contacts from Glofox-shaped columns (empty at Hatch) unless fenced. Callers that reach Hatch: the Cold route (which also runs `reclassifyUn1tBoardNow`, HATCHCOLD.1) and `placeContactNow` from the class-booking route.
- Hatch today: 247 contacts, 173 with an account, 74 form-only (67 of them hold the open Waitlist cards; 15 created in the last 60 days).

## The boards

Hatch runs two enabled derived boards, both `inputSource 'un1t_online'`:

| Key | Module | Primary | Order | Columns |
|---|---|---|---|---|
| `acquisition` | `acquisition_un1t` (unchanged) | **yes** (was the Waitlist) | 0 | today's funnel + shared piles |
| `paid_trial` | **`paid_trial_un1t`** (new) | no | 1 | New Leads, 1st Class, Day 7, Trial Done, Converted |
| `waitlist` | manual | no | 2 | **disabled** |

`paid_trial_un1t` re-exports `stages` and `classify` from `shared/pipelines/paid-trial.js` by reference (the acquisition_un1t pattern), declares `inputSource = 'un1t_online'` and `requiredFields = ['id','name','email','location_id']`. Slugs `paid_trial_*` are new at Hatch, so no collision. Stage rows mirror the module (601–605).

## The paid-trial product, and why it is not a pack

**Which products are the paid trial** is per studio: the set of `un1t_product_id`s in the studio page's `paid_trial` landing block(s), unioned with `locations.settings.pipelines.paid_trial.un1t_product_ids` (seeded `['674d62bf-4d4b-4231-b1ba-d53543657bea']`; the Stillorgan programmes-rules pattern, so a second paid trial product plugs in without a deploy). The pipelineInputs read resolves the set once per pass and hands it to the snapshot builder.

Inside `shapePipelineSnapshot`, a transaction for a paid-trial product is **never a paid pack** (`isPaidPack` excludes it), never counts toward `paidCredits`, and never stamps `pack_customer_at`. Instead the snapshot gains two fields:
- `paid_trial_at` — the newest non-refunded paid-trial transaction's `remote_created_at`, or null;
- `paid_trial_expires_at` — that instant plus the product's `expire_credits_in_days` (14) × 24 h, or null when the product carries no positive expiry.

The paid claim for the router is `{ start: paid_trial_at, end: paid_trial_expires_at, durationDays }`, built from those two fields. Everything else about the €39 journey (`attendedSince`, `convertedSince` with a pack only from `end`, `claimLive`'s 60 quiet days and 60-day converted window, Day 7 at `start + 7d`, Trial Done at `end`) is the Stillorgan module's code, unchanged. "Converted" at Hatch is the snapshot's `member` status: a fresh un1t.online subscription that holds a membership.

**Backfill of the misread.** The snapshot is rebuilt from the mirror every pass, so the 69 buyers stop reading as pack customers the first time the new code runs; no stamp lives on a contact row at Hatch (the Hatch snapshot never writes `pack_customer_at`). The migration still clears `contacts.pack_customer_at` for Hatch-home contacts whose only "pack" is a paid-trial transaction, in case an earlier path stamped the row.

**How far "never a Class Pack" reaches** (the builder check asked; `isPaidPack` has three consumers):
- The board snapshot (`shapePipelineSnapshot`): yes, as above.
- **Free-trial eligibility and Mia's trial-done offer** (`shapeTrialEligibility`'s `paid_pack` reason; `src/lib/agent/trial-done.js` reads it as "bought something"): the **behaviour stays**, the label changes. A €39 buyer has had a trial and has paid, so they remain ineligible for the free 3-class trial and Mia keeps treating them as a purchaser; the reason becomes `paid_trial` rather than `paid_pack`, so the copy and the logs say the true thing. My call: behaviour-preserving, and the Stillorgan rule already counts a granted paid trial as trial history.
- **The studio dashboard's pack-holder count and the Churn Radar's `credit_member` rows** (`packHolderIds`, `shapeCounts`, `listPackTransactions`): **excluded too.** Richard, 1 Nov 2026: "it's a trial membership, not a packholder." The pack-holder KPI drops by up to 69 and the radar shows those people as trialers. Any read that asks "is this transaction a paid pack" at a un1t.online studio excludes the studio's paid-trial products.

The product set is resolved once, in the un1t read adapter, and handed to every read that asks (`pipelineInputs`, `trialEligibility`, the dashboard counts, the radar rows, `listPackTransactions`), never re-derived per consumer. `isPaidPack(t, productsById, paidTrialProductIds)` is the one predicate; a caller that forgets the set gets today's behaviour, so the builder adds a guard test that every un1t read passes it.

## Routing on the un1t path

Per contact in the pass: `routeContact(snapshot, { paid, programme: null }, now, boardKeys)` where `boardKeys` is the set of enabled derived board **keys** at the location (`acquisition`, `paid_trial`; the router's `boards` argument is read as keys from now on, which is what Stillorgan's modules already equal). Cold and Gympass piles beat the claim; a live paid claim → `paid_trial` board classified by the paid module; else today's `acquisition_un1t` classify (TRIALDONE.2 included). Deals move across boards with `pipeline_id` + `stage_id` in one update; a surplus open deal is closed `lost`; PIPEEXCL applies to both boards. The un1t path's existing per-move sequence triggers keep firing for acquisition moves; moves onto `paid_trial_*` stages fire too, but no sequence names those slugs (non-goal).

## Form-only enquiries on Acquisition

`pipelineInputs` adds every **Hatch-home contact with no `un1t_clients` row at all (fresh or stale) and a public-form touch (`last_lead_source_at`)** to its contact set with a minimal snapshot. The touch is positive evidence of an enquiry; "no account" alone is not (checked 1 Nov: of Hatch's 74 account-less contacts, 45 of the 68 on the Waitlist were **race signups** with no form touch, which the existing rule for a race entry at Stillorgan (CROSSOVERDEAL.1) already says is not a lead). My call, after the automated security review raised it; Richard can widen it to race entrants. The snapshot: `glofox_membership_status 'lead'`, **`joined_at = the later of contact.created_at and last_lead_source_at`** (the enquiry, not the row's birth: a 2025 race entrant who fills the Hatch form today is a fresh New Lead, and a repeat enquiry revives a Dormant one, which is the one thing the Waitlist did for them; the public leads route stamps `last_lead_source_at` on every submission), `recent_bookings []`, `last_attended_at null`, `pipeline_dismissed_at` / `last_lead_source_at` from the contact (owned), everything else null, `trial_expires_at null`, `paid_trial_at null`. `classifyContact` then gives `new_lead` for 60 days from that instant and `dormant` after; Cold and its revocation work as everywhere. `evidence` for such a contact carries `client_created_at` = the same instant so a created deal is dated at the enquiry. My call. The moment the person creates an account, the client row links to the contact (existing sync behaviour) and the full snapshot takes over. PIPEEXCL applies (a Stillorgan member enquiring at Hatch gets no card, as today).

`placeWaitlistEntry` needs no change: with Acquisition as the derived primary it opens a New Leads card for a brand-new enquiry at once and leaves an existing deal alone.

**Fence:** `ensureDealForContact` returns `{ action: 'leave' }` when the location's primary board's module declares `inputSource 'un1t_online'` (placement there is the un1t pass's; the Cold route already runs it, `reclassifyUn1tBoardNow`). `placeContactNow` inherits the fence.

## Retiring the Waitlist (the cutover migration)

One transaction, Hatch only, in this order, with hash self-checks like migs 597/598/741/797:
1. Insert the `paid_trial` board **disabled** (`display_order 1`) and its five stage rows; move `waitlist.display_order` to 2.
2. Seed `settings.pipelines.paid_trial.un1t_product_ids` when absent.
3. Waitlist open deals: for a contact who also holds an open **acquisition** deal → close the waitlist deal `lost` (108 today); for a contact with an account or a public-form touch → **move** it onto acquisition at `new_lead` (`pipeline_id` + `stage_id`; the next pass re-places account holders and ages stale enquiries); for a contact with neither (the race signups) → close `lost` (they get no card, as a race entry alone is not a lead). Count all three and raise if any waitlist deal stays open.
4. `waitlist.is_primary = false`, `enabled = false`; `acquisition.is_primary = true` (the partial unique index allows it inside the transaction once the waitlist row is cleared first).
5. Clear `contacts.pack_customer_at` for Hatch-home contacts whose paid "pack" transactions are all paid-trial products.
6. Self-check: acquisition is the one enabled primary at Hatch; no open waitlist deal; no deal row outside Hatch changed; Stillorgan's `pipelines` rows unchanged; every moved deal sits on acquisition at `new_lead`.

A second migration enables `paid_trial` after Richard reads the dry run (`includeDisabled: ['paid_trial']` on the un1t path dry-runs the row as `paid_trial_un1t`).

`contacts.pipeline_stage_slug` for the 162 `waitlist_new_enquiry` contacts re-derives from their acquisition deal (mig 736's trigger fires on the deal update) → `new_lead`, later `dormant`.

**Sequences and the cutover** (checked 1 Nov against Hatch's live sequences): the migration's own moves are SQL and fire no sequence (the un1t pass's `fireStageTriggers` fires only for moves the pass itself lands). The first pass after the cutover moves the stale form-only enquiries `new_lead → dormant` (more than 50 in one run would be held by the mass-move guard; fewer fire nothing because no Hatch sequence is keyed on `dormant`). Hatch's only `pipeline_stage_change` sequence is "Trial Done – Membership / Class Pack" (`to_status: trial_done`); an account-holder the pass places at `trial_done` for the first time will get it, which is the nudge they were owed while parked on the Waitlist. No sequence names a `paid_trial_*` slug, so enabling the €39 board fires nothing.

## What the rest of the CRM sees

- Web and phone show two tabs at Hatch. The Waitlist's columns and closed cards remain readable in the deal history. The deal-detail stage picker (manual boards only) simply never offers at Hatch any more.
- Audiences at Hatch keyed on `pipeline_stage_slug` now see acquisition and `paid_trial_*` slugs; none referenced `waitlist_*`.
- The hourly pass's result gains the PIPE3 fields (`boards_moved`, `duplicate_deals_closed`, dry-run `board_histogram`).
- `/api/locations/[id]/pipeline-programmes` is unchanged; the paid-trial product list is a setting without a card (the landing block is where the operator already picks the product; the setting is a fallback). My call.

## Rollout

1. Apply the cutover migration (Waitlist retired, 72 cards moved, 108 closed, `paid_trial` seeded disabled). Hatch keeps working on the acquisition board alone.
2. Merge and deploy the code (OTA to staff phones: nothing in `mobile/` changes, but `shared/pipelines/` does, a no-op publish).
3. Dry run on Hatch with `include_disabled: ['paid_trial']`; Richard reads `board_histogram` and `movement_matrix` (expect every live €39 buyer to leave Class Pack / 1st Class etc. for the €39 board).
4. Enable migration; the next hourly pass moves the cards.

## Left to the builder

- Where the paid-trial product set is resolved (the pipelineInputs read is the natural place: it already reads `un1t_products`; it adds a read of the studio's `paid_trial` block via `trial-studios.js` and the setting).
- How `shapePipelineSnapshot` receives the set (a `paidTrialProductIds: Set` argument, default empty → today's behaviour exactly for every test that does not pass it).
- Whether `evidence`/`un1tDealDates` learns `paid_trial_*` stage dates (the created-deal date for a €39 board card should be the purchase; a move takes the trigger's stamp as today).
- Test coverage: the snapshot with and without the product set (pack vs paid trial; `credit_member` no longer); the router on the un1t path (acquisition vs paid, Cold over paid, expired claim back to acquisition); form-only contacts in `pipelineInputs` (new_lead within 60 days, dormant after, Cold respected, excluded when active elsewhere); the `ensureDealForContact` fence; the cutover migration in PGlite (moves, closes, primary flip, idempotency, rollback when any waitlist deal would stay open); the `includeDisabled` dry-run mapping for `paid_trial_un1t`.

## Open questions for Richard

None. The pack-holder question was answered 1 Nov 2026 (a €39 buyer is a trial member, never a pack holder, on every read). After the dry run he may want to rename the tab (a column value).
