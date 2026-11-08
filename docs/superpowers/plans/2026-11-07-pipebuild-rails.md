# PIPEBUILD rails: owner-only follow-up actions, confirms, truthful states, WhatsApp guidance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner using the pipeline builder unattended cannot do harm by accident and is never shown a state that is not true: installing or switching off a follow-up is owner work, Switch off confirms its consequence, "Live" says when Meta has paused or rejected the template, a held first placement says so, and a studio with no WhatsApp number is told what to do and blocked from the steps that need one.

**Architecture:** No migration. The follow-up route gates by action and row state; the UI gates the same buttons on `can_edit`. `getBoard`/`listBoards` derive a per-follow-up `health` from the linked template's and sequence's status, and a per-board `baseline_pending` from the studio's latest classification run, so every screen reads one source. The two server pages compute `hasWhatsapp` and pass it down.

**Tech Stack:** Next.js App Router, Supabase (service role), React, Vitest + Testing Library.

**Spec:** The PIPEBUILD audit of 7 Nov 2026 (items 4, 5, 6, 7, 10) and Richard's choices of the same evening (all four rails; WhatsApp: guide and block).

## Global Constraints

- **Owner tier = `guardMasterOrOwner(user, locationId) === null`** (owner, org admin, master at the board's studio). **Wording tier = `canBuildSequencesAt && canManageWaTemplatesAt`.** Owner tier may do everything the wording tier may.
- **The 403 for "no permission at all" must still come before `getBoard` is read** (the existing route test pins it); the owner-tier 403 comes after the row is known.
- **Service-role routes enforce access in code**; the lib (`applyFollowupAction`) stays role-free; the route decides.
- **`health` and `baseline_pending` are derived at read time, never stored**; the approval hook's behaviour (`live` rows untouched on REJECTED; PAUSED a no-op) does not change.
- **Copy is truthful to what the code does.** Switch off: the sequence is paused and retired now, people part-way through get nothing more, switching on again resubmits to WhatsApp for approval. Baseline: nightly at Glofox/contacts studios (03:30 UTC), within the hour at un1t.online studios.
- UI conventions: `@/components/ui` primitives (`Modal`, `Button`), light `un1t-*` tokens, chips `bg-<c>-500/10 text-<c>-700`, typed buttons.
- Exact-shape tests that break on an added field are updated to include the field, never loosened to `toMatchObject` where they pinned a leak.

## Review Focus

1. **A manager with the two permissions on a stage with a `rejected` row**: Save wording posts `install` with bodies — that is a fresh install at `version + 1`, owner work; the manager must see the owner-only notice, not a 403 after typing.
2. **A `live` row whose template is PAUSED by Meta then REINSTATED**: health goes back to null without any write (the webhook stores REINSTATED as APPROVED).
3. **A board enabled, baseline null, and NO run since it was enabled**: the status says "tonight"/"within the hour", not "held".
4. **A studio where `locationsWithWhatsApp` throws**: `hasWhatsapp` is null → today's behaviour (no block, no false "no number" notice).
5. **Switch off confirmed while another tab already switched it off**: the 409 `followup_changed` text is shown and the modal closes.

---

### Task 1: Owner-only install and switch off

**Files:**
- Modify: `src/app/api/pipelines/[id]/followups/[stageId]/route.js:46-70`, `src/components/pipelines/BoardSettings.jsx:433-536` (and the `saveWording` path `:342-346`)
- Test: `src/app/api/pipelines/[id]/followups/[stageId]/route.test.js`, `src/components/pipelines/BoardSettings.test.jsx`

**Interfaces:**
- Route: after `getBoard` (`:59-61`), `row = board.followups.find((f) => f.stage_id === stageId && f.pack_key === packKey) ?? null`; `ownerWork = action === 'off' || (action === 'install' && (!row || SPENT_STATES.has(row.state)))` where `SPENT_STATES = new Set(['rejected','off'])` (import or duplicate the constant from `pipeline-board-followups.js`, exporting it from there is preferred). If `ownerWork && !isOwner` → 403 `{ success: false, error: 'Only an owner can install or switch off a follow-up. You can change the wording of one that is already set up.', code: 'owner_only' }`. The no-permission 403 (`!isOwner && !canWord`) stays before `getBoard`.
- UI (`BoardSettings.jsx`): `const ownerOnlyInstall = !row || ['rejected','off'].includes(rowState)`; Install renders only when `canEditWording && canInstall && (canEdit || !ownerOnlyInstall)`; Switch off renders only when `canEdit`; "Publish now" (install with no bodies on `awaiting_approval`) stays wording-tier. In `saveWording`, when the row is absent or rejected/off and `!canEdit`, the Save button is disabled with the note `Only an owner can install this follow-up. Ask an owner, or change the wording once it is set up.` (a `<p>` under the editor; no request is sent).

- [ ] **Step 1: Failing tests** — route: manager with both permissions: `replace` on a live row → 200 (existing), `install` with bodies on a `draft` row → 200, `install` on a stage with no row → 403 `owner_only`, `install` on a `rejected` row → 403 `owner_only`, `off` on a live row → 403 `owner_only`; owner: all four → 200; staff with no permissions → 403 before `getBoard` (existing). BoardSettings (`managerSeesOnlyWordingActions`): a manager sees Change wording on the live row, NO Switch off, NO Install on the two rowless stages, and the owner-only note when opening the editor on a rowless stage; the owner fixture keeps today's buttons.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/pipelines/[id]/followups' src/components/pipelines/BoardSettings.test.jsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run check:route-guards`.
- [ ] **Step 5: Commit** `RAILS.1 — installing or switching off a follow-up is owner work`.

### Task 2: Switch off confirms its consequence

**Files:**
- Modify: `src/components/pipelines/BoardSettings.jsx` (`:514-519` button; a `confirmOffRow` state `{ stage, pack }` and a `Modal` modelled on the replace confirm `:559-571`; copy constant `FOLLOWUP_OFF_CONFIRM` beside `REPLACE_CONFIRM` `:21`)
- Test: `src/components/pipelines/BoardSettings.test.jsx:164-171` and a new case

**Interfaces:**
- `export const FOLLOWUP_OFF_CONFIRM = 'This stops the follow-up for everyone now, including people part-way through it, and retires its sequence. Switching it on again sends the message to WhatsApp for approval again, which can take hours.'`
- Clicking Switch off opens the modal (title "Switch off this follow-up"); Confirm posts `off` exactly as today, Cancel posts nothing; a 409 from the route closes the modal and shows its `error` in the row's note.

- [ ] **Step 1: Failing tests** — clicking Switch off posts nothing until Confirm; Confirm posts one PUT `{ action: 'off', pack_key }`; Cancel posts nothing; the modal body contains `FOLLOWUP_OFF_CONFIRM`; a 409 shows its text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run check:guardrails`.
- [ ] **Step 5: Commit** `RAILS.2 — Switch off asks first and says what it does`.

### Task 3: A truthful follow-up state

**Files:**
- Modify: `src/lib/pipeline-boards.js` (`FOLLOWUP_COLUMNS` unchanged; `shapeBoard` `:176-187` adds `health: null`; `withFollowupWording` `:283-353` selects `status` on both template reads; a new `withFollowupHealth(db, locationId, board)` used by BOTH `getBoard` and `listBoards`: one `whatsapp_templates` read by the linked ids (`id, status`) and one `email_sequences` read by `sequence_id` (`id, status`), chunked ≤200, failures → `health_unread: true` on the board and `health: null` on every row), `src/components/pipelines/BoardList.jsx:10-27` (`followupChip` reads `health`), `src/components/pipelines/BoardSettings.jsx` (row state label), `src/components/pipelines/BoardLaunchPanel.jsx` (state label only; `LIVE_STATES` gating unchanged)
- Test: `src/lib/pipeline-boards.test.js:216` (exact shape gains `health: null`), `:227-298` (template mocks gain `status: 'APPROVED'`), new health cases; `BoardList.test.jsx:30-42`

**Interfaces:**
- Per follow-up `health`: `'template_rejected'` when the linked first template's status is `REJECTED` or `DISABLED`; `'template_paused'` when `PAUSED`; `'sequence_paused'` when `state === 'live'` and the sequence's status is `paused`; else `null`. Precedence in that order. Only rows in `live` or `awaiting_approval` carry a non-null health (an `off`/`rejected`/`draft` row is already truthful).
- `CHIPS` by `(state, health)`: `live` + `template_paused` → "Paused by WhatsApp" amber; `live` + `template_rejected` → "Rejected by WhatsApp" red; `live` + `sequence_paused` → "Paused" amber; `awaiting_approval` + `template_rejected` → "Rejected by WhatsApp" red; otherwise today's labels. `PRECEDENCE` picks the worst of a stage's rows: rejected health first, then paused, then the existing order.

- [ ] **Step 1: Failing tests** — lib: a live row whose template is PAUSED → `health: 'template_paused'`; DISABLED → `template_rejected`; sequence paused → `sequence_paused`; APPROVED + active → `null`; a failed template read → `health: null` on rows and `health_unread: true` on the board, the rest of the board intact; `listBoards` carries the same field. BoardList: the three labels and their classes; an `off` row with a paused template still reads "Off".
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-boards.test.js src/components/pipelines/` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run check:select-columns && npm run check:guardrails`.
- [ ] **Step 5: Commit** `RAILS.3 — Live says when WhatsApp has paused or rejected the template`.

### Task 4: A held first placement says so

**Files:**
- Modify: `src/lib/pipeline-boards.js` (`listBoards`/`getBoard`: when any board is `enabled && board_type && !baseline_at`, read the studio's latest non-dry-run `pipeline_classification_runs` row (`status, errors, error_message, started_at, finished_at`, `.eq('location_id')`, `.eq('dry_run', false)`, `.order('started_at', { ascending: false })`, `.limit(1)`), and set on each such board `baseline_pending: { cadence: board.module === 'offer_un1t' ? 'hourly' : 'nightly', last_run: { status, errors, started_at, finished_at } | null, held: boolean }` where `held = last_run && last_run.started_at > board.updated_at && (last_run.status !== 'success' || last_run.errors > 0)`; a failed runs read → `baseline_pending: { cadence, last_run: null, held: false, unread: true }`), `src/components/pipelines/BoardList.jsx:29-36` (`boardStatus`), `src/components/pipelines/BoardSettings.jsx:34` (`BASELINE_NOTE`), `src/components/pipelines/BoardLaunchPanel.jsx:8,:132` (`TURN_ON_CONFIRM` by cadence; the dry-run note), `src/lib/pipeline-board-report.js` `buildHealth` (a `baseline_held` item: "First placement is held: N people could not be checked on the last run (<date>). Follow-ups won't start until a run completes cleanly.")
- Test: `src/lib/pipeline-boards.test.js`, `BoardList.test.jsx:34`, `BoardLaunchPanel.test.jsx`, `src/lib/pipeline-board-report.test.js:335`

**Interfaces:**
- `boardStatus(board)`: off → "Off"; built-in → "On"; baselined → "On"; pending, not held → nightly: "On — first placement tonight, no messages", hourly: "On — first placement within the hour, no messages"; pending and held → "On — first placement held: N people could not be checked (<date>)"; pending with `unread` → the not-held text.
- `TURN_ON_CONFIRM` takes the cadence word; the dry-run note with `errors > 0` reads "Some people could not be checked (N). The first placement is held until this is clear."

- [ ] **Step 1: Failing tests** — lib: an unbaselined board with a failed run after `updated_at` → `held: true` with the counts; a successful run → `held: false`; a run BEFORE `updated_at` (from before switch-on) → `held: false`; no run → `last_run: null`; a failed runs read → `unread: true`; a baselined board carries no `baseline_pending`. BoardList: the four texts. Report: `baseline_held` present only when held.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run check:select-columns`.
- [ ] **Step 5: Commit** `RAILS.4 — a held first placement says so, on the studio's own clock`.

### Task 5: WhatsApp — guide and block

**Files:**
- Modify: `src/app/settings/pipelines/new/page.js` and `src/app/settings/pipelines/[id]/page.js` (compute `hasWhatsapp` with `locationsWithWhatsApp(db, [locationId])` in try/catch → `true | false | null`, pass as a prop), `src/components/pipelines/BoardWizard.jsx` (`:114-136` finish: when `hasWhatsapp === false`, create the board, skip the installs, and show `NO_WHATSAPP_NOTICE` with a link to `/settings/integrations-hub?manage=whatsapp-numbers`; retry disabled), `src/components/pipelines/BoardSettings.jsx` (when `hasWhatsapp === false`: no Install / Change wording / Publish now buttons; the notice above the Follow-ups section), `src/components/pipelines/BoardLaunchPanel.jsx:113` (the note names WhatsApp when `hasWhatsapp === false`), `src/components/pipelines/BoardList.jsx:89` (reuse the same constant)
- Test: the four component tests; the two pages have none (say so)

**Interfaces:**
- `export const NO_WHATSAPP_NOTICE = 'This studio has no WhatsApp number switched on. The board can be built and saved, but its follow-ups cannot be submitted until a number is on.'` with the link text "Switch one on in Integrations".
- `hasWhatsapp` prop: `true` (today's behaviour), `false` (guide and block), `null`/undefined (unknown: today's behaviour).

- [ ] **Step 1: Failing tests** — wizard with `hasWhatsapp={false}`: finish creates the board (one POST), posts no installs, shows the notice and link; `true`/absent: today's flow. BoardSettings with `false`: no install/wording/publish buttons, the notice shown; absent: unchanged. Launch panel with `false`: the note names WhatsApp.
- [ ] **Step 2: Run** `npx vitest run src/components/pipelines/` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run check:guardrails`.
- [ ] **Step 5: Commit** `RAILS.5 — no WhatsApp number: the builder says so and waits`.

## Verification (controller)

The 13-command CI mirror and `npm run build`; a fresh whole-branch review; in the browser after merge, Test Studio's board settings as an owner (Switch off confirm, states) and the Pipelines list.
