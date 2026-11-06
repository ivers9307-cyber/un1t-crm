# PIPEBUILD PR 1: follow-up safety fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sequence can never go live on an unapproved WhatsApp template, a pending template waits instead of pausing for good (but never sends more than 48 h late), enrolments resume when Meta approves, the stage picker shows the studio's real stages, branches can ask "has a future booking", and every board shows which stages have no follow-up.

**Architecture:** No migration. Pure helpers in two new lib files (`src/lib/sequences/template-approval.js`, `src/lib/sequences/template-wait.js`) and one IO lib (`src/lib/pipeline-stage-coverage.js`), wired into the existing publish/PUT routes, the scheduler catch, `applyTemplateEvent`, the template sync, the branch evaluator and one new read route that feeds both the sequence editor's stage picker and a coverage strip on the pipeline page.

**Tech Stack:** Next.js 16 App Router, supabase-js (service role in routes), vitest, React client components.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` (section "PR 1: Safety fixes").

## Global Constraints

- Work in `/Users/richardivers/code/un1t-crm-pipebuild` on branch `pipebuild-safety-fixes` (off `origin/main`). Never touch `~/code/un1t-crm`'s checkout.
- Every supabase write destructures and handles `error`; a zero-row CAS is not an error (CLAUDE.md "supabase-js / PostgREST traps").
- Today's boards and live sequences must behave exactly as before except: unapproved templates can no longer be published/activated, and a PENDING template defers instead of erroring.
- Staleness cap: **48 hours** (`TEMPLATE_WAIT_MAX_MS = 48 * 3_600_000`). Pending retry interval: **60 minutes** (`TEMPLATE_WAIT_RETRY_MS = 60 * 60_000`).
- Deferring statuses: `PENDING`, `IN_APPEAL`, `PAUSED`. Every other non-`APPROVED` status (REJECTED, DISABLED, missing, …) stays an error, stamped.
- Stamp format on `last_error`: `[wa_tpl:<templateId>] ` prefix (`templateStamp(id)`).
- New route returns 404 for a studio the caller can't access (`assertLocationAccessOr404`), uses `{ success, data }`, is registered in `src/lib/openapi.js`.
- No new `console.log`; use `logWarn`/`logError` from `@/lib/log`.
- Customer-facing copy is not changed by this PR. Staff-facing copy is plain English, no jargon.
- Commit messages: `PIPEBUILD.1x — <summary>`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A sequence already live on a template that later goes PAUSED by Meta** (quality): the step defers, then exits at 48 h; it must not pause the enrolment or send late. → Task 2 test `pausedByMetaDefersThenExits`.
2. **Enrolment waiting on template A, then the sequence is republished with template B at the same step**: the wait record must not carry A's start time over to B. → Task 2 test `waitRecordResetsWhenTemplateChanges`.
3. **Approval webhook for a template at studio X while a same-named template exists at studio Y**: only X's enrolments resume. → Task 3 test `resumesOnlyAtTemplateStudio`.
4. **Operator re-activates a paused sequence through PUT (status toggle) while its template is still PENDING**: refused, same as publish. → Task 1 test `putActivateRefusesPendingTemplate`.
5. **Coverage for a studio with a disabled or archived board/stage**: not shown, never red. → Task 5 test `skipsDisabledBoardsAndArchivedStages`.

---

### Task 1: Publish and activation refuse unapproved templates

**Files:**
- Create: `src/lib/sequences/template-approval.js`, `src/lib/sequences/template-approval.test.js`
- Modify: `src/lib/sequences/graph/validate.js` (new option), `src/lib/sequences/graph/persist.js` (`compileForPublish` passes it through)
- Modify: `src/app/api/sequences/[id]/graph/publish/route.js`, `src/app/api/sequences/[id]/route.js` (PUT)
- Test: `src/lib/sequences/graph/validate.test.js`, `src/app/api/sequences/[id]/graph/publish/route.test.js`, `src/app/api/sequences/[id]/route.test.js`

**Interfaces:**
- Produces: `whatsappApprovalIssues(refs: Array<{ stepNumber: number, nodeId?: string, templateId: string }>, templates: Array<{ id, name, status }>) => Array<{ code: 'template_not_found'|'template_not_approved', nodeId?, message }>` (pure)
- Produces: `loadTemplatesForApproval(db, { locationId, templateIds }) => Promise<{ ok: true, rows } | { ok: false, error }>` — selects `id, name, status, components` scoped to `location_id`; never throws.
- Produces: `validateGraph(graph, { whatsappTemplates, requireApprovedTemplates = false })` — when true, appends `whatsappApprovalIssues` for every WhatsApp node (step number = 1-based node index, as `urlButtonErrors` counts).

- [ ] **Step 1: Write failing tests**
  - `template-approval.test.js`: `flagsPendingTemplate` (status PENDING → one issue, code `template_not_approved`, message contains the template name and `PENDING`); `flagsMissingTemplate` (id not in list → `template_not_found`); `passesApproved` (→ `[]`).
  - `validate.test.js`: `requireApprovedTemplatesOffByDefault` (PENDING template, no option → no approval error, so the builder's inline view is unchanged); `requireApprovedTemplatesFlagsPending` (option true → error code `template_not_approved` on that node id).
  - publish `route.test.js`: `refusesPendingTemplate` (422, `issues[0].code === 'template_not_approved'`, no `publish_sequence_steps` rpc call, no `email_sequences` update); `failsClosedWhenTemplateReadErrors` (template read returns `{ error }` → 503, nothing written); existing approved-template publish tests still pass (their template mocks gain `status: 'APPROVED'`).
  - PUT `route.test.js`: `putActivateRefusesPendingTemplate` (existing status `paused`, body `{ status: 'active' }`, a step with a PENDING template → 400 with an error naming the template, no update); `putActivateAllowsApproved`; `putOtherFieldsSkipsCheck` (already-active sequence, body `{ name }` → no template read).
- [ ] **Step 2: Run** `npx vitest run src/lib/sequences/template-approval.test.js src/lib/sequences/graph/validate.test.js 'src/app/api/sequences/[id]/graph/publish/route.test.js' 'src/app/api/sequences/[id]/route.test.js'` — expect the new tests to FAIL.
- [ ] **Step 3: Implement.** Publish route: select `id, name, status, components`; on read error return 503 `{ success:false, error:'Could not check the WhatsApp templates just now. Nothing was published.' }` (replaces the fail-open branch; URL-button rule keeps working off the same rows); call `compileForPublish(graph, { whatsappTemplates, requireApprovedTemplates: true })`. PUT: only when `effStatus === 'active' && existing.status !== 'active'`, read the sequence's `sequence_steps` (`whatsapp_template_id, step_order`, `step_type = 'whatsapp'`), `loadTemplatesForApproval`, refuse with 400 `"Step N uses the WhatsApp template "<name>", which is <STATUS> at Meta. Activate it once the template is approved."` (first issue), 503 on read failure.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.1a — publish and activation refuse an unapproved WhatsApp template`.

### Task 2: A pending template waits (60 min retries) and never sends more than 48 h late

**Files:**
- Create: `src/lib/sequences/template-wait.js`, `src/lib/sequences/template-wait.test.js`, `src/lib/sequences/template-wait-scheduler.test.js` (harness copied from `frequency-cap-scheduler.test.js`)
- Modify: `src/lib/sequences/steps.js` (`resolveApprovedWhatsappTemplate`), `src/lib/sequences/scheduler.js` (catch block + advance update)

**Interfaces:**
- Produces (template-wait.js):
  - `TEMPLATE_WAIT_RETRY_MS`, `TEMPLATE_WAIT_MAX_MS`, `TEMPLATE_WAIT_STATUSES = ['PENDING','IN_APPEAL','PAUSED']`
  - `class TemplateNotApprovedDeferral extends Error` with `templateId`, `templateName`, `status`
  - `templateStamp(templateId) => '[wa_tpl:<id>] '`
  - `templateWaitDecision({ metadata, stepOrder, templateId, now: Date }) => { action: 'defer', nextAt: string, metadata: object } | { action: 'exit' }` — keeps `metadata.template_wait = { template_id, step_order, since }`; starts a fresh `since` when absent or when `template_id`/`step_order` differ; exits when `now - since >= TEMPLATE_WAIT_MAX_MS`; preserves every other metadata key.
  - `withoutTemplateWait(metadata) => object|null` — the metadata minus `template_wait` (null if nothing changes, so callers can skip the write).
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write failing tests**
  - `template-wait.test.js`: `startsWaitOnFirstDeferral` (no metadata → defer, `nextAt = now + 60 min`, `metadata.template_wait.since = now`); `keepsSinceOnLaterDeferral`; `exitsAt48Hours` (since = now − 48 h → `exit`); `waitRecordResetsWhenTemplateChanges` (stored template A, deferral for B at same step → fresh `since`); `preservesOtherMetadataKeys` (`{ test: true }` survives); `stampFormat` (`templateStamp('abc') === '[wa_tpl:abc] '`).
  - `steps.test.js` (or a focused new describe there): `pendingTemplateThrowsDeferral` (status PENDING → `TemplateNotApprovedDeferral` with `status 'PENDING'`); `pausedByMetaThrowsDeferral`; `rejectedTemplateThrowsStampedError` (REJECTED → plain `Error`, message starts with `templateStamp(id)`).
  - `template-wait-scheduler.test.js`: `deferralDoesNotCountAnError` (sendWhatsappStep rejects with a deferral → enrolment update sets `next_step_at` ≈ now+60 min and `metadata.template_wait`, does NOT set `error_count`/`status`; `stats.deferred === 1`); `pausedByMetaDefersThenExits` (metadata since = now − 49 h → update sets `status 'exited'`, `exit_reason 'stale_template_wait'`, `next_step_at null`, `exited_at`); `advanceClearsWaitRecord` (enrolment with `metadata.template_wait` that now sends → advance update includes metadata without `template_wait`).
- [ ] **Step 2: Run** `npx vitest run src/lib/sequences/template-wait.test.js src/lib/sequences/template-wait-scheduler.test.js src/lib/sequences/steps.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** In `resolveApprovedWhatsappTemplate`: missing row → `Error(templateStamp(id) + 'WhatsApp template not found.')`; status in `TEMPLATE_WAIT_STATUSES` → throw the deferral; other non-APPROVED → stamped `Error` (existing wording after the stamp); location mismatch unchanged but stamped. In the scheduler catch, a branch beside `FrequencyCapDeferral`: compute `templateWaitDecision` from `enrollment.metadata`; defer → update `{ next_step_at, metadata, last_processed_at, last_error: templateStamp(id) + 'waiting for Meta to approve "<name>" (<status>)' }` with `.eq('status','active')`, `stats.deferred++`; exit → update `{ status:'exited', exit_reason:'stale_template_wait', exited_at, next_step_at:null, last_processed_at }`, `stats.exited_stale = (stats.exited_stale||0)+1`, `logWarn('sequences','template wait over 48h; enrolment exited, nothing sent', {...ids})`. Both writes check `error` and `logError` on failure (the claim lease brings it back; nothing sent). In the advance update add `metadata: withoutTemplateWait(enrollment.metadata)` only when it returns non-null.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/lib/sequences` — expect PASS (existing scheduler suites unchanged).
- [ ] **Step 5: Commit** `PIPEBUILD.1b — a pending WhatsApp template defers the step; over 48 h it exits instead of sending late`.

### Task 3: Meta approval wakes waiting and paused enrolments at that studio

**Files:**
- Modify: `src/lib/sequences/template-wait.js` (add the IO hook), `src/lib/whatsapp-template-events.js`, `src/app/api/whatsapp/templates/route.js` (sync branch, where rows are written from `planTemplateSync`)
- Test: `src/lib/sequences/template-wait.test.js`, `src/lib/whatsapp-template-events.test.js`

**Interfaces:**
- Produces: `onTemplateApproved(db, { id, location_id }, now = new Date()) => Promise<{ woken: number, resumed: number, leftPaused: number }>` — never throws (logs and returns zeros on failure).
  1. Sequence ids at the template's studio: `email_sequences` `id` where `location_id = template.location_id` (paginate with `.range` + `.order('id')`).
  2. Waiting: `sequence_enrollments` `status='active'`, `metadata->template_wait->>template_id = id`, `sequence_id in (…)` → update `next_step_at = now` with `.eq('status','active')`.
  3. Paused: `status='paused'`, `last_error` LIKE `escapeLikePattern(templateStamp(id)) + '%'`, `sequence_id in (…)`; those with `last_processed_at >= now − TEMPLATE_WAIT_MAX_MS` get `buildResumePatch(now)` via CAS `.eq('status','paused')`; older ones are counted in `leftPaused` and left alone.
- Consumes: `templateStamp`, `TEMPLATE_WAIT_MAX_MS` (Task 2); `buildResumePatch` (`src/lib/sequences/resume.js`); `escapeLikePattern` (`src/lib/like-escape.js`).

- [ ] **Step 1: Write failing tests**
  - `template-wait.test.js`: `wakesWaitingEnrolments`; `resumesRecentPausedOnly` (paused 2 h ago → resumed; paused 3 days ago → `leftPaused 1`, no update); `resumesOnlyAtTemplateStudio` (enrolment query is constrained to the template studio's sequence ids); `neverThrowsOnReadError` (→ zeros + `logError`).
  - `whatsapp-template-events.test.js`: `approvedTransitionCallsHook` (status PENDING → APPROVED calls `onTemplateApproved` once with the template row); `nonApprovedTransitionSkipsHook`; `updateErrorSkipsHookAndAudit` (the row update returns `{ error }` → returns `{ skipped: 'update_failed' }`, no audit insert, no hook).
- [ ] **Step 2: Run** `npx vitest run src/lib/sequences/template-wait.test.js src/lib/whatsapp-template-events.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** In `applyTemplateEvent`: destructure `error` from the row update (return `{ skipped: 'update_failed' }` + `logError` on failure); check the audit insert's error (log only); when `update.status === 'APPROVED'` call `await onTemplateApproved(db, template)` (it cannot throw). In the templates sync branch, after a row's status write succeeds and the new status is `APPROVED` while the stored one was not, call the same hook.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/app/api/webhooks/whatsapp src/app/api/whatsapp/templates` — expect PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.1c — Meta approval wakes waiting enrolments and resumes recently paused ones at that studio`.

### Task 4: Branch predicate "has a future booking at this studio"

**Files:**
- Modify: `src/lib/sequences/graph/schema.js` (`BRANCH_PREDICATE_TYPES`), `src/lib/sequences/steps.js` (`evaluateBranchPredicate`, `hasBookedClassAtStudio` gains `futureFromIso`), `src/lib/sequences/graph/view.js`, `src/components/sequences/nodeEditing.jsx` (picker option + label), `src/lib/sequences/agent/prompt.js`
- Test: `src/lib/sequences/steps.test.js`, `src/lib/sequences/graph/validate.test.js`, `src/lib/sequences/graph/view.test.js`

**Interfaces:**
- Produces: predicate `{ type: 'has_future_booking_at_studio' }` (no config). True when a non-cancelled `class_bookings` row at the sequence studio has `starts_at > now`, or a `class_booking_requests` row there is in `IN_FLIGHT_CLASS_REQUEST_STATUSES`. Throws when the sequence has no studio (same rule as `booked_class_at_studio`).
- Label (view + picker): `Has a class booked from now on at this studio`.

- [ ] **Step 1: Write failing tests:** `futureBookingTrue` (booking query carries `.gt('starts_at', nowIso)` and returns a row → true); `pastBookingOnlyFalse` (bookings query empty, requests empty → false); `inFlightRequestCounts`; `futureBookingNeedsStudio` (no location → throws); `validateAcceptsFutureBookingPredicate`; `viewLabelsFutureBooking`.
- [ ] **Step 2: Run** `npx vitest run src/lib/sequences/steps.test.js src/lib/sequences/graph/validate.test.js src/lib/sequences/graph/view.test.js tests/class-bookings-readers-guard.test.js` — expect FAIL on the new tests.
- [ ] **Step 3: Implement** by extending `hasBookedClassAtStudio(db, { contactId, locationId, sinceIso, futureFromIso })` (no new reader site, so the readers guard stays satisfied); add the agent-prompt sentence: `{ type:"has_future_booking_at_studio" } (true when the contact has a class booked from now on at this studio, or a booking request in flight; use it to tell "already booked their next class" apart from "attended and stopped")`.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.1d — branch predicate: has a future booking at this studio`.

### Task 5: Stage coverage read + the editor's stage picker uses real stages

**Files:**
- Create: `src/lib/pipeline-stage-coverage.js` (+ `.test.js`), `src/app/api/locations/[id]/stage-coverage/route.js` (+ `route.test.js`)
- Modify: `src/components/sequences/SequenceSettings.jsx`, `src/lib/sequences/graph/view.js` (read `to_status`), `src/lib/openapi.js`
- Test: `src/components/sequences/SequenceSettings.test.jsx`, `src/lib/sequences/graph/view.test.js`

**Interfaces:**
- Produces: `loadStageCoverage(db, locationId) => Promise<{ ok: true, boards: Array<{ id, key, name, stages: Array<{ id, slug, name, isPile: boolean, followups: Array<{ id, name, trigger: string }> }> }> } | { ok: false, error }>`
  - Boards: `pipelines` `enabled = true` at the studio, ordered by `display_order`; stages: `pipeline_stages` of those boards, not `archived`, ordered by `display_order`; `isPile = is_dormant`.
  - Follow-ups: `email_sequences` `status='active'` at the studio with `trigger_type='pipeline_stage_change'` and `trigger_config->>to_status = slug`, plus the entry triggers in `ENTRY_TRIGGERS_BY_STAGE = { new_lead: ['contact_created'], paid_trial_new_lead: ['paid_trial_checkout_purchased', 'un1t_paid_trial_purchased'] }` (a PR 1 stop-gap until stage roles land in PR 2; comment says so).
- Produces: `GET /api/locations/[id]/stage-coverage` → `{ success: true, data: { boards } }`. Gate: `getCurrentUser` → `assertLocationAccessOr404` → allowed if `canBuildSequencesAt(user, id)` or `hasRoleAtLocation(user, id, MANAGER_ROLES)`, else 403. Read failure → 503.
- SequenceSettings: the From/To stage selects are built from the response (`[['', 'Any stage'], ...boards.flatMap(b => b.stages.map(s => [s.slug, `${b.name} · ${s.name}`]))]`); a stored slug not in the list stays selectable as `"<slug> (not on an active board)"`; while loading or on fetch failure the select shows only `Any stage` plus the stored value. When `trigger_type === 'pipeline_stage_change'` and `to_status` is empty, show the hint `This fires on every stage change. Pick a "To stage" for a stage follow-up.` The goal-stage picker keeps `PIPELINE_SLUGS` (out of scope).

- [ ] **Step 1: Write failing tests:** coverage lib `groupsFollowupsByStage`, `countsEntryTriggerForNewLead`, `skipsDisabledBoardsAndArchivedStages`, `returnsNotOkOnReadError`; route `404ForOtherStudio`, `403WithoutPermission`, `200ForManager`, `503OnReadError`; `SequenceSettings.test.jsx` `stagePickerListsFetchedStages`, `keepsUnknownStoredSlugSelectable`, `warnsWhenToStageEmpty`; `view.test.js` `labelsStageChangeWithToStatus` (`{ to_status: 'paid_trial_first_class' }` → label contains `paid_trial_first_class`).
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-stage-coverage.test.js 'src/app/api/locations/[id]/stage-coverage/route.test.js' src/components/sequences/SequenceSettings.test.jsx src/lib/sequences/graph/view.test.js` — expect FAIL.
- [ ] **Step 3: Implement** (pagination: `.range(0, 999)` + explicit `.order`; every read destructures `error`). Register the route in `openapi.js`.
- [ ] **Step 4: Run** the same command, then `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns` — expect PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.1e — stage coverage read; the sequence stage picker lists the studio's real stages`.

### Task 6: Coverage strip on the pipeline page, CI mirror, PR

**Files:**
- Create: `src/components/StageFollowupCoverage.jsx` (+ `.test.jsx`), `docs/changelog/entries/<PR>.md` (after `gh pr create`)
- Modify: `src/app/(sales)/pipeline/page.js` (render the strip above the board for the active derived board, only when the user can build sequences or is a manager at the studio)

**Interfaces:**
- Consumes: `GET /api/locations/[id]/stage-coverage` (Task 5).
- Produces: `<StageFollowupCoverage locationId pipelineId canEditSequences />` — one row of chips for the active board's non-pile stages: covered → `bg-emerald-500/10 text-emerald-700` "<Stage>: <n> follow-up(s)" with the names in a tooltip; uncovered → `bg-red-500/10 text-red-700` "<Stage>: no follow-up"; header text `Follow-ups by stage`; when any stage is uncovered and `canEditSequences`, a link `Build one` → `/automations`. Renders nothing on fetch failure (logs once).

- [ ] **Step 1: Write failing tests:** `showsCoveredAndMissingChips`, `hidesPiles`, `rendersNothingOnFetchError`, `buildLinkOnlyForEditors`; extend `src/app/(sales)/pipeline/page.test.js` `rendersCoverageForManagers` / `hidesCoverageForStaff`.
- [ ] **Step 2: Run** `npx vitest run src/components/StageFollowupCoverage.test.jsx 'src/app/(sales)/pipeline/page.test.js'` — expect FAIL.
- [ ] **Step 3: Implement** with `@/components/ui` primitives and `un1t-*` tokens (chip recipe per CLAUDE.md).
- [ ] **Step 4: Run** the CI mirror (all 13 commands from CLAUDE.md) and `npm run build`. Expect all green. Do not rerun the full suite beside the build on this 8 GB Mac; run them one after another.
- [ ] **Step 5: Commit, push, open PR** (`gh pr create --base main`), add `docs/changelog/entries/<PR>.md`, push. Then verify on the Vercel preview (browser pane, Richard's session): the €39 board at Stillorgan shows every stage covered except any genuine gaps; publishing a test draft on a PENDING template is refused.
