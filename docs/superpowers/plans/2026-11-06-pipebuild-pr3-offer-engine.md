# PIPEBUILD PR 3: offer engine (Glofox studios) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board row with `board_type = 'offer'`, `module = 'offer'` and a `config` places people at a Glofox studio (nightly pass and event paths) from any of six ways in, moves them through role-defined stages, and fires its stage follow-ups — with today's boards routing exactly as before.

**Architecture:** One pure module (`shared/pipelines/offer.js` + `offer-config.js`) whose behaviour comes from the board's `config`; one claim loader (`src/lib/pipeline-offer-claims.js`) per entry type; the router takes board descriptors and checks offer boards first by `priority`; the nightly pass and `ensureDealForContact` load configured boards and their claims and pass board KEYS (fixing today's keys-vs-modules mix-up). Creates on offer boards fire their stage trigger. No migration (mig 814 already added `board_type/config/priority` and `stage_role`; `pipeline_board_claims.board_key` is free text). un1t.online studios (`offer_un1t`) are PR 3b.

**Tech Stack:** Next.js 16, Supabase (service role), vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` ("PR 3: Offer engine"); remaining-work plan carry-overs (DealCard `paidBoard`).

## Global Constraints

- Worktree `/Users/richardivers/code/un1t-crm-pipebuild3`, branch `pipebuild-offer-engine` (off `origin/main` 4c3e71811). Never touch `~/code/un1t-crm`. Do not push.
- **Today's boards route exactly as before.** Every existing router fixture gives the identical `{ boardKey, slug }` through the new code path; a studio with no offer board behaves byte-for-byte as today (same reads, same writes, same triggers).
- A failed claim read places NOBODY that run (never "no claims") — the existing PIPE3 rule.
- Slugs are `<board key>_<role>` (+ `_<n>` for `class_n` count / `checkpoint` day), unique per studio (`pipeline_stages_location_slug_unique`); `classify` returns slugs, never roles.
- Config defaults: `duration_days` 14, `quiet_days` 60, `converted_window_days` 60; `priority` default 100 (lower runs first; existing €39 board fixed at 200, Programmes 300).
- Every supabase read/write destructures `error`; `.range()` + explicit `.order()` for paging; no new `console.log`; zone maths only via `@/lib/location-time`.
- Commit messages `PIPEBUILD.3x — <summary>`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Hatch's €39 board** (key `paid_trial`, module `paid_trial_un1t`) and Stillorgan's (key = module `paid_trial`): switching every caller to KEYS must not change who lands where. → Task 2 golden test covers both key/module pairings; Task 5 test `ensureDealUsesBoardKeys`.
2. **A person qualifying for two offer boards and the €39 board**: lowest `priority` wins, ties broken by board key; nobody lands on two boards. → Task 2 test `offerPriorityThenKey`.
3. **An offer board's first night** (dozens of qualifying people at once): the existing 50-per-stage mass guard holds the triggers; `silentBoardIds` suppresses them entirely. → Task 4 tests.
4. **A config with a missing stage role** (e.g. no `checkpoint`, no `done`): classify falls through to the nearest earlier stage that exists, never returns a slug with no stage row. → Task 1 test `missingRolesFallThrough`.
5. **One entry loader's read failing** while others succeed: the whole run places nobody (or, on the event path, `claimsError`). → Task 3 test `anyLoaderFailureFailsAll`.

---

### Task 1: Offer config + offer module (pure)

**Files:** Create `shared/pipelines/offer-config.js`, `shared/pipelines/offer.js` (+ `.test.js` each). Modify `shared/pipelines/index.js` (register `offer`), `shared/pipelines/index.test.js`.

**Interfaces (produces):**
- `ENTRY_TYPES = ['trial_purchase', 'corp_promo', 'lead_source', 'glofox_plan', 'tag']` (`un1t_product` is reserved for PR 3b and refused here).
- `parseOfferConfig(raw, { boardKey }) => { ok: true, config } | { ok: false, errors: string[] }` — normalises: `entry: { type, values: string[] (trimmed, non-empty, lower-cased except trial_purchase plan codes/page ids kept as given), match?: 'plan_code'|'landing_path'|'page_id' (trial_purchase only, required there) }`; `stages: [{ role, slug, name, day?, count? }]` ordered as given, roles from `STAGE_ROLES` minus `pile`/`custom`, exactly one `new`, at most one each of `first_class`/`done`/`converted`, `slug === stageSlugFor(boardKey, role, cfg)`, `roleConfigError` clean; `duration_days` (1–365, default 14), `quiet_days` (default 60), `converted_window_days` (default 60), `mia_notes?` (≤ 1000 chars).
- `stageSlugFor(boardKey, role, { day, count } = {}) => string` — `${boardKey}_${role}`, `${boardKey}_class_${count}`, `${boardKey}_day_${day}`.
- `offer.js`: `requiredFields` = paid-trial's set plus `lead_source`, `last_lead_source`, `last_lead_source_at`, `glofox_membership_plan`; `stages` = `[]` (stages come from config); `stagesFor(config) => rows [{ slug, name, stage_role, role_config, display_order (base 900 + index), color, is_dormant: false }]` (colours by role: new `#3B82F6`, first_class `#10B981`, class_n `#14B8A6`, checkpoint `#8B5CF6`, done `#F59E0B`, converted `#059669`);
  - `offerClaimLive(claim, contact, now, config)` — same rule as paid-trial `claimLive` with `config.quiet_days` / `config.converted_window_days`;
  - `classify(contact, now, claim, config)` — converted (member status, or pack at/after `claim.end`) → `done` if `now ≥ claim.end` → the latest `checkpoint` whose `day` has passed → the highest `class_n` whose `count` ≤ classes attended since `claim.start` → `first_class` if ≥ 1 → `new`; a role the config lacks falls through to the next earlier role present (never past `new`). Claim shape `{ start, end, source }` (epoch ms). Reuse `attendedSince`, `convertedSince`, `lastActivityMs` from `paid-trial.js`.

- [ ] Step 1 tests: `parsesFullConfig`, `rejectsBadConfig` (two `new`, unknown entry type, `un1t_product`, slug mismatch, day 0), `stageSlugs`, `stagesForRowsAndOrder`, `classifyWalksStages` (new → first_class → class_2 → day_7 → done → converted across times), `missingRolesFallThrough`, `claimLiveWindows`, `offerRegistered`.
- [ ] Step 2 run `npx vitest run shared/pipelines` — FAIL. Step 3 implement. Step 4 PASS + `npm run check:mobile-imports`.
- [ ] Step 5 commit `PIPEBUILD.3a — the offer board module and its config`.

### Task 2: Router takes board descriptors; offer boards by priority

**Files:** Modify `shared/pipelines/router.js`, `shared/pipelines/router.test.js`.

**Interfaces:**
- Consumes Task 1 (`offerClaimLive`, `classify as classifyOffer`).
- `routeContact(contact, claims, now, boards, opts)` — `boards` is either today's `Set` of keys (unchanged behaviour) or an array of descriptors `{ key, module, board_type, priority, config }`. Descriptor input normalises to the same key Set for the legacy branches. `claims.offers` is an optional `Map<boardKey, claim>`.
- Order: Cold/Gympass → offer boards (`board_type === 'offer'`, module `offer`) sorted by `priority` asc then `key`, first whose claim is live → `{ boardKey: key, slug: classifyOffer(contact, now, claim, config) }` → existing paid branch → programme branch → acquisition.
- `OFFER_MODULES = ['offer']` exported.

- [ ] Step 1 tests: `goldenSetVsDescriptors` (every existing fixture in `router.test.js` run with the Set and with equivalent descriptors — Stillorgan key=module and Hatch-style key `paid_trial`/module `paid_trial_un1t` — gives identical results), `offerBeatsPaid`, `offerPriorityThenKey`, `deadOfferFallsThrough`, `coldBeatsOffer`.
- [ ] Steps 2–4 run `npx vitest run shared/pipelines/router.test.js`. Step 5 commit `PIPEBUILD.3b — the router places offer boards first, by priority`.

### Task 3: Offer claim loaders

**Files:** Create `src/lib/pipeline-offer-claims.js` (+ `.test.js`). Modify `src/lib/pipeline-claims.js` (generalise the recorded-claim helpers; widen `PURCHASE_COLS`) + its test.

**Interfaces:**
- `offerBoardsOf(boards) => descriptors` (enabled, `board_type === 'offer'`, config parsed with `parseOfferConfig`; an unparseable config is skipped and reported, never thrown).
- `loadOfferClaimsForLocation(db, { locationId, boards, contacts, now }) => { ok: true, offersByContact: Map<contactId, Map<boardKey, claim>>, pending: rows[] } | { ok: false, reason, err }` — one read per entry type actually used:
  - `trial_purchase`: `trial_purchases` at the studio, paid/granted (same counting rule as `paidTrialClaim`), matched on `plan_code` / `landing_path` / `page_id` per `entry.match`; claim start `granted_at ?? paid_at`, end start + `duration_days`.
  - `corp_promo`: `corp_promo_claims` `status = 'granted'`, `promo_key ∈ values`; start `updated_at`, end start + `duration_days`.
  - `lead_source` / `glofox_plan` / `tag`: recorded once in `pipeline_board_claims` (`board_key` = the offer board's key, `source` = entry type); signals from the contact row (`last_lead_source` with `lead_source` fallback, dated `last_lead_source_at ?? now`; `glofox_membership_plan` substring; active `contact_tags` row with `tag ∈ values`, dated `added_at`) — generalise `pendingProgrammeClaims`/`upsertProgrammeClaims` to `pendingRecordedClaims(contacts, storedByContact, matcher, boardKey, now)` / `upsertBoardClaims(db, locationId, rows, now)` keeping the programme behaviour identical (existing tests stay green).
  - Any read failing → `{ ok: false }` for the whole call.
- `loadOfferClaimsForContact(db, { locationId, boards, contact, now, write }) => { ok, offers: Map<boardKey, claim> }` (same rules, one contact).

- [ ] Step 1 tests: one per entry type (`trialPurchaseByPlanCode`, `…ByLandingPath`, `…ByPageId`, `corpPromoGranted`, `leadSourceRecordedOnce`, `glofoxPlanRecorded`, `tagRecorded`), `anyLoaderFailureFailsAll`, `programmeClaimsUnchanged`, `noOfferBoardsNoReads`.
- [ ] Steps 2–4 `npx vitest run src/lib/pipeline-offer-claims.test.js src/lib/pipeline-claims.test.js` + `npm run check:select-columns`. Step 5 commit `PIPEBUILD.3c — claim loaders for the six ways onto an offer board`.

### Task 4: Nightly pass places offer boards and fires their stages

**Files:** Modify `src/lib/pipeline-reclassify.js` (+ test), `src/app/api/admin/pipeline-reclassify/route.js` (+ test).

**Interfaces:**
- Pipelines select adds `board_type, config, priority`; the router gets descriptors (keys); `needsClaims` is true when a claim module OR an offer board is active; offer claims from Task 3 merged into the router's `claims.offers`; pending recorded claims upserted on real runs only (as programmes).
- Triggers: offer-module pipelines join `triggerPipelineIds`; creates on boards with `board_type` set fire `triggerSequencesForPipelineStageChange(contactId, null, slug, { locationId })` after the insert succeeds, counted per stage with moves for the existing 50 mass guard (`STAGE_TRIGGER_MASS_MOVE`); new option `reclassifyAllContacts(db, { …, silentBoardIds: string[] })` places but fires nothing for those boards (for PR 5's switch-on).
- `EXCLUDING_MODULES` gains `offer` (it behaves like `paid_trial`).
- Admin route: `include_disabled` additionally accepts `board_ids: uuid[]` (dry run only) so a disabled offer board can be previewed; existing enum unchanged.
- No offer board at the studio → identical selects/writes/triggers to today (assert in a test with the recorded db).

- [ ] Step 1 tests: `noOfferBoardIdenticalToday`, `placesIntoOfferBoard` (create + move), `offerCreatesFireNullToSlug`, `massGuardHoldsCreates`, `silentBoardFiresNothing`, `offerClaimReadFailureFailsRun`, `dryRunIncludesDisabledOfferBoard`.
- [ ] Steps 2–4 `npx vitest run src/lib/pipeline-reclassify.test.js src/app/api/admin/pipeline-reclassify` + `npm run check:select-columns`. Step 5 commit `PIPEBUILD.3d — the nightly pass places offer boards and fires their stage follow-ups`.

### Task 5: Event paths (webhook, place-now, Cold) use keys and offer claims

**Files:** Modify `src/lib/glofox-sync.js` (`ensureDealForContact`, webhook snapshot), `src/lib/pipeline-claims.js` (`loadPlacementClaims`), `src/lib/pipeline-place-now.js`, `src/app/api/contacts/[id]/pipeline-status/route.js`, `src/lib/sequences/triggers.js` (+ tests).

**Interfaces:**
- `ensureDealForContact` passes descriptors keyed by `key` (was module names); target board found by `key`; `loadPlacementClaims` returns `claims.offers` when an offer board is active (and treats an offer board as a claim board).
- `PLACE_NOW_COLUMNS` and the Cold route's columns = union of every registered module's `requiredFields` plus `location_id` (one shared helper in `shared/pipelines/index.js`: `allRequiredFields()`); the webhook snapshot carries the offer fields it already has (`lead_source`, `last_lead_source`, `last_lead_source_at`, `glofox_membership_plan`).
- `triggerSequencesForDealPlacement` fires `null → slug` for `action === 'create'` only when the deal's board has `board_type` set (it already receives `dealLocationId`/`pipelineId`; read `board_type` for that pipeline); `placeContactNow` callers pass the result through it.
- Existing boards: unchanged results and triggers.

- [ ] Step 1 tests: `ensureDealUsesBoardKeys` (Hatch-style key≠module and Stillorgan), `placesOfferBoardOnEvent`, `createOnOfferBoardFires`, `createOnLegacyBoardDoesNot`, `placeNowColumnsCoverOffer`.
- [ ] Steps 2–4 `npx vitest run src/lib/glofox-sync.test.js src/lib/pipeline-claims.test.js src/lib/pipeline-place-now* src/lib/sequences/triggers.test.js 'src/app/api/contacts/[id]/pipeline-status'` + `npm run check:select-columns`. Step 5 commit `PIPEBUILD.3e — webhook, place-now and Cold place offer boards by key and fire their entry stage`.

### Task 6: Cards and coverage for offer boards

**Files:** Modify `src/components/DealCard.jsx` (+ test), `src/lib/pipeline-board.js` / `src/app/(sales)/pipeline/page.js` / `src/app/api/pipeline/deals/route.js` as needed, `src/lib/pipeline-stage-coverage.js` (+ test).

**Interfaces:**
- DealCard's "N of 3 classes" wording: shown only when the server says the board is a free-trial acquisition board (pass `classesOf3: boolean` from the server: module `acquisition`/`acquisition_un1t`), replacing `columnSlug.startsWith('paid_trial_')`; today's boards render identically.
- Coverage: an offer board's `new` stage counts `pipeline_stage_change` sequences aimed at it (creates now fire), so no entry-trigger map entry is needed; add a test that an offer board's stages appear with their follow-ups.

- [ ] Step 1 tests: `classesOf3OnlyOnAcquisition` (paid_trial and offer boards say "N classes"; acquisition says "N of 3"), `offerBoardCoverage`.
- [ ] Steps 2–4 focused vitest + `npm run check:guardrails`. Step 5 commit `PIPEBUILD.3f — cards and coverage treat offer boards by kind, not by slug prefix`.
