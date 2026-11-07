# PIPEBUILD PR 5 — Builder and settings: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio owners, org admins and masters build an offer board from a recipe, attach its follow-ups, dry-run it and switch it on. Managers view the setup and edit follow-up wording.

**Architecture:** Ships as two PRs from one plan.
- **PR 5a (Tasks 1-7)** is the server side:
  - migration 815 (baseline marker, follow-up version, a create RPC, closing browser writes on `pipeline_stages`);
  - config and recipe changes;
  - the silent switch-on baseline;
  - the board, dry-run, follow-up and entry-option routes;
  - follow-up sequences locked and hidden from the sequence builder.
- **PR 5b (Tasks 8-11)** is the UI:
  - the `/settings/pipelines` list;
  - the wizard at `/settings/pipelines/new`;
  - the board settings page at `/settings/pipelines/[id]`.

  It calls only 5a's routes.

**Tech Stack:** Next.js 16 App Router, Supabase (service role in routes), Zod via `validateBody`, Vitest, Tailwind with `un1t-*` tokens and `@/components/ui`.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` (§ PR 5, Decisions, Risks). Remaining-work plan with carry-overs: `~/.claude/plans/this-seems-like-a-magical-blossom.md` (§ PR 5).

## Global Constraints

- **Who:**
  - Create a board, change it, enable or disable it, or dry-run it: owners, org admins and masters at that studio (`assertLocationAccessOr404` then `guardMasterOrOwner`).
  - View the setup: `hasRoleAtLocation(user, loc, MANAGER_ROLES) || canBuildSequencesAt(user, loc)`, the same gate as `stage-coverage`.
  - Edit follow-up wording: owner gate, OR `canBuildSequencesAt && canManageWaTemplatesAt`.
- Another studio's board is a **404**, never a 403. Every route is registered in `src/lib/openapi.js` and passes `check:route-guards` and `check:location-scoping`.
- **Built-in boards** (`board_type IS NULL`) are read-only everywhere: `assertNotLegacyBoard` on every write.
- **A board is created OFF** (`enabled=false`).
- **Silent switch-on.** Switching a board on never messages people who already qualify: the first placement pass after switch-on is silent (Task 3). Switching it on again is silent again.
- **Structure only changes while off.** Entry rule, stages added or removed, `duration_days`, `quiet_days`, `converted_window_days` and `priority` change only while the board is off. Board name, stage names and `mia_notes` change any time.
- A stage is removed only when it holds **no deals** (any status) and its follow-up is `off`, `rejected` or absent.
- **No offer boards at un1t.online studios.** `offer_un1t` is PR 3b. Create and enable refuse with 409: `Offer boards at un1t.online studios aren't available yet.`
- **Board keys** match `^o_[a-z0-9_]{1,40}$`, are unique per studio, and are generated server-side from the name.
- **Copy rule:** customer-facing wording is operator-editable, with the recipe default as the fallback. All UI copy is plain English and sentence case.
- Writers set `updated_at` (there is no trigger).
- Every supabase write destructures `error`. Where a row must exist, the write selects `id` and checks the rows touched.
- **Migration 815** is applied via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj` before 5a merges, then `get_advisors` (security) is run. A new function is `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`.
- No new `console.log`; use `logError(MODULE, …)`.

## Review Focus

1. **Switch-on near a live webhook.** A Glofox webhook for a qualifying person lands between "Turn on" and the first nightly pass. Expected: the person is not placed and gets no message until the baseline pass has run. Test in Task 3 (`eventPathsHoldUnbaselinedBoard`).
2. **Overlap at dry run.** The new board would take people already on the €39 or Programmes board. Expected: the dry run says how many, from which board, before switch-on. Test in Task 5 (`summarisesOverlapByBoard`).
3. **Double submit.** Two clicks on "Create board" or "Install follow-ups". Expected: one board, one follow-up per stage. Tests in Task 4 (`createTwiceSameNameGetsSecondKey` and the RPC's unique key) and Task 6 (`installTwiceReturnsSameRow`).
4. **Editing a live board's structure.** Expected: a 409 that tells the owner to switch the board off first. Test in Task 4 (`patchStructureWhileOnIs409`).
5. **Replacing wording on a live follow-up.** Expected: the old sequence is paused BEFORE the new one can go live, so a stage never has two active follow-up sequences. Test in Task 6 (`replacePausesOldBeforeInstall`).

---

## PR 5a: server

### Task 1: Migration 815

**Files:**
- Create: `supabase/migrations/815_pipeline_builder.sql`
- Test: `tests/pipeline-builder-migration-guard.test.js` (new). Also run the existing `tests/function-execute-guard.test.js`, `tests/table-default-acl-guard.test.js` and `tests/member-write-sweep-guard.test.js`.

**Interfaces:**
- Produces:
  - Column `pipelines.baseline_at timestamptz` (nullable; null = not yet baselined).
  - Column `pipeline_stage_followups.version integer NOT NULL DEFAULT 1 CHECK (version >= 1)`.
  - Function `public.create_configured_pipeline(p_location_id uuid, p_key text, p_name text, p_board_type text, p_module text, p_recipe_key text, p_config jsonb, p_priority integer, p_created_by uuid, p_stages jsonb) RETURNS uuid`. It inserts one `pipelines` row and every stage in `p_stages` in one transaction.
  - Browser INSERT/UPDATE/DELETE on `pipeline_stages` closed.

- [ ] **Step 1: Write the failing guard test** `tests/pipeline-builder-migration-guard.test.js`. It reads `supabase/migrations/815_pipeline_builder.sql` and asserts:
  - it adds `baseline_at` and `version`;
  - it creates `public.create_configured_pipeline` and has `REVOKE EXECUTE ON FUNCTION public.create_configured_pipeline` … `FROM PUBLIC, anon, authenticated`;
  - it drops policies `pipeline_stages_ins`, `pipeline_stages_upd` and `pipeline_stages_del`;
  - it contains `REVOKE INSERT, UPDATE, DELETE ON public.pipeline_stages FROM authenticated` (not `REVOKE ALL` and not a table-level `REVOKE SELECT`, since `pipeline_stages_select` and the phone's reads must survive);
  - no later migration file re-creates a `pipeline_stages` INSERT/UPDATE/DELETE policy or grants those privileges to `authenticated`.
- [ ] **Step 2:** Run `npx vitest run tests/pipeline-builder-migration-guard.test.js`. Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration.**
  - `create_configured_pipeline` is `LANGUAGE plpgsql SECURITY INVOKER SET search_path = public`.
  - It inserts the `pipelines` row with these values:
    - `mode 'derived'`, `enabled false`, `is_primary false`;
    - `display_order = coalesce(max(display_order),0)+1` for the location;
    - `config`, `priority`, `board_type`, `module`, `recipe_key`, `created_by`, `updated_at now()`.
  - Then it inserts each element of `p_stages` (`slug, name, stage_role, role_config, display_order, color, is_dormant`) with `pipeline_id` and `location_id`.
  - It returns the pipeline id. A 23505 propagates.
  - Header comment cites the "deliberately no board-builder UI" line in mig 594 as superseded.
  - Self-check `DO` block, from catalogs:
    - `has_function_privilege('authenticated', …, 'EXECUTE')` is false;
    - `has_table_privilege('authenticated','public.pipeline_stages','UPDATE')` is false;
    - `has_table_privilege('authenticated','public.pipeline_stages','SELECT')` is true.
- [ ] **Step 4:** Run the four tests above plus `npm run check:rls-restrictive && npm run check:rpc-names`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5a — mig 815: baseline marker, follow-up version, create RPC, browser stage writes closed`.

### Task 2: Config, recipe and installer changes

**Files:**
- Modify: `shared/pipelines/offer-config.js`, `shared/pipelines/recipes.js`, `src/lib/pipeline-followup-packs.js`
- Test: `shared/pipelines/offer-config.test.js`, `shared/pipelines/recipes.test.js`, `src/lib/pipeline-followup-packs.test.js`. Also update every fixture that builds an offer board with a key not matching `^o_` (grep `parseOfferConfig(` and `boardKey:` across `shared/`, `src/`, `tests/`).

**Interfaces:**
- Produces:
  - `BOARD_KEY_RE = /^o_[a-z0-9_]{1,40}$/` (exported from offer-config.js).
  - `boardKeyFor(name: string, takenKeys: Set<string>) → string`. Slugify (lower-case, non-alphanumerics → `_`, collapse and trim `_`, cut to 36 characters) and prefix `o_`. If the result is taken, append `_2`, `_3` and so on. An empty slug falls back to `o_board`.
  - `parseOfferConfig` also returns errors:
    - `'boardKey must look like o_name'`;
    - `offer_name` (optional, trimmed, ≤60): `'offer_name must be 60 characters or fewer'`;
    - `signer` (optional, trimmed, ≤40): `'signer must be 40 characters or fewer'`.
  - `renderPack(recipeKey, packKey, opts)` gains:
    - `opts.version?: integer ≥1`, passed into `templateNameFor`, which appends `_v<n>` when n > 1;
    - `opts.bodies?: { [ref]: string }`, operator wording replacing the default body before fill-ins.
    - A body override must contain `{{1}}`, must contain no other `{{…}}`, may use the fill-in tokens `{studio} {offer} {days} {days_left} {signer}`, and goes through the same sanitise and ≤1024 checks. Bad input throws `Error('wording: <reason>')`.
    - When a template has no `book` button (no `bookingFlowId`) and no `apps` button, the sentence beginning `Tap below` is removed from the default body. An operator override is never edited.
  - `installFollowupPack(db, {…, version?: integer, bodies?})`:
    - passes `version` and `bodies` to `renderPack`, and writes `version` on the row it inserts or reuses;
    - refuses with 409 `code:'recipe_mismatch'` when the board's `recipe_key` ≠ `recipeKey`;
    - refuses with 409 `code:'stage_role_mismatch'` when the pack's `role` ≠ the stage's `stage_role` (read with the stage).

- [ ] **Step 1: Write failing tests:**
  - `requiresOPrefixedKey`: `parseOfferConfig(valid, {boardKey:'reset'}).errors` contains `'boardKey must look like o_name'`, and `{boardKey:'o_reset'}` passes.
  - `boardKeyForSlugifiesAndDedupes`: `boardKeyFor('14 Day Reset!', new Set())==='o_14_day_reset'`, `boardKeyFor('14 Day Reset', new Set(['o_14_day_reset']))==='o_14_day_reset_2'`, `boardKeyFor('!!!', new Set())==='o_board'`.
  - `acceptsOfferNameAndSigner` and their length errors.
  - `versionedTemplateNames`: `renderPack(...,{...BASE, boardKey:'o_reset', version:2}).templates[0].name` ends `_v2`, and version 1 has no suffix.
  - `bodyOverrideRequiresFirstName`: an override without `{{1}}` throws `/wording/`; one with `{{2}}` throws; a valid one renders with fill-ins replaced.
  - `dropsTapBelowWithoutButtons`: with `bookingFlowId` undefined and no `appLinks`, no rendered body contains `Tap below`.
  - `installerRefusesRecipeMismatch` and `installerRefusesStageRoleMismatch` (409 + code, and `submitWhatsappTemplate` not called).
  - `installerWritesVersion` (version 2 lands on the row).
- [ ] **Step 2:** Run those test files. Expected: FAIL.
- [ ] **Step 3: Implement**, then update fixtures to `o_` keys. Keep `paidTrialCopyMatchesLive` green: the live copy has buttons, so the Tap-below line stays.
- [ ] **Step 4:** Run `npx vitest run shared/pipelines src/lib/pipeline-followup-packs.test.js src/lib/pipeline-offer-claims.test.js src/lib/pipeline-reclassify` and every other file whose fixtures you changed. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5b — o_ board keys, versioned and operator-worded follow-ups, installer checks recipe and stage role`.

### Task 3: Silent baseline on switch-on

**Files:**
- Modify: `src/lib/pipeline-claims.js` (`loadBoardsForLocation` reads `baseline_at`), `src/lib/pipeline-offer-claims.js` (`placementDescriptors`), `src/lib/pipeline-reclassify.js`
- Test: `src/lib/pipeline-offer-claims.test.js`, `src/lib/pipeline-reclassify.test.js` (or the existing reclassify offer test file), and the event-path tests for `placeContactNow` and `ensureDealForContact`.

**Interfaces:**
- Produces:
  - `placementDescriptors(boards, { offersKnown, holdUnbaselined = true })`. An offer board with `baseline_at == null` goes into `heldIds` when `holdUnbaselined` is true. The event paths use the default.
  - `reclassifyAllContacts`:
    - calls it with `holdUnbaselined:false`;
    - adds every enabled offer board with `baseline_at == null` to its silent set (union with the `silentBoardIds` option), so those boards place without firing;
    - after a **real** run that returns `ok:true` with `errors === 0`, sets `baseline_at = now(), updated_at = now()` on each of those boards that was not held or refused that run (`.is('baseline_at', null)` guard, error checked and logged, never failing the run);
    - never stamps on a dry run;
    - the dry-run result gains `board_overlap: { [targetBoardKey]: { [fromBoardKey]: n } }`, counting planned cross-board moves.
  - Task 4's enable route sets `baseline_at = null`.

- [ ] **Step 1: Write failing tests:**
  - `eventPathsHoldUnbaselinedBoard`: a contact qualifying for an enabled offer board with `baseline_at:null` is not placed by `placeContactNow`, and no sequence trigger fires.
  - `nightlyPlacesUnbaselinedSilentlyAndStamps`: a real run places the contact, `triggerSequencesForDealPlacement` is not called for that board, and the board's `baseline_at` is set.
  - `secondNightFires`: once `baseline_at` is set, a new qualifier's create fires as in PR 3.
  - `dryRunNeverStamps`.
  - `runWithErrorsDoesNotStamp`.
  - `heldBoardNotStamped` (bad config).
  - `dryRunReportsBoardOverlap`: a person on the €39 board who routes to an offer board with higher priority gives `board_overlap[o_x][paid_trial] === 1`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement as described in the Interfaces block.
- [ ] **Step 4:** Run `npx vitest run src/lib/pipeline-offer-claims.test.js src/lib/pipeline-reclassify src/lib/pipeline-place-now src/lib/glofox-sync`. Expected: PASS, with today's router golden test unchanged.
- [ ] **Step 5: Commit** `PIPEBUILD.5c — a switched-on offer board is held on event paths until a silent nightly baseline stamps it`.

### Task 4: Board routes

**Files:**
- Create:
  - `src/lib/pipeline-boards.js`
  - `src/app/api/locations/[id]/pipelines/route.js` (GET, POST)
  - `src/app/api/pipelines/[id]/route.js` (GET, PATCH)
  - `src/app/api/pipelines/[id]/enable/route.js`
  - `src/app/api/pipelines/[id]/disable/route.js`
- Modify: `src/lib/openapi.js`, `src/lib/schemas.js` (add Zod `boardCreateSchema`, `boardPatchSchema`)
- Test: `src/lib/pipeline-boards.test.js`, plus one `route.test.js` beside each route.

**Interfaces:**
- Consumes: Task 1 RPC, Task 2 `boardKeyFor`/`BOARD_KEY_RE`/`parseOfferConfig`, `stagesFor(config)` (shared/pipelines/offer.js), `readMembershipSource` (pipeline-offer-claims.js), `RECIPES`.
- Produces (all return `{ok:true, …} | {ok:false, status, error, code?}`):
  - `listBoards(db, locationId) → {ok, boards:[{id,key,name,board_type,recipe_key,enabled,baseline_at,priority,config,is_primary,stages:[{id,slug,name,stage_role,role_config,display_order,deal_count}], followups:[{id,stage_id,pack_key,state,want_live,version,sequence_id,whatsapp_template_id}]}]}`.
    - Includes every board, enabled or not.
    - `config` is returned only for `board_type` boards.
    - `deal_count` counts open deals.
  - `getBoard(db, locationId, boardId) → {ok, board}`. Same shape, 404 when not at the studio.
  - `createBoard(db, {locationId, name, recipeKey, config, priority, createdBy}) → {ok, board}`:
    1. Refuses with 409 at un1t.online studios, and with 503 when the source is unreadable.
    2. Validates the recipe.
    3. Generates the key from existing keys.
    4. Overwrites `config.stages[*].slug` with `stageSlugFor(key, …)`.
    5. Runs `parseOfferConfig` (400 with `issues` on errors).
    6. Calls the RPC with `p_board_type 'offer'`, `p_module 'offer'` and the `stagesFor(config)` rows.
    7. On 23505, retries once with a fresh key, then gives 409 `code:'key_taken'`.
  - `updateBoard(db, {locationId, boardId, patch:{name?, priority?, config?}}) → {ok, board}`:
    - Runs `assertNotLegacyBoard`.
    - Name, stage names and `mia_notes` are always allowed.
    - Any change to entry, the set of stage slugs, durations or windows, or priority while `enabled` gives 409 `code:'switch_off_first'`, message `Switch the board off before changing its entry rule, stages or timings.`
    - Stages are diffed by slug:
      - renamed: update `name`;
      - added: insert with `stagesFor` fields;
      - removed: 409 `code:'stage_not_empty'` if any deal (any status) is in it, or 409 `code:'followup_active'` if its follow-up is `draft`, `awaiting_approval` or `live`; otherwise deleted.
    - Then the parsed config is written with `updated_at`.
  - `setBoardEnabled(db, {locationId, boardId, enabled}) → {ok, board}`:
    - Runs `assertNotLegacyBoard`.
    - On enable: the config must parse, the studio must not be un1t.online, then CAS `enabled=false → true` with `baseline_at=null, updated_at=now()`.
    - On disable: CAS `true → false`.
    - Already in that state: `{ok:true, board, unchanged:true}`.
- Routes:
  - Skeleton: `getCurrentUser` → `assertLocationAccessOr404` → role gate → `validateBody` → lib → `{success, data}`.
  - GET uses the view gate. POST, PATCH, enable and disable use the owner gate.
  - The list GET returns `{boards, can_edit}`, and the detail GET returns `{board, can_edit, can_edit_wording}`:
    - `can_edit = guardMasterOrOwner(user, loc) === null`;
    - `can_edit_wording = can_edit || (canBuildSequencesAt && canManageWaTemplatesAt)`.
  - The `[id]` routes resolve the board's `location_id` first (service role, by id), then `assertLocationAccessOr404` on it, so another studio's id is a 404.

- [ ] **Step 1: Write failing lib tests:**
  - `createsOffBoardWithStages`: the RPC is called with the `o_` key, stages carry the key's slugs, and the board comes back `enabled:false`.
  - `createTwiceSameNameGetsSecondKey`.
  - `refusesUn1tStudio`.
  - `refusesUnknownRecipe`.
  - `badConfigIs400WithIssues`.
  - `patchStructureWhileOnIs409`.
  - `patchNameWhileOnAllowed`.
  - `removeStageWithDealsIs409`.
  - `removeStageWithLiveFollowupIs409`.
  - `removeEmptyStageDeletes`.
  - `legacyBoardIs409OnEveryWrite`.
  - `enableResetsBaseline`.
  - `enableTwiceUnchanged`.
- [ ] **Step 2: Write failing route tests:**
  - `otherStudioBoardIs404`.
  - `managerCannotCreate` (403).
  - `managerCanList`.
  - `orgAdminCanCreate` (synthetic owner role).
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4: Implement**, and register the 7 operations in openapi.js.
- [ ] **Step 5:** Run `npx vitest run src/lib/pipeline-boards.test.js src/app/api/locations/\[id\]/pipelines src/app/api/pipelines && npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:rpc-names`. Expected: PASS.
- [ ] **Step 6: Commit** `PIPEBUILD.5d — board routes: list, create (off), edit, enable and disable`.

### Task 5: Dry-run route

**Files:**
- Create: `src/app/api/pipelines/[id]/dry-run/route.js`, `src/lib/pipeline-board-dry-run.js`
- Modify: `src/lib/openapi.js`
- Test: `src/lib/pipeline-board-dry-run.test.js`, `src/app/api/pipelines/[id]/dry-run/route.test.js`

**Interfaces:**
- Consumes: `reclassifyAllContacts`; `board_overlap` and `stage_histogram` from Task 3.
- Produces:
  - `summariseBoardDryRun(result, board) → { entering: number, byStage: [{slug, name, count}], overlap: [{boardKey, boardName?, count}], contactsSeen, errors }`.
    - `entering` is `result.board_histogram[board.key] ?? 0`.
    - `byStage` covers every stage of the board, in `display_order`, with 0 where absent.
    - `overlap` comes from `result.board_overlap[board.key]`, sorted by count descending.
  - The route `POST /api/pipelines/[id]/dry-run`:
    - owner gate, `maxDuration = 60`;
    - calls `reclassifyAllContacts(db, {locationId, dryRun:true, source:'manual', userId, includeDisabledBoardIds: board.enabled ? [] : [board.id]})`;
    - returns `{success:true, data: summary}`;
    - legacy boards give 409;
    - a run returning `ok:false` gives 503 with its error.

- [ ] **Step 1: Write failing tests:**
  - `summarisesStagesInOrderWithZeros`.
  - `summarisesOverlapByBoard` (two source boards, sorted).
  - `routeIncludesDisabledBoard` (asserts the `includeDisabledBoardIds` arg).
  - `routeRefusesLegacyBoard`.
  - `failedRunIs503`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement**, and register in openapi.js.
- [ ] **Step 4:** Run the tests plus `npm run check:route-guards`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5e — dry run for one board: who would enter, per stage, and from which boards`.

### Task 6: Follow-up and entry-option routes

**Files:**
- Create:
  - `src/app/api/pipelines/[id]/followups/[stageId]/route.js` (PUT)
  - `src/lib/pipeline-board-followups.js`
  - `src/app/api/locations/[id]/pipeline-entry-options/route.js` (GET)
  - `src/lib/pipeline-entry-options.js`
- Modify: `src/lib/openapi.js`, `src/lib/schemas.js`
- Test: lib tests plus a `route.test.js` for each route.

**Interfaces:**
- Consumes: `installFollowupPack` (Task 2 signature), `RECIPES`, `getBoard`.
- Produces:
  - `renderInputsFor(db, board) → {ok, render:{studioName, offerName, durationDays, signer, bookingFlowId?, appLinks?}}`:
    - `studioName` is `locations.name`;
    - `offerName` is `config.offer_name || board.name`;
    - `durationDays` is `Number(config.duration_days)`;
    - `signer` is `config.signer || studioName`;
    - `appLinks` is `locations.settings.un1t_online.app_links` when both URLs are present;
    - `bookingFlowId` is read from wherever the existing booking-flow button reads the studio's flow id. Find it by grepping the WhatsApp booking flow sender. If the studio has none, leave it out.
    - Read `locations.settings` by id here; never pass it to a client.
  - `applyFollowupAction(db, {user, board, stage, action, packKey, bodies?}) → {ok, followup, publishError?, code?}`. `action` is one of:
    - `install`:
      - No row: calls `installFollowupPack` with `recipeKey: board.recipe_key`, `render`, `bodies`, `wantLive:true`, `version: 1`.
      - Row `draft`, `awaiting_approval` or `live`: the same call with the row's own `version`. This returns the row, and the installer's recheck republishes a stranded one, so it doubles as "publish now".
      - Row `rejected` or `off`: delete the row's sequence when it is still `draft` (scoped by `location_id`, error checked; this closes the PR 4 "old draft left behind" carry-over), then install with `version = row.version + 1`, because Meta will not take the old name again.
    - `replace` (wording change on an existing row):
      1. Pause the row's sequence (`email_sequences.status → 'paused'` with a CAS from `active`, or delete it when `draft`; both scoped by `location_id`, error checked).
      2. Set the row to `off` (CAS on its current state).
      3. Call `install` with `version = row.version + 1`.

      If step 1 or step 2 fails, nothing is installed (409 or 500). The old sequence is paused BEFORE the new one exists.
    - `off`: pause or delete the sequence as in `replace`, then set the row to `off`.
  - Route gate: owner gate, OR `canBuildSequencesAt && canManageWaTemplatesAt`. The body is `{action, pack_key, bodies?}`; `pack_key` must be a pack of the board's recipe whose role matches the stage. Legacy boards give 409.
  - `listEntryOptions(db, {locationId, type, match?}) → {ok, options:[{value, label, hint?}]}`, by type:
    - `trial_purchase`:
      - `plan_code`: distinct `trial_purchases.plan_code` at the studio, plus `landing_page_studios.offer->>'plan_code'` for the studio;
      - `landing_path`: distinct `trial_purchases.landing_path`;
      - `page_id`: the org's `landing_pages` rows that have a `landing_page_studios` row for the studio, labelled by title.
    - `corp_promo`: `CORP_PROMOS`, value `key`, label `name`, hint the studio (no location filter: the promo registry is keyed by public path).
    - `lead_source`: the `leadSourceSchema` enum values.
    - `glofox_plan`: `glofox_memberships` `name` at the studio, where `active`.
    - `tag`: the same source the `/api/segments` route uses for that studio. Import its helper; never copy it.
    - Every read is `.range()`-paginated or capped at 1000 with a stated reason.
    - The route GET uses the view gate. An unknown `type` gives 400.

- [ ] **Step 1: Write failing tests:**
  - `installUsesBoardRecipeAndRenderInputs`.
  - `installTwiceReturnsSameRow`.
  - `installOverRejectedBumpsVersionAndDropsDraft`.
  - `replacePausesOldBeforeInstall`: the order of the writes is asserted (sequence pause → row off → install with version 2).
  - `replaceStopsWhenPauseFails` (install not called).
  - `offPausesAndSwitchesOff`.
  - `managerWithWhatsappCanReplace`.
  - `managerWithoutTemplatePermissionIs403`.
  - `packNotInRecipeIs400`.
  - `renderInputsNeverReturnSettings`: the result has only the listed keys.
  - `entryOptionsPerType`: one test per type, with studio scoping asserted on each query.
  - `unknownTypeIs400`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement**, and register in openapi.js.
- [ ] **Step 4:** Run the tests plus `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5f — follow-up install, replace and switch-off; entry-rule options per studio`.

### Task 7: Lock and hide follow-up sequences; coverage shows follow-up states

**Files:**
- Create: `src/lib/followup-owned-sequences.js`
- Modify:
  - `src/app/(marketing)/automations/page.js` (both reads)
  - every write route under `src/app/api/sequences/[id]/` (the PATCH in `route.js`, `graph`, `steps`, `clone` is fine since it copies, `enrol`) and the publish/activate routes;
  - `src/lib/pipeline-stage-coverage.js`
- Test: `src/lib/followup-owned-sequences.test.js`, the touched route tests, `src/lib/pipeline-stage-coverage.test.js`.

**Interfaces:**
- Produces:
  - `followupOwnedSequenceIds(db, locationId) → {ok, ids:Set<string>}`, read from `pipeline_stage_followups.sequence_id` (paginated).
  - `refuseIfFollowupOwned(db, sequence) → NextResponse|null`: 409 `{success:false, error:'This follow-up belongs to a pipeline board. Change it in Settings → Pipelines.', code:'followup_owned'}`. It reads by `sequence_id` and `location_id`. A failed read gives 503 (fail closed).
  - `loadStageCoverage` stage rows gain `followupStates: [{pack_key, state, version}]` from `pipeline_stage_followups`. Existing fields are unchanged.
- [ ] **Step 1: Write failing tests:**
  - `automationsListHidesFollowupSequences`.
  - `patchFollowupSequenceIs409`, and the same for graph, steps and publish.
  - `cloneOfFollowupSequenceAllowed`.
  - `ownershipReadFailureIs503`.
  - `coverageIncludesFollowupStates`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The guard goes after auth and before any write.
- [ ] **Step 4:** Run the touched tests plus `npm run check:route-guards`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5g — follow-up sequences are hidden from Automations and locked to their board; coverage shows follow-up states`.

**PR 5a is done when** the 13-command CI mirror and `npm run build` pass, mig 815 is applied with clean advisors, and the PR is open with its changelog entry.

---

## PR 5b: UI (branch off 5a)

### Task 7b: Pre-existing claims never fire on event paths

Found in the 5a final review. The nightly baseline reads only contacts whose home studio is the board's studio. So a contact from a sibling studio who already qualifies is not placed silently. After the stamp, their first Glofox event would place them on the board WITH the stage follow-up. That breaks the switch-on promise.

**Files:**
- Modify: `src/lib/glofox-sync.js` (`ensureDealForContact`'s fire decision), `src/lib/pipeline-offer-claims.js` (claim time on offer claims)
- Test: `src/lib/glofox-sync.test.js` and/or the place-now / pipeline-status route tests

**Interfaces:**
- An offer claim carries `claimedAt` (ISO): the source row's time for `trial_purchase`/`corp_promo`, and `pipeline_board_claims.claimed_at` for recorded kinds.
- On every event path, placing a person on an offer board fires its follow-up only when `claimedAt >= board.baseline_at`.
- An older claim places silently: the deal is created or moved, and no sequence trigger fires. This applies to every contact, not only those from sibling studios.
- A claim whose time is unknown places silently.

- [ ] **Step 1: Write failing tests:**
  - `siblingContactWithOldClaimPlacesSilently`: the claim is before `baseline_at`; a deal is created; no trigger fires.
  - `newClaimAfterBaselineFires`.
  - `unknownClaimTimePlacesSilently`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/lib/glofox-sync src/lib/pipeline-offer-claims src/lib/pipeline-place-now 'src/app/api/contacts/[id]/pipeline-status'`. Expected: PASS, with the router golden test unchanged.
- [ ] **Step 5: Commit** `PIPEBUILD.5m — a claim older than the board's baseline places silently on every event path`.

### Task 8: Settings row, template preview and the board list

**Files:**
- Create:
  - `src/components/WhatsAppTemplatePreview.jsx` (props `{components}`, the Meta components array: HEADER/BODY/FOOTER/BUTTONS), extracted from `src/components/WATemplateEditor.jsx:921-958`, which then renders it.
  - `src/app/settings/pipelines/page.js`
  - `src/components/pipelines/BoardList.jsx`
- Modify: `src/lib/settings-tree.js` (row `pipelines`: label `Pipelines`, href `/settings/pipelines`, description `Build offer boards and their follow-ups`, gate `{ roles: MANAGER_ROLES }`, in the group that holds sales or pipeline settings)
- Test: `src/components/WhatsAppTemplatePreview.test.jsx`, `src/components/pipelines/BoardList.test.jsx`, `src/lib/settings-tree.test.js`.

**Interfaces:**
- Consumes: `GET /api/locations/[id]/pipelines`, `GET /api/locations/[id]/stage-coverage`.
- BoardList shows each board as:
  - name, and a badge: `Built in` (board_type null) or `Offer`;
  - status: `On` / `Off` / `On — first placement tonight, no messages` (enabled and `baseline_at` null);
  - priority (offer boards);
  - stages in order, each with its follow-up chip: `Live` green, `Waiting for Meta` amber, `Rejected` red, `Off` / `None` grey. Chips use `bg-<c>-500/10 text-<c>-700`.
  - Built-in boards say `Built in code — read only`.
  - A `New board` button shows only when the user can create (the route returns `can_edit`), and links to `/settings/pipelines/new`.
  - Each offer board links to `/settings/pipelines/<id>`.
  - Empty state: `No offer boards yet.`
- [ ] **Step 1: Write failing tests:**
  - `previewRendersBodyFooterButtons`.
  - `editorStillRendersPreview` (the existing WATemplateEditor test stays green).
  - `listShowsStatusAndChips`.
  - `newBoardHiddenWithoutCanEdit`.
  - `builtInBoardsReadOnly`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, reading `can_edit` from the list GET (Task 4).
- [ ] **Step 4:** Run the tests plus `npm run lint && npm run check:guardrails`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5h — Settings → Pipelines: board list with follow-up states`.

### Task 9: Wizard steps (recipe → review)

**Files:**
- Create:
  - `src/lib/pipeline-wizard.js` (pure state)
  - `src/app/settings/pipelines/new/page.js`
  - `src/components/pipelines/BoardWizard.jsx`
  - one component per step under `src/components/pipelines/wizard/`
- Test: `src/lib/pipeline-wizard.test.js`, `src/components/pipelines/BoardWizard.test.jsx`

**Interfaces:**
- Produces:
  - `initialWizardState()`.
  - `wizardReducer(state, action)`. Actions: `pickRecipe`, `setName`, `setOfferName`, `setSigner`, `setPriority`, `setEntryValues`, `setEntryMatch`, `toggleStage`, `renameStage`, `setStageDay`, `setStageCount`, `setBody`, `setMiaNotes`, `next`, `back`.
  - `wizardConfig(state) → config` (the shape Task 4's POST takes; slugs left for the server).
  - `stepErrors(state, step) → string[]`. Client-side mirror of `parseOfferConfig`, using `boardKey:'o_preview'`, so `next` is blocked with the message shown.
- Steps, in order: `Recipe` → `Name and offer` → `Who enters` → `Stages` → `Follow-ups` → `Notes for Mia` → `Review`.
  - **Recipe:** cards from `RECIPES` (name and description).
  - **Who enters:** the entry type comes from the recipe and is shown in words (e.g. `People who buy a trial with plan code…`). The values picker is filled from `GET /api/locations/[id]/pipeline-entry-options`; `trial_purchase` also picks `match`.
  - **Stages:** the recipe's stages. `new` is always ticked and locked; the rest can be ticked and renamed; checkpoint day and Nth-class count can be edited.
  - **Follow-ups:** for each ticked stage with a pack, the wording textarea per template, defaulting to the recipe's body. Beside it is `WhatsAppTemplatePreview` with `{{1}}` shown as `Tim` and tokens filled. A short note explains the `{{1}}` and token rules.
  - **Review:** everything on one page, plus `Create board (switched off)`.
  - At a un1t.online studio the page shows `Offer boards at un1t.online studios aren't available yet.` and no wizard (`membership_source` read via the existing membership-source route).
  - Owner gate on the page: a non-owner sees `Only owners can build boards.`
- [ ] **Step 1: Write failing tests:**
  - `reducerBuildsConfigFromRecipe`.
  - `newStageCannotBeUnticked`.
  - `checkpointDayEditable`.
  - `stepErrorsMirrorParser` (empty values, missing name).
  - `followupBodyDefaultsToRecipe`.
  - `wizardBlocksNextOnErrors`.
  - `un1tStudioShowsNotice`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `npm run lint && npm run check:guardrails`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5i — board wizard: recipe, offer, entry rule, stages, follow-up wording, Mia notes, review`.

### Task 10: Wizard finish — create, install, dry run, switch on

**Files:**
- Modify: `src/components/pipelines/BoardWizard.jsx`
- Create: `src/components/pipelines/BoardLaunchPanel.jsx` (reused by Task 11)
- Test: `src/components/pipelines/BoardLaunchPanel.test.jsx`, `BoardWizard.test.jsx`

**Interfaces:**
- Consumes: POST `/api/locations/[id]/pipelines`, PUT `/api/pipelines/[id]/followups/[stageId]` (`install`), POST `/api/pipelines/[id]/dry-run`, POST `/api/pipelines/[id]/enable`.
- Flow after `Create board`:
  1. POST creates the board. A double click is prevented by a disabled button plus an in-flight ref.
  2. One `install` PUT per follow-up, run **sequentially**, each showing its returned state.
  3. `BoardLaunchPanel` shows:
     - the follow-up states;
     - `Check who would enter` (dry run): `entering`, the per-stage counts, and the overlap lines (`3 people now on the €39 Trial board would move here`);
     - `Turn on`, enabled only after a dry run in this session and when at least one follow-up is `live` or `awaiting_approval`.
     - The `Turn on` confirm text is exactly: `People who already qualify are placed tonight without any messages. From tomorrow, new people get the follow-ups.`
  4. A failed install shows its error, and a `Try again` button re-PUTs `install`.
- [ ] **Step 1: Write failing tests:**
  - `createThenInstallsSequentially`.
  - `doubleClickCreatesOnce`.
  - `turnOnDisabledUntilDryRun`.
  - `dryRunShowsOverlap`.
  - `failedInstallOffersRetry`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5j — wizard finish: create off, install follow-ups, dry run, turn on`.

### Task 11: Board settings page

**Files:**
- Create: `src/app/settings/pipelines/[id]/page.js`, `src/components/pipelines/BoardSettings.jsx`
- Test: `src/components/pipelines/BoardSettings.test.jsx`

**Interfaces:**
- Consumes: GET/PATCH `/api/pipelines/[id]`, the follow-up PUT (`install` / `replace` / `off`), dry-run, enable, disable, entry options, and the wizard step components from Task 9 (reuse; never copy).
- Sections:
  - **Status:** On/Off, the baseline note, `Turn off`, and `BoardLaunchPanel` when off.
  - **Name, offer and signer:** always editable.
  - **Who enters, Stages, Timings, Priority:** editable only when off. When on, they are read-only with `Switch the board off to change this.`
  - **Follow-ups:**
    - Per stage: the state chip and the current wording (from the template row).
    - `Change wording` opens the textarea and preview. Saving calls `replace` after a confirm: `The current message stops now. The new wording starts once Meta approves it, usually within a few hours.`
    - `Switch off` calls `off`.
    - `Install` shows when there is no row or the row is `off`/`rejected`, and acts as publish-now on a stuck row.
  - **Notes for Mia:** always editable.
- Managers see everything, but only the follow-up actions are enabled for them (the route decides; the UI hides what the GET's permissions flags say they can't do). The flags come from the detail GET's `can_edit` and `can_edit_wording` (Task 4).
- A 409 from PATCH shows the route's message.
- [ ] **Step 1: Write failing tests:**
  - `structureReadOnlyWhileOn`.
  - `managerSeesOnlyWordingActions`.
  - `replaceAsksConfirmThenCallsReplace`.
  - `patch409MessageShown`.
  - `legacyBoardIdShowsReadOnlyNotice`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests plus `npm run lint && npm run check:guardrails`. Expected: PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.5k — board settings page: edit, follow-up wording, switch on and off`.

**PR 5b is done when:**
- The CI mirror and `npm run build` pass.
- The browser pane, on a 5b Vercel preview signed in as Richard, shows the list, the wizard (creating at Test Studio only), and the settings page. No board is created at Stillorgan or Hatch.
- The PR is open with its changelog entry.

---

## End-to-end check (after both merge; Richard's go-ahead needed)

This is the spec's PR 4+5 verification on **Test Studio**, which needs a WhatsApp number on Test Studio. If it has none, say so and stop.

1. Build a board from `paid_trial_offer`.
2. Install its follow-ups. They sit in `awaiting_approval` and go `live` on the approval webhook.
3. Dry run, then turn on. The next nightly places silently, and `baseline_at` is set.
4. Move a test contact into `1st class`: one enrolment, one send.

## Not in PR 5 (stays in the remaining-work plan)

- `offer_un1t` / un1t.online offer boards (PR 3b).
- Mia, reports and onboarding (PR 6).
- Keeping the old wording live until the new wording is approved. That needs a second sequence on the follow-up row; v1 pauses the old wording first, and says so.
