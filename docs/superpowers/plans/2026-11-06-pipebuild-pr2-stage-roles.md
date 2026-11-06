# PIPEBUILD PR 2: board settings, stage kinds, stage display from data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give boards their settings columns and every stage a kind (`stage_role`), add the table that links a stage to its follow-up, make a new board's stages show correctly (colour, label, badge, audience option, card signals, coverage) without editing code, close the legacy steps API gap left by PR 1, and stop new hard-coded stage lists appearing.

**Architecture:** One migration (814) adds columns, backfills roles for every existing stage, and creates `pipeline_stage_followups` (service role only). A shared pure module `shared/pipelines/stage-roles.js` owns the role vocabulary. A small read route + client hook give UI components the studio's stages, and the existing hard-coded maps become *fallbacks*: known slugs keep exactly today's look; unknown slugs (new boards) render from the stage row. Classifier-semantic sets for the existing boards (Mia check-ins, class badges, trial-done runner, member sets) stay untouched — the spec keeps existing boards as they are.

**Tech Stack:** Next.js 16, Supabase (Postgres migrations applied via MCP), vitest, React.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` (section "PR 2: Schema and stage kinds"; PR 1 carry-over: legacy steps route).

## Global Constraints

- Work in `/Users/richardivers/code/un1t-crm-pipebuild2` on branch `pipebuild-stage-roles` (off `origin/main` 1c27409dc). Never touch `~/code/un1t-crm`'s checkout. Do not push.
- Migration number **814**, file `supabase/migrations/814_pipeline_board_settings_stage_roles.sql`. Forward-only, idempotent (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then `ADD`), wrapped in `BEGIN; … COMMIT;`, ends with a POST-state self-check `DO` block that `RAISE EXCEPTION 'mig 814: … ; nothing was applied'`. Header style as mig 809/801. It is applied to prod by the controller (Supabase MCP `apply_migration`) BEFORE the PR merges — implementers only write the file.
- Stage roles: exactly `new | first_class | class_n | checkpoint | done | converted | pile | custom`. `role_config` is jsonb, `{}` by default; `class_n` carries `{"count": <int ≥ 2>}`, `checkpoint` carries `{"day": <int ≥ 1>}`.
- Existing boards must look and behave exactly as today: same colours, labels, badges, signals, Mia check-ins. A change is allowed only where today shows nothing (an unknown slug).
- Every supabase read/write destructures `error`; a zero-row CAS is not an error; 1,000-row cap → `.range()` + explicit `.order()`.
- New route returns 404 for a studio the caller can't access (`assertLocationAccessOr404`), `{ success, data }`, registered in `src/lib/openapi.js`; path ids use `uuidLike` from `@/lib/schemas`.
- No new `console.log`. Chips use `bg-<c>-500/10 text-<c>-700` or the existing `statusBadge` classes; `un1t-*` tokens only.
- Commit messages `PIPEBUILD.2x — <summary>`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A stage slug that exists in prod but in no board module** (e.g. `active_member`, `trial_active`, `follow_up_needed`, `waitlist_*`, `returning_*`): the backfill gives it `pile` if `is_dormant`, else `custom`; never fails the migration. → Task 1 test `backfillsUnknownSlugsSafely`.
2. **A browser admin editing `stage_role` on an existing board via the `pipeline_stages` update policy**: the DB check constraint still bounds values; a garbage role is refused. → Task 1 test `checkConstraintBoundsRoles`.
3. **Studio stages hook fails or is still loading** in AudienceBuilder / ContactsTable / PipelineReclassifyTab: every known slug still renders exactly as today; unknown slugs show the bare slug. → Task 4 tests `knownSlugsUnchangedWhileLoading`, `unknownSlugUsesStageNameWhenLoaded`.
4. **Legacy steps PUT on a live sequence with a PENDING template**: refused with the same copy as PR 1's activation gate; a draft sequence is not checked. → Task 6 tests.
5. **Card signals on an existing board** (paid_trial/acquisition): unchanged; only boards with `board_type` set use role-based signals. → Task 5 test `existingBoardsKeepSignalSet`.

---

### Task 1: Migration 814 — board settings, stage roles, follow-up link table

**Files:**
- Create: `supabase/migrations/814_pipeline_board_settings_stage_roles.sql`
- Create: `tests/migration-814-pipeline-board-settings.test.js` (reads the SQL text, house style of other `tests/migration-*.test.js`)

**Interfaces:**
- Produces (DB):
  - `pipelines`: `board_type text NULL`, `recipe_key text NULL`, `config jsonb NOT NULL DEFAULT '{}'`, `priority integer NOT NULL DEFAULT 100`, `created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. Check `pipelines_board_type_module_chk`: `board_type IS NULL OR module IN ('offer','offer_un1t')`. Check `pipelines_board_type_chk`: `board_type IS NULL OR board_type IN ('offer')`.
  - `pipeline_stages`: `stage_role text NOT NULL DEFAULT 'custom'` with check `pipeline_stages_stage_role_chk` (the eight roles), `role_config jsonb NOT NULL DEFAULT '{}'` with check `pipeline_stages_role_config_chk`: `jsonb_typeof(role_config) = 'object'`.
  - Backfill (by slug, all studios), then `is_dormant = true` rows not otherwise mapped → `pile`:
    - `new`: `new_lead`, `paid_trial_new_lead`, `programme_lead`, `waitlist_new_enquiry`, `returning_booked`
    - `first_class`: `first_class`, `paid_trial_first_class`, `programme_first_class`, `returning_first_class`
    - `class_n {"count":2}`: `second_class`, `returning_second_class`
    - `checkpoint {"day":7}`: `paid_trial_day_7`
    - `done`: `trial_done`, `paid_trial_done`, `returning_final_class`
    - `converted`: `converted`, `paid_trial_converted`, `programme_converted`, `waitlist_converted`
    - `pile`: `member`, `pack_member`, `classpass`, `gympass`, `cold_lead`, `dormant`
    - everything else stays `custom` (incl. `rebook`) unless `is_dormant` → `pile`.
  - New table `public.pipeline_stage_followups`: `id uuid PK default gen_random_uuid()`, `location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE`, `pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE`, `stage_id uuid NOT NULL REFERENCES public.pipeline_stages(id) ON DELETE CASCADE`, `sequence_id uuid NULL REFERENCES public.email_sequences(id) ON DELETE SET NULL`, `whatsapp_template_id uuid NULL REFERENCES public.whatsapp_templates(id) ON DELETE SET NULL`, `pack_key text NULL`, `state text NOT NULL DEFAULT 'draft'` check in (`draft`,`awaiting_approval`,`live`,`rejected`,`off`), `want_live boolean NOT NULL DEFAULT false`, `created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`; unique `(stage_id, pack_key)`; indexes on `(location_id)`, `(whatsapp_template_id)`, `(sequence_id)`. `ENABLE ROW LEVEL SECURITY`, no policy, `REVOKE ALL ON public.pipeline_stage_followups FROM anon, authenticated;`.
  - Header lines: `-- grant: pipelines/pipeline_stages columns ride their existing table-level grants (no column grants on these tables)` and `-- column-grant: n/a`.
- Self-check asserts: the five new `pipelines` columns exist; `stage_role`/`role_config` exist; no `pipeline_stages` row has a role outside the eight; `paid_trial_day_7` rows have `role_config->>'day' = '7'`; the new table exists with RLS on and `authenticated` holding no privilege on it (`has_table_privilege`).

- [ ] **Step 1: Write the failing test** `tests/migration-814-pipeline-board-settings.test.js`: `addsBoardSettingsColumns`, `checkConstraintBoundsRoles` (constraint text lists exactly the eight roles), `backfillsKnownSlugs` (each slug group above appears with its role; `second_class` gets count 2; `paid_trial_day_7` day 7), `backfillsUnknownSlugsSafely` (an `is_dormant` → `pile` update scoped to `stage_role = 'custom'`; default `'custom'`), `followupsTableClosedToClients` (RLS enabled, REVOKE from anon+authenticated, no `CREATE POLICY`), `selfCheckPresent`.
- [ ] **Step 2: Run** `npx vitest run tests/migration-814-pipeline-board-settings.test.js tests/table-default-acl-guard.test.js tests/audit-secret-keys-guard.test.js` — new test FAILS (file missing).
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** the same command plus `npm run check:select-columns && npm run check:rls-restrictive && npm run check:rpc-names` — PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.2a — mig 814: board settings, stage roles, stage follow-up links`.

### Task 2: Stage-role vocabulary + legacy-board guard

**Files:**
- Create: `shared/pipelines/stage-roles.js` (+ `stage-roles.test.js`), `src/lib/pipeline-board-guard.js` (+ `.test.js`)
- Modify: `shared/pipelines/index.js` only if it is the package's export surface for `shared/pipelines/*` (check `shared/package.json` exports / `check:mobile-imports`)

**Interfaces:**
- Produces (`shared/pipelines/stage-roles.js`, pure):
  - `STAGE_ROLES = ['new','first_class','class_n','checkpoint','done','converted','pile','custom']`
  - `stageRoleOf(stage) => string` — `stage.stage_role` if in `STAGE_ROLES`, else `'pile'` when `stage.is_dormant`, else `'custom'`.
  - `isLiveFunnelRole(role) => boolean` — true for `new, first_class, class_n, checkpoint, done`.
  - `isPileRole(role) => boolean`.
  - `roleConfigError(role, config) => string|null` — `class_n` needs integer `count ≥ 2`; `checkpoint` integer `day ≥ 1`; others accept `{}`.
- Produces (`src/lib/pipeline-board-guard.js`): `assertNotLegacyBoard(board) => NextResponse|null` — 409 `{ success:false, error:'This board is built in code and can't be changed here.' }` when `board.board_type == null`; `null` otherwise.

- [ ] **Step 1: Write failing tests:** `stageRoleOfPrefersStoredRole`, `stageRoleOfFallsBackToDormant`, `liveFunnelRoles`, `roleConfigValidation` (count 1 → error, day 0 → error, `{count:3}` ok), `legacyBoardRefused`, `configuredBoardAllowed`.
- [ ] **Step 2: Run** `npx vitest run shared/pipelines/stage-roles.test.js src/lib/pipeline-board-guard.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npm run check:mobile-imports` — PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.2b — stage-role vocabulary and the legacy-board guard`.

### Task 3: Studio stages read (route + hook) and coverage on roles

**Files:**
- Create: `src/app/api/locations/[id]/stages/route.js` (+ `route.test.js`), `src/lib/use-studio-stages.js` (+ `.test.js`)
- Modify: `src/lib/pipeline-stage-coverage.js` (+ its test), `src/lib/openapi.js`

**Interfaces:**
- Produces: `GET /api/locations/[id]/stages` → `{ success: true, data: { stages: [{ slug, name, color, stage_role, role_config, is_dormant, display_order, board_key, board_name }] } }` — stages of ENABLED boards at the studio, not archived, ordered by board `display_order` then stage `display_order`. Gate: `getCurrentUser` (401) → `assertLocationAccessOr404` (any member; mirrors the `pipeline_stages_select` RLS policy) → read; read failure → 503.
- Produces: `useStudioStages(locationId) => { stages: Array|null, bySlug: Map<string, stage>, error: boolean }` — client hook, one fetch per `locationId` per page load (module-level promise cache), `stages === null` while loading or after failure.
- Coverage: `loadStageCoverage` selects `stage_role`; `isPile` = `isPileRole(stageRoleOf(stage))`; replace `ENTRY_TRIGGERS_BY_STAGE` with `ENTRY_TRIGGERS_BY_MODULE = { acquisition: ['contact_created'], acquisition_un1t: ['contact_created'], paid_trial: ['paid_trial_checkout_purchased'], paid_trial_un1t: ['un1t_paid_trial_purchased'] }` applied to the board's `role === 'new'` stage (board `module` read alongside `key`, `name`). Response shape of `/stage-coverage` unchanged.

- [ ] **Step 1: Write failing tests:** route `401Unauthenticated`, `404OtherStudio`, `200AnyMember`, `503OnReadError`, `excludesDisabledBoardsAndArchivedStages`; hook `fetchesOncePerLocation`, `nullWhileLoadingAndOnError`; coverage `entryTriggersByModuleOnNewRole` (Hatch `paid_trial_un1t` new stage counts `un1t_paid_trial_purchased` only; Stillorgan `paid_trial` counts `paid_trial_checkout_purchased` only), `pileFromRole`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/locations/[id]/stages/route.test.js' src/lib/use-studio-stages.test.js src/lib/pipeline-stage-coverage.test.js` — FAIL.
- [ ] **Step 3: Implement**; register the route in `openapi.js` (path id `uuidLike`).
- [ ] **Step 4: Run** the same + `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns` — PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.2c — studio stages read; coverage counts entry triggers by board`.

### Task 4: Stage display from data (known slugs unchanged, new slugs from the row)

**Files:**
- Modify: `src/components/KanbanBoard.jsx`, `src/components/AudienceBuilder.jsx`, `src/components/ContactsTable.jsx`, `src/components/PipelineReclassifyTab.jsx`, `src/components/sequences/SequenceSettings.jsx` (goal-stage picker), `src/components/pipeline-stage-maps.test.jsx`
- Test: each component's existing test file (create a focused one where none exists)

**Interfaces:**
- Consumes: `useStudioStages` (Task 3).
- Rules (one per component):
  - KanbanBoard column accent: `stage.color || stageColors[stage.slug] || '#6B7280'` (prod colours equal the map for every current slug, verified 6 Nov 2026; keep the map as the fallback, comment so).
  - AudienceBuilder `pipeline_stage_slug` options: today's 11 slugs first, then every studio stage slug not already listed, labelled `"<board_name>: <stage name>"`; label lookup `STAGE_LABELS[slug] ?? bySlug.get(slug)?.name ?? slug`. The component needs the studio id — take it from an existing prop/context if present, else add an optional `locationId` prop and pass it from its callers that know the studio; without it the options stay exactly today's.
  - ContactsTable badge: `statusBadge[slug]` when known (unchanged); unknown slug with a loaded studio stage → neutral chip `bg-slate-500/10 text-slate-700` showing the stage name; otherwise today's fallback.
  - PipelineReclassifyTab `fmtSlug`: `STAGE_LABELS[slug] ?? bySlug.get(slug)?.name ?? slug`.
  - SequenceSettings goal-stage picker: `PIPELINE_SLUGS` plus studio stages not already listed (same label rule as the trigger picker from PR 1).
  - `pipeline-stage-maps.test.jsx`: keep its existing assertions (they pin today's look) and add `unknownSlugUsesStageNameWhenLoaded` for one component.

- [ ] **Step 1: Write failing tests:** `kanbanUsesStageColor`, `audienceOffersStudioStages`, `knownSlugsUnchangedWhileLoading` (AudienceBuilder + ContactsTable render today's labels/badges with the hook returning `stages: null`), `unknownSlugUsesStageNameWhenLoaded` (ContactsTable chip + reclassify label), `goalPickerOffersStudioStages`.
- [ ] **Step 2: Run** `npx vitest run src/components/KanbanBoard src/components/AudienceBuilder src/components/ContactsTable src/components/PipelineReclassifyTab src/components/sequences src/components/pipeline-stage-maps.test.jsx` — FAIL on new tests.
- [ ] **Step 3: Implement.** Mock the hook in component tests (`vi.mock('@/lib/use-studio-stages', …)`); fake timers only inside `act()`.
- [ ] **Step 4: Run** the same + `npm run check:guardrails` — PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.2d — stage colour, label and badge come from the stage row for boards the code doesn't know`.

### Task 5: Card signals by role for configured boards

**Files:**
- Modify: `src/lib/pipeline-card-signal-slugs.js`, `src/app/(sales)/pipeline/page.js`, `src/app/api/pipeline/deals/route.js`, `src/components/DealCard.jsx` (+ their tests)

**Interfaces:**
- Produces: `stageShowsSignals({ board, stage }) => boolean` in `pipeline-card-signal-slugs.js` — `SIGNAL_SLUGS.has(stage.slug) || (board?.board_type != null && isLiveFunnelRole(stageRoleOf(stage)))`.
- The two server consumers call it with the board + stage rows they already hold (select `board_type`, `stage_role`, `is_dormant` alongside today's columns) and hand DealCard a boolean (`showSignals`) instead of DealCard re-deciding from `columnSlug`; DealCard's other behaviour unchanged.
- `BADGE_SLUGS`, `CHECKIN_STAGES`, trial-done runner, member sets: untouched (existing-board semantics).

- [ ] **Step 1: Write failing tests:** `existingBoardsKeepSignalSet` (paid_trial/acquisition stages → same booleans as `SIGNAL_SLUGS`), `configuredBoardUsesRoles` (board_type 'offer', role `checkpoint` → true, `converted`/`pile` → false), DealCard renders signals iff `showSignals`.
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-card-signal-slugs.test.js 'src/app/(sales)/pipeline' src/app/api/pipeline/deals src/components/DealCard` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npm run check:select-columns` — PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.2e — card signals for configured boards come from stage roles`.

### Task 6: Gate the legacy steps API + slug-literal guard

**Files:**
- Modify: `src/app/api/sequences/[id]/steps/route.js`, `src/app/api/sequences/[id]/steps/[stepId]/route.js`
- Create: `src/app/api/sequences/[id]/steps/route.test.js`, `tests/pipeline-slug-literals-guard.test.js`

**Interfaces:**
- Consumes: `loadTemplatesForApproval`, `whatsappApprovalIssues` (`src/lib/sequences/template-approval.js`, PR 1).
- Steps routes: load the sequence's `status` with its `location_id`; when the sequence is `active` and the request sets a non-null `whatsapp_template_id` on any step, check it with the PR 1 helpers → 400 with PR 1's activation copy (`Step N uses the WhatsApp template "<name>", which is <STATUS> at Meta. Activate it once the template is approved.` — "Activate" becomes "Use"), 503 on read failure; drafts unchecked. PUT checks each update's `error` (today ignored) and returns 500 naming the step on failure.
- Guard test: scans non-test `.js/.jsx` under `src/`, `shared/` (excluding `shared/pipelines/`) and `mobile/` (excluding `node_modules`, `ios`, `android`) for an array, Set or object literal containing ≥ 3 distinct strings from the known stage-slug list (the slugs in Task 1's backfill + `rebook`); fails unless the file+line-range is in a frozen `BASELINE` (today's sites, listed in the test with one-line reasons: e.g. `src/components/KanbanBoard.jsx stageColors — fallback for code-built boards`). A baseline entry whose file no longer has a match fails as stale.

- [ ] **Step 1: Write failing tests:** steps `liveSequencePendingTemplateRefused` (POST and PUT), `draftSequenceNotChecked`, `readFailure503`, `putUpdateErrorReported`; guard `noNewStageSlugLists` (baseline equals today's sites → passes after Step 3), `staleBaselineFails`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/sequences/[id]/steps' tests/pipeline-slug-literals-guard.test.js tests/role-sweep/sequence-builder-routes.test.js` — FAIL on new tests.
- [ ] **Step 3: Implement** both routes and the guard with its baseline.
- [ ] **Step 4: Run** the same + `npm run check:route-guards && npm run check:guardrails` — PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.2f — the legacy steps API refuses an unapproved template on a live sequence; no new hard-coded stage lists`.
