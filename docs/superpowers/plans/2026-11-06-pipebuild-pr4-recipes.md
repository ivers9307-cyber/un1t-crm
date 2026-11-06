# PIPEBUILD PR 4: recipes and follow-up packs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A library of board recipes ("€39 trial", "Programme lead", "Promo claim"), each with per-stage follow-up packs (WhatsApp template wording + a sequence graph), a server-side installer that submits a pack's templates to Meta, creates its draft sequence and links both to the stage in `pipeline_stage_followups`, and an approval hook that publishes a follow-up the moment Meta approves its templates (and marks it rejected if Meta refuses).

**Architecture:** Pure recipe/pack definitions and rendering in `shared/pipelines/recipes.js`; two helpers lifted out of routes so libs can call them (`submitWhatsappTemplate`, `publishSequence`), with the routes' behaviour unchanged; an installer lib and an approval lib. No new route, page or migration (PR 5's builder calls the installer; mig 814 already created `pipeline_stage_followups`). Nothing in this PR is reachable from the UI, so nothing customer-facing changes.

**Tech Stack:** Next.js 16, Supabase (service role), Meta WhatsApp Cloud API via existing `src/lib/whatsapp.js`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` ("PR 4: Recipes and follow-up packs"); remaining-work carry-over (always write a `pack_key`; writers set `updated_at`).

## Global Constraints

- Worktree `/Users/richardivers/code/un1t-crm-pipebuild4`, branch `pipebuild-recipes` (off `origin/main` 850c83db7). Never touch `~/code/un1t-crm`. Do not push.
- **Routes keep exact behaviour** after the lifts: `POST /api/whatsapp/templates` and `POST /api/sequences/[id]/graph/publish` return the same statuses, bodies and writes for every case their existing tests cover.
- A follow-up goes live **only** when every WhatsApp template in its sequence graph is APPROVED (publish already enforces `requireApprovedTemplates`). State changes are compare-and-set on `state` so webhook + sync can never publish twice.
- Hooks never throw; every write destructures `error`; `updated_at` set on every `pipeline_stage_followups` write; a `pack_key` is always written.
- Template names: `${studioSlug}_${boardKey}_${packKey}[_${ref}]`, lowercased, only `[a-z0-9_]`, ≤ 512 chars; `studioSlug` = the location's `name` lowercased with non-alphanumerics → `_` and runs collapsed (e.g. `un1t_stillorgan`). Language `en`, category `MARKETING`, footer `Reply STOP to unsubscribe`, variable `{{1}}` = first name with example `Tim`.
- Default copy is today's live €39 wording (Garrett's voice) with fill-ins `{studio}`, `{offer}`, `{days}`, `{signer}`; Programme and Promo copy follows the same voice. Nothing is sent from this PR.
- Graph conventions: leading `wait {minutes:1}` before the first timed wait; every `whatsapp` node guarded by `in_pipeline_stage_at_studio [stageSlug]`; tags `${boardKey}_${packKey}_sent` / `_not_in_stage` / etc.; row-level `trigger_type 'pipeline_stage_change'` + `trigger_config { to_status: stageSlug }` match the graph trigger.
- `tests/whatsapp-config-callers.test.js` table must be updated for the moved `createTemplate` / `ownNumberOrRefusal` calls.
- Commit messages `PIPEBUILD.4x — <summary>`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Meta accepts the template but the local insert fails** (orphan at Meta): the installer reports a clear error and a reinstall links the existing Meta template by (WABA, name, language) instead of failing on the name clash. → Task 1 test `insertFailureAfterMetaReportsOrphan`, Task 4 test `reinstallLinksExistingTemplate`.
2. **A two-template pack** (trial done + follow-up): approval of the first template must NOT publish; approval of the second publishes. → Task 5 test `publishesOnlyWhenAllTemplatesApproved`.
3. **Approval arrives by webhook and by sync for the same template**: exactly one publish. → Task 5 test `concurrentApprovalPublishesOnce`.
4. **A studio with no booking flow or no app links**: the pack renders without that button rather than failing. → Task 3 test `missingButtonsAreDropped`.
5. **A follow-up whose templates were already APPROVED at install** (reinstall, or a shared template): it publishes at install when `wantLive`, without waiting for a webhook that will never come. → Task 4 test `alreadyApprovedPublishesAtInstall`.

---

### Task 1: Lift `submitWhatsappTemplate` out of the templates route

**Files:** Create `src/lib/whatsapp-template-submit.js` (+ `.test.js`). Modify `src/app/api/whatsapp/templates/route.js`, `tests/whatsapp-config-callers.test.js`.

**Interfaces (produces):** `submitWhatsappTemplate(db, { locationId, name, category = 'MARKETING', language = 'en', components = [], createdBy = null, parameterFormat, exampleValues, headerMediaHandle, headerMediaUrl, headerMediaPath, displayGroup }) => Promise<{ ok: true, template } | { ok: false, status, error, code? }>` — runs `componentsButtonsError` (400), `ownNumberOrRefusal(locationId, 'wa-templates-create')` (its status), the per-WABA name clash read (409 with today's copy, `code: 'name_clash'`, plus `existing: { id }` when the clashing row is this studio's same-language row; 500 on read failure), `createMetaTemplate` (400 with Meta's message), the insert (400; when Meta succeeded but the insert failed, error text says the template exists at Meta and a re-sync will adopt it, `code: 'orphan_at_meta'`). The route maps the result to today's responses.

- [ ] Step 1 tests: `buttonsErrorIs400`, `noNumberPassesStatusThrough`, `nameClashIs409WithExisting`, `metaErrorIs400`, `insertFailureAfterMetaReportsOrphan`, `successReturnsTemplate`; existing templates route tests stay green.
- [ ] Step 2 `npx vitest run src/lib/whatsapp-template-submit.test.js src/app/api/whatsapp/templates tests/whatsapp-config-callers.test.js` — FAIL. Step 3 implement. Step 4 PASS + `npm run check:route-guards`.
- [ ] Step 5 commit `PIPEBUILD.4a — submitWhatsappTemplate lifted out of the templates route`.

### Task 2: Lift `publishSequence` out of the publish route

**Files:** Create `src/lib/sequences/publish.js` (+ `.test.js`). Modify `src/app/api/sequences/[id]/graph/publish/route.js`.

**Interfaces (produces):** `publishSequence(db, { sequenceId, graph }) => Promise<{ ok: true, steps: number } | { ok: false, status, error, issues? }>` — loads `location_id, graph, draft_graph` (404), picks `graph ?? draft_graph ?? graph` (400), template read via `loadTemplatesForApproval` fail-closed (503), `compileForPublish(…, { requireApprovedTemplates: true })` (422 + issues), step plan + `publish_sequence_steps` rpc (500), sequence update `graph/draft_graph null/status active` (500). Keep `STEP_ROW_SELECT` as a same-file literal. The route keeps its auth/permission checks and maps the result.

- [ ] Step 1 tests: `notFound404`, `nothingToPublish400`, `templateReadFailure503`, `pendingTemplate422`, `publishesAndActivates`; existing publish route tests stay green.
- [ ] Steps 2–4 `npx vitest run src/lib/sequences/publish.test.js 'src/app/api/sequences/[id]/graph/publish'` + `npm run check:select-columns && npm run check:rpc-names`.
- [ ] Step 5 commit `PIPEBUILD.4b — publishSequence lifted out of the publish route`.

### Task 3: Recipes and follow-up packs (pure)

**Files:** Create `shared/pipelines/recipes.js` (+ `.test.js`).

**Interfaces (produces):**
- `RECIPES`: `paid_trial_offer` (entry `trial_purchase` match `plan_code`; stages New Leads, 1st Class, Day 7 checkpoint, Trial Done, Converted; duration 14), `programme_lead` (entry `lead_source`; Lead, 1st Class Done, Converted; duration 30), `promo_claim` (entry `corp_promo`; New, 1st Class, Done, Converted; duration 7). Each: `{ key, name, description, boardType: 'offer', defaultConfig(boardKey) (passes parseOfferConfig with values []), packs: [{ key, role, day?, count?, name, templates: [{ ref, body, buttons: ('book'|'apps')[] }], graph }] }`.
- Packs (copy from today's live €39 templates, fill-ins `{studio}`, `{offer}`, `{days}`, `{signer}`):
  - `paid_trial_offer`: `book_first_class` (role new; wait 1m → 2d → still in New and no booking in 3d → send; buttons book), `after_first_class` (role first_class; wait 1m → 3h → still in stage → send; buttons book + apps), `halfway` (checkpoint day 7; still in stage → booked within 8 days → its `main` template (today's day-7 wording), else its own `nudge` template (today's book-your-first-class wording); packs never share templates), `trial_done` (role done; still in stage → `main` offer message → wait 2h+22h → replied? tag : still in stage → `followup` template).
  - `programme_lead`: `welcome` (role new; 1m → 1d → no booking → book-your-first-class message; buttons book), `after_first_class` (role first_class; 3h check-in; buttons book + apps).
  - `promo_claim`: `welcome` (role new; 1m → 1d → no booking → nudge), `after_first_class`, `ending` (role done; offer-ended message).
- `renderPack(recipeKey, packKey, { boardKey, studioSlug, studioName, offerName, durationDays, signer, bookingFlowId, appLinks: { iosUrl, androidUrl } }) => { templates: [{ ref, name, category, language, components }], buildGraph(templateIdsByRef, stageSlug) => graph }` — substitutes fill-ins, adds footer and `{{1}}` example, builds buttons (`book` → FLOW button `{ type:'FLOW', text:'Book a class', flow_id, flow_action:'data_exchange' }` only when `bookingFlowId`; `apps` → up to two URL buttons `iPhone app` / `Android app` only for present links), names templates per Global Constraints; `buildGraph` returns a graph that passes `validateGraph` with the real ids.
- `templateNameFor({ studioSlug, boardKey, packKey, ref })`, `studioSlugFor(locationName)`.

- [ ] Step 1 tests: `everyRecipeConfigParses`, `everyPackGraphValidates` (with fake ids), `rendersFillIns` (no `{studio}` etc. left), `missingButtonsAreDropped`, `templateNamesSafeAndUnique`, `paidTrialCopyMatchesLive` (the €39 bodies equal today's live wording when rendered for Stillorgan with offer "14 Day Reset", days 14, signer "Garrett").
- [ ] Steps 2–4 `npx vitest run shared/pipelines/recipes.test.js` + `npm run check:mobile-imports`.
- [ ] Step 5 commit `PIPEBUILD.4c — board recipes and their follow-up packs`.

### Task 4: Follow-up pack installer

**Files:** Create `src/lib/pipeline-followup-packs.js` (+ `.test.js`). Modify `tests/whatsapp-config-callers.test.js` only if this file imports a resolver (it should call `submitWhatsappTemplate` instead).

**Interfaces (produces):** `installFollowupPack(db, { locationId, pipelineId, stage: { id, slug }, recipeKey, packKey, render: {...renderPack inputs minus boardKey/studioSlug}, createdBy, wantLive = true }) => Promise<{ ok: true, followup, created: boolean } | { ok: false, status, error, code? }>`:
  1. Read the board (`pipelines` `id, key, location_id, board_type`) and the location `name`; refuse unless the board is at `locationId` and `board_type` is set (404 / 409 via `assertNotLegacyBoard`).
  2. If a follow-up row exists for `(stage_id, pack_key)` in state `awaiting_approval`/`live`, return it (`created: false`).
  3. `renderPack`; for each template `submitWhatsappTemplate`; on `name_clash` with `existing.id`, link that row (reinstall); any other failure → return it (no sequence created).
  4. Insert `email_sequences` (`location_id`, `name` "<board name> · <pack name>", `trigger_type 'pipeline_stage_change'`, `trigger_config { to_status: stage.slug }`, `status 'draft'`, `draft_graph` = `buildGraph(ids, stage.slug)` normalised by `parseGraphShape`, `created_by`).
  5. Upsert `pipeline_stage_followups` on `(stage_id, pack_key)`: `location_id, pipeline_id, stage_id, sequence_id, whatsapp_template_id` (the pack's first template), `pack_key`, `state 'awaiting_approval'`, `want_live`, `created_by`, `updated_at`.
  6. If every template is already APPROVED and `wantLive`: claim with CAS `awaiting_approval → live`, then `publishSequence`; revert to `awaiting_approval` on failure (same pattern as Task 5).

- [ ] Step 1 tests: `installsTemplatesSequenceAndLink`, `refusesLegacyBoard`, `refusesOtherStudioBoard`, `existingFollowupReturned`, `reinstallLinksExistingTemplate`, `templateFailureCreatesNoSequence`, `alreadyApprovedPublishesAtInstall`.
- [ ] Steps 2–4 `npx vitest run src/lib/pipeline-followup-packs.test.js tests/whatsapp-config-callers.test.js` + `npm run check:select-columns`.
- [ ] Step 5 commit `PIPEBUILD.4d — install a follow-up pack: templates, draft sequence, stage link`.

### Task 5: Approval and rejection hook

**Files:** Create `src/lib/pipeline-followup-approval.js` (+ `.test.js`). Modify `src/lib/whatsapp-template-events.js` (+ test), `src/app/api/whatsapp/templates/route.js` (sync branch) (+ test).

**Interfaces (produces):** `onTemplateStatusForFollowups(db, { id, location_id }, status) => Promise<{ published: number, rejected: number }>` (never throws):
- `APPROVED`: read follow-ups at the template's studio in state `awaiting_approval` with `want_live = true` whose sequence's `draft_graph ?? graph` references this template id; for each, if every WhatsApp template id in that graph is APPROVED at the studio (one read), claim with CAS `state awaiting_approval → live` (`.eq('state','awaiting_approval').select('id')`; 0 rows = someone else claimed it, skip), then `publishSequence`; on publish failure revert CAS `live → awaiting_approval` + `logError` (the table's state check allows only draft|awaiting_approval|live|rejected|off, so there is no intermediate state).
- `REJECTED` / `DISABLED`: CAS matching follow-ups `awaiting_approval → rejected` only (a `live` follow-up already passed approval and keeps running; the existing runtime deferral/pausing handles a template Meta later disables).
- Wire: `applyTemplateEvent` calls it after the status update succeeds for `APPROVED` (beside `onTemplateApproved`) and for `REJECTED`/`DISABLED`; the templates sync branch calls it for a transition to `APPROVED`.

- [ ] Step 1 tests: `publishesWhenApproved`, `publishesOnlyWhenAllTemplatesApproved`, `concurrentApprovalPublishesOnce` (second CAS matches 0 rows), `rejectedMarksAwaiting`, `publishFailureRevertsState`, `neverThrows`, `webhookCallsHook`, `syncCallsHookOnApprovedTransition`.
- [ ] Steps 2–4 `npx vitest run src/lib/pipeline-followup-approval.test.js src/lib/whatsapp-template-events.test.js src/app/api/whatsapp/templates src/app/api/webhooks/whatsapp` + `npm run check:select-columns`.
- [ ] Step 5 commit `PIPEBUILD.4e — follow-ups publish themselves when Meta approves their templates`.
