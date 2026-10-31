# Stillorgan: three pipelines — design

Date: 2026-10-31. Decided with Richard in conversation the same day. Status: draft, awaiting Richard's approval.

## Intent

UN1T Stillorgan sells three different journeys, and the CRM pipeline shows one. Today every Stillorgan contact is squeezed through the Glofox acquisition board, whose columns describe the **3-class free trial** (New Leads → 1st Class → 2nd Class → Trial Done → Converted). Two groups of people do not fit it:

- **€39 14-day trial buyers** (the `/trial` page, live since 24 Oct 2026). Their trial is time-boxed, not class-boxed. "2nd Class" means nothing to them; "halfway through the 14 days" does.
- **Programme leads: 50+ and pre/post natal.** They get **one** free class, not three. A 50+ lead who has done their one class and not joined reads on today's board as "1st Class, two to go", which is the wrong sales conversation.

Richard wants each group on its own board so a staff member looking at a tab sees people who are at the same point in the *same* journey, and the column name tells them what the next call is.

## Goals

- Three tabs on Stillorgan's pipeline page (web and phone): **Acquisition** (the free trial, unchanged), **€39 Trial**, **Programmes**.
- Every Stillorgan person sits on **one board at a time**, placed by rules, nightly and on the Glofox webhook path, exactly as the acquisition board is today. Nobody drags cards.
- The €39 Trial board has the free-trial shape with one column swapped: **New Leads → 1st Class → Day 7 → Trial Done → Converted**.
- The Programmes board has three columns: **Lead → 1st Class Done → Converted**.
- People who stall leave the trial boards for the acquisition board's existing Dormant pile after 60 quiet days, or its Cold pile when a staff member presses Cold. The off-funnel piles are **shared**, not duplicated.
- The rule for "who is a programme lead" is a **setting**, seeded for 50+, so the `/postnatal` page plugs in without a code change when Richard builds it.

## Non-goals

- Hatch Street. Its €39 trial is sold through un1t.online and its boards are its own. Nothing here touches Hatch's pipelines rows, modules or classifier path.
- New sequences or emails for the €39 journey (a "Day 7" nudge, say). The boards make the moment visible; the automation is a later decision.
- A board-builder UI. Boards stay code (Richard, 2026-09-08). The one new setting is the programme lead-source / plan list, nothing more.
- Reviving the parked Returning board, or changing any rule of the acquisition classifier for people who stay on it.
- Pre/post natal specifics beyond the entry rule. The `/postnatal` page does not exist yet; when it does, its lead source is added to the setting.

## Anti-goals (what would make this a failure even if it "works")

- **A person on two boards**, or a deal that flaps between boards night to night. The acquisition board's history is full of this (PIPELINE-FLAP): a placement path that routes differently from the nightly run is the exact defect. There must be **one router** every placement path calls.
- **Dormant or Cold piles on the new boards.** Richard agreed the piles are shared; a "Dormant" column on the €39 board would split the ghost list three ways.
- **People vanishing.** Someone who leaves a trial board must land on the acquisition board's correct pile the same run, never nowhere. Removing a silent failure must never create a louder one.
- **Audiences or sequences silently reading a different person.** `contacts.pipeline_stage_slug` is read by the audience builder and by sequence auto-exit continuously; its meaning for anyone on the new boards must be stated and tested, not discovered.
- **Hard-coding `meta_50plus`.** The whole point of the setting is `/postnatal`.

## What exists today (constraints the builder inherits)

- `pipelines` (mig 594): one row per board per location; `key` is identity, `module` binds code, `mode` is `derived` or `manual`, exactly one `is_primary` per location. Stillorgan has `acquisition` (enabled, primary, module `acquisition`) and `returning` (disabled, parked).
- `pipeline_stages.slug` is **unique per location** (`pipeline_stages_location_slug_unique`), so a second board at Stillorgan cannot reuse `new_lead`; Hatch's waitlist used a `waitlist_` prefix for this reason, the returning board `returning_`. Names are unique per board (`pipeline_stages_pipeline_name_unique`, mig 597).
- Board modules live in `shared/pipelines/` (`acquisition.js`, `acquisition_un1t.js`) and are registered in `shared/pipelines/index.js`. A module declares `stages`, `requiredFields` (the contacts columns its rules read; the orchestrator SELECTs the union) and `classify(contact, now)`. A module that can abstain returns `null` and "the orchestrator closes the deal" is the documented contract, though no contacts-input module abstains today.
- The nightly orchestrator `src/lib/pipeline-reclassify.js` runs every enabled derived board at a location, builds one `slug → stage` map across them, calls `classifyContact()` **once** per contact and assumes one open deal per contact (`dealByContact` keeps the first). It has never had two contacts-input boards at one location; the design below is the first time it will.
- The webhook path `ensureDealForContact()` (`src/lib/glofox-sync.js`) places a contact on the location's **primary** board only, calling `classifyContact()` directly. The Cold route (`POST /api/contacts/[id]/pipeline-status`) re-places through the same function. Other direct callers of `classifyContact()` (command centre, churn radar, engagement analytics, the contact page) only *read* a slug for display.
- `contacts.pipeline_stage_slug` (mig 595, refined by mig 736) follows the newest open deal on the **primary** board, and when the contact has no open primary deal it falls back to the newest open deal on any **enabled** board at the contact's own studio. So a person whose only open deal is on the €39 Trial board will carry that board's slug in `pipeline_stage_slug`, and in `contact_studios.stage_slug` / `studio_stage_slug`, which the audience builder filters on (`AUDIENCE_FIELDS.pipeline_stage_slug` → `studio_stage_slug`).
- Sequences fire on `pipeline_stage_change` with optional `from_status`/`to_status` slugs; the picker lists `PIPELINE_SLUGS` (the acquisition slugs). `KanbanBoard.jsx` colours columns from a hard-coded `stageColors` map by slug. The contact page labels the stage from the slug.
- The Cold stamp is `contacts.pipeline_dismissed_at` at the home studio (mig 777 adds a per-studio table for non-home studios). The classifier revokes Cold when the person trains or comes back through a public form (`last_lead_source_at` newer than the dismissal).
- The paid trial is `trial_purchases` (mig 762, service role only): `contact_id`, `location_id`, `status` (`awaiting_payment | queued | processing | granted | needs_review | failed | payment_failed`), `payment_status`, `paid_at`, `granted_at`, `duration_days` (default 14), `plan_code`, `membership_id`. The checkout stamps `contacts.lead_source` (first touch) and `last_lead_source` / `last_lead_source_at` (every touch) with the trial product's lead source (`meta_trial` in prod), and places an acquisition deal at the entry stage before payment through `placeWaitlistEntry` (`src/lib/waitlist-entry.js`).
- **Verified on prod 2026-10-31**: a granted €39 buyer syncs from Glofox as `glofox_membership_status = 'trial'`, `glofox_membership_plan = 'The UN1T 14 Day Reset Trial'`, `glofox_membership_type = 'num_classes'`, **`trial_credits_remaining = 10`**, `converted_at` null. So Glofox does not report them as a member and conversion can be judged on a later member status. But the plan name is useless as a buyer signal: 2,434 Stillorgan contacts hold that plan name from years of Glofox's own 14-day trial. Only `trial_purchases` identifies a €39 buyer.
- **The 10 credits collide with the Class Pack rule.** `shouldStampPackCustomer` (`glofox-sync.js`) stamps write-once `contacts.pack_customer_at` on any non-member observed with ≥ 4 credits ("trials are ≤ 3"), and `classifyContact` files anyone stamped or holding ≥ 4 credits as `pack_member`, off-funnel, for ever. The one synced €39 buyer is stamped and sits in Class Pack today. (Measured the same day: ~320 Stillorgan contacts with a trial or lead Glofox status carry the stamp, mostly off the 7 Day Trial, the 14 Day Reset Trial and Black Friday Open Week plans. That wider misread is **not** in this project's scope; it is raised to Richard as a separate question.)
- The `/50plus` page stamps `last_lead_source = 'meta_50plus'`, tag `stillorgan-50plus`, and grants the configured trial plan (**"The Elites Trial"**) in Glofox, whose name then appears in `contacts.glofox_membership_plan` (mig 192). Verified: the plan name is overwritten on every sync with whatever membership Glofox currently returns, so a 50+ lead who joins shows "Elite Membership" (a real membership plan at Stillorgan, 7 holders) and the trial name is gone. 17 contacts hold "The Elites Trial" today, almost all 2025 leads now dormant.
- The phone's pipeline tab reads `pipelines` and `pipeline_stages` through RLS and splits columns on `is_dormant` with `splitStagesByFunnel`; it imports nothing from `shared/pipelines/`. `shared/**` is an OTA publish path.
- Dry runs exist: `reclassifyAllContacts({ dryRun: true })` returns a `stage_histogram` and `movement_matrix`, surfaced on the admin Pipeline Reclassify tab. Mig 594's rule stands: a seed insert must count its rows, never trust `on conflict do nothing`.

## The boards

All three are `mode = 'derived'` at Stillorgan (`a0000000-0000-0000-0000-000000000001`). **Acquisition stays `is_primary`.** Tab order: Acquisition 0, €39 Trial 1, Programmes 2.

### Board 1 — Acquisition (unchanged)

The free 3-class trial board, module `acquisition`, every column and rule as today. It also keeps the estate's **only** off-funnel piles at Stillorgan: Member, Class Pack, ClassPass, Gympass, Dormant, Cold. People who leave the two new boards land here.

### Board 2 — €39 Trial

`key = 'paid_trial'`, name **€39 Trial** (Richard can rename the row), module `paid_trial`. Columns, all on-funnel (`is_dormant = false`), slugs prefixed `paid_trial_`:

| # | Name | Slug | Who |
|---|------|------|-----|
| 1 | New Leads | `paid_trial_new_lead` | Paid (or granted), no class attended yet, fewer than 7 days into the trial |
| 2 | 1st Class | `paid_trial_first_class` | Attended at least one class since the trial started, fewer than 7 days in |
| 3 | Day 7 | `paid_trial_day_7` | 7 or more days in, trial not yet over, not converted, **whether or not they have trained** |
| 4 | Trial Done | `paid_trial_done` | The 14 days are up, not converted |
| 5 | Converted | `paid_trial_converted` | Bought a membership during or after the trial |

Richard's decisions: the shape ("same flow and columns as the free trial"), and that column 3 is "7 days into the 14 day trial" in place of 2nd Class.

My calls, stated so Richard can reject them:
- **The clock starts when Glofox granted the trial** (`trial_purchases.granted_at`), falling back to `paid_at` while the grant is pending or under review. The trial length is the row's `duration_days`. Day 7 is 7 × 24 h after that instant; Trial Done is `duration_days` × 24 h after it. Elapsed time between instants, no wall-clock date parsing (the TZ invariant).
- **Day 7 holds everyone 7–14 days in who has not converted, trained or not.** It is a time checkpoint for the sales call, not an attendance count. Someone who trains on day 9 stays in Day 7.
- **Converted** means a Glofox member status (`member` / `credit_member`) seen after the trial start, or a Class Pack purchase after it (`pack_customer_at` at or after the trial start, or a pack observed after the trial's own credits are gone). Buying a pack IS a conversion (FUNNEL.3) and it is one here too. Converted stays on this board for the acquisition board's existing 60-day converted window, then the person leaves to the acquisition board's Member or Class Pack pile.
- **The trial's own credits are never a Class Pack.** While a €39 claim is live, the board's rules ignore `trial_credits_remaining` and `pack_customer_at`, the sync must not stamp `pack_customer_at` for a contact with a live claim, and the migration clears the stamp on any contact whose stamp landed while they held a granted €39 trial (one person today). Without this the buyer is filed as a pack customer on day 0 and, being write-once, stays off the funnel for ever after the trial.
- A buyer whose payment landed but whose grant is `queued` / `processing` / `needs_review` is a New Lead from `paid_at`: they have paid, the board should show them.

### Board 3 — Programmes

`key = 'programmes'`, name **Programmes** (my name; Richard called it "the 50+ board", but it also takes pre/post natal, and he can rename the row), module `programmes`. Columns, all on-funnel, slugs prefixed `programme_`:

| # | Name | Slug | Who |
|---|------|------|-----|
| 1 | Lead | `programme_lead` | Qualifies as a programme lead, no class attended since they came in |
| 2 | 1st Class Done | `programme_first_class` | Attended one class (their one free class) since they came in, not converted |
| 3 | Converted | `programme_converted` | Bought a membership after coming in |

Richard's decisions: the three columns and their names; that programme people get one free trial class; the entry sources (below).

**Who is a programme lead** (Richard): someone who came in on the `/50plus` landing page, or whose Glofox profile carries the Elite trial plan, or who comes in on the `/postnatal` page once it exists. Expressed as a **setting on the Stillorgan location**, seeded by the migration:

- `lead_sources`: `['meta_50plus']` — matched against `contacts.last_lead_source` (and `lead_source` for first-touch-only rows)
- `glofox_plan_patterns`: `['elites trial']` — case-insensitive substring match against `contacts.glofox_membership_plan`. Not `elite`: "Elite Membership" and "3 Month Elites Membership" are real membership plans at Stillorgan and must not match.

Adding `/postnatal` is adding its lead source (by the editor's convention, `meta_postnatal`) and, if it has one, its trial plan name. The setting lives in `locations.settings` (service-role only, so a server read) and is edited from the location's settings page. My call: a small "Pipeline" section with two tag-list fields, nothing else.

**The claim is recorded, not re-derived.** My call, forced by two facts: the Glofox plan name is overwritten on every sync, so a plan-matched lead who joins stops matching at the exact moment they should enter Converted; and a match re-evaluated from live columns on the webhook path and on the nightly run is the PIPELINE-FLAP shape. So the first time the router matches a contact (a lead source or a plan name), it writes a claim row: `(contact_id, location_id, board_key = 'programmes', claimed_at, source)`, service role only. From then on the router reads the claim, never the plan name. A new matching public entry (a second `/50plus` signup after the claim went quiet) renews the claim with the newer `claimed_at`. The paid trial needs no such row: its `trial_purchases` row is already the claim.

My calls on the rules:
- **The programme claim starts** (`claimed_at`) at the matching `last_lead_source_at` for a lead-source match, and at the moment the sync first sees the plan for a plan-only match. The migration backfills a claim for every current "Elites Trial" holder dated at their `joined_at`, which makes the 2025 holders' claims already past the 60 quiet days: they stay where they are on the acquisition board, which is right. Attendance and conversion count only from the claim start, so a lapsed 2024 member who signs up on `/50plus` is a Lead, not "1st Class Done" on the strength of old classes.
- **1st Class Done** is `last_attended_at` at or after the claim start. A second class does not move them; there is no column for it.
- **Converted** is as on board 2: a member status, or a pack purchase, after the claim start, held for the 60-day converted window, then off to the acquisition board's Member or Class Pack pile.

## Routing: one person, one board

A single router decides a Stillorgan contact's board and column. It is the **only** placement authority: the nightly orchestrator, the Glofox webhook path (`ensureDealForContact`) and the Cold route's re-place all call it. A path that still calls `classifyContact()` directly for *placement* is the anti-goal.

Order of precedence, first match wins:

1. **Cold.** A live dismissal (`pipeline_dismissed_at`, not revoked by training or a public re-entry since) → acquisition board, `cold_lead`. The Cold button works on cards of all three boards and always lands here. (Richard: "agreed, or manually marked as cold".)
2. **Gympass.** A Gympass user cannot be sold a membership (GYMPASS.2), so the acquisition board's `gympass` pile outranks any claim. My call.
3. **Live €39 trial claim** → €39 Trial board, its module decides the column. A claim is live from `paid_at` until the person has had **60 quiet days** after the trial ended (no class and no payment since `granted_at + duration_days`), or until their Converted window ends. Richard agreed paid wins over the programme signal. A ClassPass or Class Pack reading does not end the claim: they bought from us, and a pack is their Converted.
4. **Live programme claim** → Programmes board. Live from the claim start until 60 quiet days with no class and no payment (a Lead who never books falls off 60 days after the claim start; a 1st Class Done falls off 60 days after that class), or until their Converted window ends.
5. **Everyone else** → acquisition board, exactly today's `classifyContact()`. This is where members, Class Pack, ClassPass, Gympass, Dormant and the free-trial funnel live, and where people leaving boards 2 and 3 land (Dormant after a quiet spell, Member or Class Pack after conversion ages out).

Richard's decision: 60 quiet days then Dormant, or Cold by hand. Richard agreed the precedence order (paid, then programme, then everyone else) as proposed; the Gympass and pack rulings are mine.

Consequences the builder must honour:
- A person's **deal moves with them** when the router changes their board: the same `deals` row gets the new `pipeline_id` and `stage_id` in one write (legal: `deals_one_open_per_contact_pipeline` is per board, mig 598), so their history (stage-entered stamps, "Pipeline: moved to…" activity rows, notes) stays continuous and there is still exactly one open deal per person at Stillorgan. Never close-and-recreate (it would inflate `lost` counts and sever the history), never delete. My call.
- The PIPEEXCL rule (active member or training at another studio of the organisation leaves every derived acquisition board, deal closed `lost`) applies to **all three** boards. A Hatch member is not a Stillorgan €39 prospect either. The two Converted slugs join `OWN_STUDIO_MEMBER_SLUGS` (`pipeline-other-studio-members.js`) so a person who converted here is kept here.
- **Scope stays as today**: the nightly run reads contacts whose home is Stillorgan, and the webhook path keeps CROSSOVERDEAL's no-create rule for sibling-studio contacts. The `trial_purchases` and claims reads are keyed by the run's contact set, not by `location_id` alone. A Hatch-home person who buys the Stillorgan €39 trial is therefore placed only as they are today (by the webhook path, if at all). My call: acceptable for now, noted so nobody reads it as an oversight.
- The acquisition module keeps never abstaining; the two new modules are never asked about someone the router did not send them. So no module needs the "abstain → close" contract; the router replaces it.
- `placeWaitlistEntry` (the `/trial` checkout's pre-payment deal) goes through the router like every other placement path; it already creates nothing when a deal exists.

## What the rest of the CRM sees

- **`contacts.pipeline_stage_slug`** for someone on the €39 Trial or Programmes board will be that board's slug (`paid_trial_day_7`, `programme_lead`, …) through mig 736's fallback (newest open deal on any enabled board at the contact's own studio), because they have no open deal on the primary board. This is **intended**: it lets an **audience** target "everyone at Day 7". The builder adds the new slugs and labels to every picker and label map that lists stages for display or audiences (the audience builder's stage options, `stageColors` in `KanbanBoard.jsx`, the contact page's stage label, the contacts list chip) so a new slug never renders as a raw string or a grey dot. Any test that asserts the slug universe is the acquisition set is updated to the three-board universe.
- **Sequence triggers: the new slugs are deliberately NOT offered** in the sequence settings' From/To stage pickers (`PIPELINE_SLUGS` stays the acquisition set). The nightly contacts path fires no `pipeline_stage_change` triggers (only the un1t.online path does, TDSEQ.1), and Day 7 and Trial Done are crossed by the nightly run, never by a webhook, so a sequence keyed on them would silently never fire. Offering a trigger that cannot fire is the anti-goal. A "Day 7 nudge" automation is a follow-up that needs the contacts path to fire stage triggers with TDSEQ.1's mass-move guard, and a decision about the one-off enable run that moves everyone at once. My call.
- **Existing sequences** keyed on acquisition slugs (`new_lead`, `first_class`, the 3-Class Trial nurture) **stop firing** for people the router moves to a trial board, because those people no longer enter acquisition slugs. That is correct: the 3-Class Trial copy is wrong for a €39 buyer.
- **`contact_studios.stage_slug`** and the audience view's `studio_stage_slug` follow the deal at the studio as today; nothing changes in their derivation.
- **Reports** that count deals per stage at Stillorgan will see the new slugs. The builder checks the pipeline/funnel report readers for a hard-coded acquisition slug list and either includes the new slugs or scopes the report to a board.

## Rollout

1. **Migration** (forward-only, applied before the code deploys, `get_advisors` after): the two `pipelines` rows at Stillorgan **disabled**, their stage rows (conflict-targeting slug, counting rows, the mig 597 shape), `display_order` 1 and 2, the programme setting seeded into Stillorgan's `locations.settings`, the claims table (service role only, RLS on, no policy, the mig 677 default) backfilled for current "Elites Trial" holders at `joined_at` and for `meta_50plus` lead sources at `last_lead_source_at`, and `pack_customer_at` cleared where it was stamped during a granted €39 trial. `is_primary` does not move; the migration self-checks that the acquisition board is still the one enabled primary and that no other location changed.
2. **Code deploys** with the two modules registered and the router in place. A disabled board renders nowhere and the orchestrator ignores it, so this is inert.
3. **Dry run** on the admin Pipeline Reclassify tab with the disabled keys included (the `includeDisabled` mechanism, which today assumes `acquisition_un1t`; the builder generalises it to the row's own module). Richard reads the histogram: how many people land on each board and column, and the movement matrix off the acquisition board. Nothing moves until he has seen it.
4. **Enable** both rows (a second data-only migration, mig 741's shape). The next nightly run moves the deals; the run's `movement_matrix` is the record.
5. `docs/changelog/entries/<PR>.md`, and a line in `CLAUDE.md` invariants only if a durable rule emerges (candidate: "every Stillorgan placement path calls the router, never `classifyContact()`").

## Left to the builder

- Module file layout and how a module reads inputs that are not contacts columns (`trial_purchases` for board 2): one read per run keyed by `contact_id`, merged into the snapshot, in the same spirit as the un1t path's `loadUn1tInputs`; the webhook path reads one contact's rows.
- The exact `locations.settings` key path and the settings UI placement, within the constraint that the two lists are editable without a deploy.
- Colours for the new columns (the `stages` arrays carry `color`; `stageColors` must agree).
- How `includeDisabled` dry runs name the module for a disabled row.
- Test coverage: router precedence (every pair of signals), the Day 7 / Trial Done boundaries at the instant, the 60-quiet-day exits for each board, the claim-start rule against pre-claim attendance, deal moves across boards keeping one open deal, the Cold route landing on the acquisition board from each board, and a dry-run against a fixture of Stillorgan-shaped contacts proving the acquisition board's own placements do not change for anyone with no claim.
- Mobile needs no code change if the tabs and columns come from the tables as they do today; the builder confirms the phone renders a board with three columns and no off-funnel view cleanly, and notes the no-op OTA from `shared/`.

## Open questions for Richard

One, outside this project's scope but found while checking it: **should a Glofox account whose status is still a trial or lead status ever count as a Class Pack customer?** Today ~320 Stillorgan contacts with status `trial`, `lead`, `cold` or `no_sale_tour` carry the write-once pack stamp because a trial plan handed them 4+ credits (7 Day Trial, 14 Day Reset Trial, Black Friday Open Week). They sit in the Class Pack pile for ever. Fixing that is a change to the acquisition board's rule and a one-off move of those deals; it is not built here unless Richard asks.

Two things he may want to adjust after seeing the dry run:
- The tab names "€39 Trial" and "Programmes" (both are a column value, no code).
- Whether Day 7 should also hold people who have **not** yet trained (my reading of "7 days in") or only those who have had a first class.
