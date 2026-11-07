# PIPEBUILD PR 6: Mia knows the board, board reports, recipe onboarding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mia knows which offer board a person is on (stage, day N of M, the way in, the builder's notes) and never doubles a board's own follow-up; each offer board gets a report (funnel, conversion, revenue, follow-up results, health warnings); a studio with no offer boards is walked into one from a recipe.

**Architecture:** A never-throwing `describeContactBoard()` read feeds a new volatile block of Mia's system prompt (beside `trialDoneLine`). The first-class check-in skips people whose offer-board stage already has a live follow-up. A pure-ish `buildBoardReport()` assembles report blocks (each block null on its own failure) behind `GET /api/pipelines/[id]/report`, shown as a card on the board's settings page. Onboarding is a recipe picker on the Pipelines list that opens the wizard pre-set (`/settings/pipelines/new?recipe=<key>`). No migration.

**Tech Stack:** Next.js App Router, Supabase service role, Vitest, React (client components).

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` § "PR 6: Mia, reports, onboarding". Research notes the controller gathered are summarised in each task's Interfaces.

## Global Constraints

- **Rulings that narrow the spec (recorded, Richard to confirm):**
  1. *End-of-offer conversation:* no second runner in this PR. The board's own "Trial Done" follow-up is the opener; Mia's board block tells her the person is at the end of the offer and carries the builder's notes, so her replies steer to the next step. The Hatch trial-done runner is untouched. A runner per board needs a migration (`trial_done_outreach` is unique per studio+contact) and is a later PR.
  2. *First-class check-in:* no new role-based check-in path (it would double the board's own "After the first class" follow-up). Instead the existing check-in skips a person whose open deal sits on an enabled offer board's `first_class`-role stage with a live follow-up.
  3. *Onboarding:* no seeded half-built boards (a board config needs entry values the seed cannot know, and `createBoard` would duplicate keys on a re-run). A studio with no offer boards sees recipe cards that open the wizard pre-set; the cards say when the studio has no WhatsApp number yet.
  4. *Revenue:* the offer price paid (`trial_purchases.amount_cents` for `trial_purchase` boards; `un1t_transactions.amount_cents`, non-refunded, for `un1t_product` boards when that module exists on the branch, else omitted). "Purchases after" is left out at Glofox studios: `glofox_invoices` is stale (CLAUDE.md) and there is no clean source. Revenue is shown only to people holding `dashboard_business` at the studio; others get `revenue: null`.
- **Mia stays on the Anthropic Messages API**; the board block lives in the VOLATILE part of the prompt (never the cached stable prefix), exactly like `trialDoneLine`.
- **Service-role routes enforce access in code:** the report route copies `GET /api/pipelines/[id]`'s gate (manager role at the studio or `canBuildSequencesAt`), 404 for another studio's board via `boardLocationId` + `assertLocationAccessOr404`, registered in `src/lib/openapi.js`.
- **1,000-row cap:** every fan-out read `.range()`-paginates with an explicit `.order()` (use `selectAll` from `@/lib/select-all`).
- `.ilike` only through `escapeLikePattern`; destructure `error` on every read; no new `console.log`; named columns on `contacts`/`profiles`/`locations`.
- Customer-facing copy in this PR is Mia's context only (never sent verbatim); the recipe cards and report labels are staff UI.

## Review Focus

1. **A contact with open deals on two offer boards** (or a closed old deal and an open new one): Mia's block describes the open deal(s) only, newest first, at most two.
2. **A board whose stage was renamed:** the report's 7/30-day history matches activity rows by stage name, so it says so on the card ("history before a rename is not counted") rather than showing wrong numbers silently.
3. **The report on a board with hundreds of deals** pages every read (no 1,000 cap truncation) and a failed block comes back null without failing the others.
4. **A manager without `dashboard_business`** gets the report with `revenue: null`, never an error.
5. **`describeContactBoard` on any failed read** returns null and logs once; Mia's turn proceeds without the block.

---

### Task 1: Mia knows the person's offer board

**Files:**
- Create: `src/lib/agent/board-context.js`, `src/lib/agent/board-context.test.js`
- Modify: `src/lib/agent/auto-reply.js` (~L903-964: beside the `trialDoneLineFor` call, add to `systemOpts`), `src/lib/agent/prompt.js` (`buildCustomerSystemPromptParts` ~L587: a volatile block after the `trialDoneLine` block ~L695-698; JSDoc ~L582)
- Test: `src/lib/agent/prompt.test.js` (or the existing prompt test file)

**Interfaces:**
- Produces: `export async function describeContactBoard(db, { locationId, contactId, nowMs, zone }) -> string | null`. Reads open `deals` (`status = 'open'`, `location_id`, `contact_id`) joined to their `pipelines` (enabled, `board_type = 'offer'`) and `pipeline_stages` (`name`, `stage_role`, `role_config`); newest two by `created_at`. Per deal one line block:
  - `Board: <config.offer_name || pipelines.name>. Stage: <stage name>.`
  - `Day <N> of <config.duration_days>` where day 1 is the deal's `created_at` date on the studio's calendar (`zone`, via `@/lib/location-time` helpers; N capped at duration + 1 shown as "offer finished"), omitted when duration is missing.
  - `They came in through: <label>` from `config.entry.type` (`trial_purchase` → "the trial checkout", `corp_promo` → "a corporate promo", `lead_source` → "a lead form", `glofox_plan` → "a Glofox plan", `tag` → "a staff tag", `un1t_product` → "a un1t.online product").
  - For a `done`-role stage: `They have reached the end of the offer; help them choose the next step.`
  - `Notes from the studio for this board:` + `config.mia_notes` verbatim when non-empty.
  Returns null when there is no such deal or on any read error (`logWarn('board-context', …)` with ids only).
- `buildCustomerSystemPromptParts` takes `boardContextLine` and renders, in `volatile` only, `## This person's offer board\n<boardContextLine>` when non-null.

- [ ] **Step 1: Failing tests** — `board-context.test.js`: one open deal on an enabled offer board on day 3 of 14 → contains `Board: 69 trial`, `Stage: 1st Class`, `Day 3 of 14`, `the trial checkout`, and the notes; a `done`-role stage adds the end-of-offer line; a deal on a built-in board (`board_type: null`) → null; a closed deal → null; a deals read error → null and no throw. Prompt test: `boardContextLine: 'X'` appears in `volatile` and not in `stable`; null → no heading.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/board-context.test.js src/lib/agent/prompt.test.js` → FAIL.
- [ ] **Step 3: Implement**, and wire `auto-reply.js` (`conv?.contact_id || contactId`, same zone/now as `trialDoneLineFor`, inside the same never-throw pattern).
- [ ] **Step 4: Run** the two files plus `npx vitest run src/lib/agent/auto-reply` → PASS; `npm run check:select-columns`.
- [ ] **Step 5: Commit** `PIPEBUILD.6-1 — Mia knows the person's offer board`.

### Task 2: The first-class check-in never doubles a board follow-up

**Files:**
- Modify: `src/lib/agent/followups.js` (`runFirstClassCheckins` ~L928 candidate step; a new exported helper)
- Test: `src/lib/agent/followups.test.js`

**Interfaces:**
- Produces: `export async function contactsCoveredByBoardFollowup(db, { locationId, contactIds, role: 'first_class' }) -> { ok: true, ids: Set<string> } | { ok: false }` — open deals of those contacts on enabled `board_type = 'offer'` boards at the studio whose stage has `stage_role = role` and a `pipeline_stage_followups` row in state `live` for that stage. Paginated, chunked `.in()` (≤ 200 ids per call).
- `runFirstClassCheckins` drops covered contacts before classifying, recording them as skipped with reason `board_followup`; `ok: false` → skip the whole studio's check-ins this tick (log once) rather than risk a double message.

- [ ] **Step 1: Failing tests** — a candidate whose deal is on an offer board's first_class stage with a live follow-up is skipped with `board_followup`; the same with the follow-up `off` is not skipped; a built-in board deal is not skipped; the helper's read error → no check-ins sent that tick for the studio.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/followups.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.6-2 — the first-class check-in skips people a board already follows up`.

### Task 3: The board report

**Files:**
- Create: `src/lib/pipeline-board-report.js`, `src/lib/pipeline-board-report.test.js`, `src/app/api/pipelines/[id]/report/route.js`, `src/app/api/pipelines/[id]/report/route.test.js`
- Modify: `src/lib/openapi.js` (beside the pipelines entries ~L7166-7249)

**Interfaces:**
- Consumes: `getBoard(db, …)` / `boardLocationId` from `src/lib/pipeline-boards.js`; `loadStageCoverage(db, locationId)` from `src/lib/pipeline-stage-coverage.js` (returns `{ ok, boards: [{ id, stages: [{ id, followups, followupStates }] }] }`).
- Produces: `export async function buildBoardReport(db, { board, locationId, nowMs, includeRevenue }) -> { funnel, conversion, revenue, followups, health }` where each block is its own object or `null` when its reads failed (log once per block):
  - `funnel`: `{ stages: [{ id, name, role, now, movedIn7, movedIn30 }], entered7, entered30, historyNote: 'History before a stage rename is not counted.' }` — `now` = open deals per stage; `entered*` = board deals with `created_at` in the window; `movedIn*` = `activities` rows `type = 'pipeline'` for the board's deal ids in the window whose `subject` is exactly `Pipeline: moved to <stage name>`, plus deals created in the window whose first stage is that stage counted on the board's first stage only.
  - `conversion`: `{ entered30, converted30, rate }` — converted = deals created in the last 30 days now on the `converted`-role stage or `status = 'won'`; `rate` null when `entered30` is 0.
  - `revenue` (only when `includeRevenue`): `{ currency: 'EUR', offerCents, purchases }` — `trial_purchase` boards: sum of `trial_purchases.amount_cents` at the studio for the board's contacts whose row matches the board entry (reuse `purchaseMatchesEntry` from `src/lib/pipeline-offer-claims.js` if exported, else export it) and counts as a claim (`status = 'granted'` or `payment_status = 'paid'`); other entry types → `{ currency: 'EUR', offerCents: null, purchases: 0 }`.
  - `followups`: per `pipeline_stage_followups` row `{ stageId, packKey, state, sent, delivered, read, replied, bookedAfter }` — `whatsapp_messages` outbound at the studio whose `template_name` is one of that follow-up's template names (the linked `whatsapp_templates.name` for `whatsapp_template_id`, plus the pack's other templates found by the same name rule `pipeline-boards.js` uses — find `templateNameFor` / `withFollowupWording`) and whose `contact_id` is a board contact; delivered/read by `delivered_at`/`read_at` non-null; `replied` = an inbound message on the same conversation after `sent_at` within 72 h; `bookedAfter` = a `class_bookings` row for that contact created after `sent_at` within 7 days (check the real column names in the migrations before writing; `check:select-columns` must pass).
  - `health`: list of `{ code, message, stageId? }` — `no_followup` (a non-pile stage with no live follow-up and no coverage sequence), `template_rejected` / `template_paused` (linked template status), `sequence_paused` (`email_sequences.status = 'paused'`), `nobody_entered_7d` (board enabled and baselined, `entered7 === 0`).
- Route `GET /api/pipelines/[id]/report`: copy the gate of `src/app/api/pipelines/[id]/route.js` GET (session, manager role at the board's studio or `canBuildSequencesAt`, `uuidLike` id, 404 for missing/other studio); `includeRevenue = hasPermissionForLocation(user, locationId, 'dashboard_business')`; built-in boards (`board_type` null) → 404 `Report is for offer boards`; `{ success: true, data: report }`.

- [ ] **Step 1: Failing tests** — lib: funnel counts on a fixture with two stages and five deals; `movedIn7` counts only exact-subject rows in the window; `rate` null at zero entries; a failed `activities` read makes `funnel` null but the other blocks present; revenue sums only matching claim rows; `includeRevenue: false` → `revenue: null`; follow-up `sent/delivered/read/replied/bookedAfter` on a fixture; health returns `no_followup`, `template_rejected`, `sequence_paused`, `nobody_entered_7d`; reads over 1,000 rows are paged (fake db serving 1,500 deals). Route: 401 signed out, 404 other studio, 404 built-in board, revenue null without `dashboard_business`, 200 shape.
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-board-report.test.js 'src/app/api/pipelines/[id]/report'` → FAIL.
- [ ] **Step 3: Implement**; register in `openapi.js`.
- [ ] **Step 4: Run** → PASS; `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`.
- [ ] **Step 5: Commit** `PIPEBUILD.6-3 — board report: funnel, conversion, revenue, follow-ups, health`.

### Task 4: The report on the board's settings page

**Files:**
- Create: `src/components/pipelines/BoardReport.jsx`, `src/components/pipelines/BoardReport.test.jsx`
- Modify: `src/components/pipelines/BoardSettings.jsx` (render `<BoardReport boardId={…} />` right after the Status section, ~L385, for offer boards)

**Interfaces:**
- Consumes: Task 3's route and report shape.
- Produces: a client card titled "Report": funnel table (stage, now, moved in 7 days, moved in 30 days) with the history note under it; "Entered in 30 days / Converted / Conversion rate"; revenue line ("Offer revenue €X from N purchases") only when `revenue` is non-null; a follow-ups table (stage, sent, delivered, read, replied, booked after); health warnings as amber chips (`bg-amber-500/10 text-amber-700`). A null block shows "Couldn't load this part." in its place. Loading → "Loading…"; route error → its message in `text-red-700`.

- [ ] **Step 1: Failing tests** (jsdom, stubbed fetch): renders the funnel row values and the history note; hides revenue when null; shows "Couldn't load this part." for a null `followups`; renders a `nobody_entered_7d` warning chip.
- [ ] **Step 2: Run** `npx vitest run src/components/pipelines/BoardReport.test.jsx src/components/pipelines/BoardSettings.test.jsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run check:guardrails` (chip contrast rule).
- [ ] **Step 5: Commit** `PIPEBUILD.6-4 — the report card on board settings`.

### Task 5: Start from a recipe

**Files:**
- Modify: `src/components/pipelines/BoardList.jsx` (recipe cards when the studio has no offer boards and `can_edit`), `src/app/settings/pipelines/new/page.js` (read `?recipe=`), `src/components/pipelines/BoardWizard.jsx` (accept an initial recipe key → dispatch `pickRecipe` once), `src/app/api/locations/[id]/pipelines/route.js` GET (add `has_whatsapp: boolean | null` using `locationsWithWhatsApp` from `src/lib/whatsapp-config.js`, null on its throw)
- Test: `src/components/pipelines/BoardList.test.jsx`, `src/components/pipelines/BoardWizard.test.jsx`, `src/app/api/locations/[id]/pipelines/route.test.js`

**Interfaces:**
- Consumes: `RECIPES` from `shared/pipelines/recipes.js` (each has `key` and a display name/description; use what exists).
- Produces: with zero offer boards and `can_edit`, BoardList shows "Start from a recipe" with one card per recipe (name, one-line description, a "Set up" link to `/settings/pipelines/new?recipe=<key>`); when `has_whatsapp === false` the cards carry "This studio has no WhatsApp number switched on yet. You can build the board now; its follow-ups can't be submitted until a number is on." The wizard opened with a valid `?recipe=` starts on that recipe (unknown key → ignored).

- [ ] **Step 1: Failing tests** — list: cards render for each recipe with the right hrefs when no offer boards; hidden when an offer board exists or without `can_edit`; WhatsApp notice when `has_whatsapp: false`; wizard: `initialRecipe="paid_trial_offer"` starts on it, an unknown key starts as before; route: `has_whatsapp` true/false/null.
- [ ] **Step 2: Run** `npx vitest run src/components/pipelines/ 'src/app/api/locations/[id]/pipelines'` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.6-5 — start a board from a recipe`.

## Verification (controller, after Task 5)

- The 13-command CI mirror and `npm run build`.
- In the browser on prod after merge: the "69 trial" board's report at Test Studio; Mia's block checked through a unit test only (no live customer conversation is started for it).
