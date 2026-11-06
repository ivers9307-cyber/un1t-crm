# Self-service pipelines with their follow-ups built in (PIPEBUILD)

## Context

On 6 Nov 2026 Darragh O'Donoghue (Stillorgan €39 Reset) got no message after his first class. Nothing was broken: nobody had built a sequence for the €39 board's "1st Class" stage at either studio. We hand-built two that day (a Meta template + a sequence per studio). This keeps happening because:

- **Boards are code.** Mig 594 records "no board-builder UI, boards are code" (Sept 2026). A new board = a module in `shared/pipelines/`, a router edit (`shared/pipelines/router.js` hard-codes `BOARD_KEYS`, `CLAIM_BOARD_MODULES` and precedence), claim loading in `src/lib/pipeline-claims.js`, two migrations, and ~14 hard-coded per-slug lists in the UI, agents and dashboards.
- **Sequences have no link to a board.** `email_sequences` only matches `trigger_config.to_status` (a slug) at a `location_id`. Nothing knows a board has a stage with no follow-up.
- **Silent gaps in the plumbing:** a card *created* straight into a stage fires no trigger; publishing does not check that the WhatsApp template is approved, and an unapproved template pauses every enrolment for good (manual resume only); the stage picker in the sequence editor is a hard-coded list.

Richard wants pipeline creation to be self-service, with everything that belongs to a board configured when it is built and editable later in the pipeline's settings.

## Decisions (Richard, 6 Nov 2026)

- **Who builds:** Richard for new offers, studio owners/managers, other gyms on the platform, and new-studio onboarding. **Create/change a board:** owners, org admins and masters at that studio. Managers can view the setup and edit follow-up wording.
- **Configured with the board, in one place, editable later:** entry rules, stages and move rules, follow-ups per stage, and Mia/card/report behaviour.
- **Freedom:** pick from a short list of tested **board types** with settings; no free-form rule builder.
- **Templates:** each stage comes with suggested wording; the builder edits it and presses submit; a follow-up switches itself on only when Meta approves its template.
- **Existing boards** (Stillorgan/Hatch acquisition, both €39 boards, Programmes) **stay as they are.** The new system is for new boards.
- **Ways in for v1:** our checkout (/trial, landing pages), a un1t.online product, a lead form / landing page, a Glofox plan, a staff tag, a corporate promo claim.
- **Must not happen:** messages going out wrong (early, twice, wrong studio, wrong board); too fiddly for an owner or another gym to do in one sitting; people on the wrong board or boards fighting over a person; any change to today's boards and follow-ups.

- **Stages:** the builder picks from a fixed set of stage kinds (New, 1st class, Nth class, Day N, Done, Converted), ticks the ones they want and renames them.
- **Mia:** knows the person's board, stage and "day N of M"; follows short notes the builder writes per board; runs an end-of-offer conversation toward the next step.
- **Reports:** funnel per stage, conversion and revenue, follow-up results, and gaps/health warnings.
- **Order:** safety fixes first, then the builder.

## Recommended approach

**Configured "offer boards" with their follow-ups attached.** A board is a row in `pipelines` with a `board_type` and a `config` (entry rule, stages, day counts, Mia notes). The movement logic stays in tested code, as one generic offer module whose constants become settings. Each stage owns its follow-up (a sequence plus a WhatsApp template) through a new link table, so the board always knows which stages are covered. A library of **recipes** ("€39 trial", "Programme lead", "Promo claim") pre-fills a board and its follow-up pack, used by the wizard, by other gyms, and by new-studio onboarding.

What we build on (all on `origin/main`; the local checkout is ~159 commits behind, so branch off fresh `origin/main`):
- `shared/pipelines/paid-trial.js` (`paidTrialClaim`, `attendedSince`, `convertedSince`, `lastActivityMs`, `classify`): becomes the generic offer module.
- `src/lib/pipeline-claims.js` (`pendingProgrammeClaims`, `upsertProgrammeClaims`, `pipeline_board_claims` keyed by `board_key`): generalised to any board key and matcher.
- `SEQUENCE_TEMPLATES` + `src/lib/sequences/template-install.js` (resolve template name → id, refuse unless APPROVED): how recipe packs become sequences.
- `guardMasterOrOwner` (`src/lib/auth.js`): already admits org admins (they act as owner at every studio in their org), so no new permission key is needed.
- `canBuildSequencesAt` / `canManageWaTemplatesAt`: gate managers' wording edits.
- `reclassifyAllContacts({ dryRun })` (`src/lib/pipeline-reclassify.js`): the builder's dry run.

### PR 1: Safety fixes (no migration, protects today's boards too)
- **Coverage panel.** A read-only card on the pipeline page and in settings that lists every stage of every enabled board, each with the live `pipeline_stage_change` sequences aimed at it. Stages with none show red. This alone would have caught "1st Class".
- **Publish gate.** `validateGraph` (`src/lib/sequences/graph/validate.js`) gets template status; the publish route (`src/app/api/sequences/[id]/graph/publish/route.js`) refuses `template_not_approved` and reads templates fail-closed for that check.
- **No permanent pause while a template is pending.** `resolveApprovedWhatsappTemplate` (`src/lib/sequences/steps.js`) throws a typed deferral for PENDING, which the scheduler retries like `FrequencyCapDeferral` without counting an error. REJECTED/DISABLED still pause, stamped `[wa_tpl:<id>]` in `last_error`. **Staleness cap:** a step more than 48 h past its due time exits (`exit_reason 'stale_template_wait'`) instead of sending late, so no "how was your first class" lands a week later.
- **Resume on approval.** `applyTemplateEvent` (`src/lib/whatsapp-template-events.js`) first checks its own update's error (today a bare write). Then, on APPROVED, a best-effort hook resumes enrolments carrying that template's stamp at that studio only, through `src/lib/sequences/resume.js` and with the same 48 h staleness cap.
- **Stage picker reads real stages.** `SequenceSettings.jsx` loads the studio's stages from an endpoint instead of `PIPELINE_SLUGS` / `PAID_TRIAL_STAGE_OPTS`. `view.js` reads `to_status` (it reads `to_stage` today). The editor warns when the stage is left as "Any stage".
- **New branch predicate `has_future_booking_at_studio`.** Bookings after now at the studio. Added in `schema.js`, `validate.js`, `steps.js` and `view.js`, and listed in the sequence agent's prompt.

### PR 2: Schema and stage kinds (one migration, then remove the hard-coded lists)
- **`pipelines`** gets `board_type`, `recipe_key`, `config jsonb default '{}'`, `priority int default 100`, `created_by` and `updated_at`. A check: if `board_type` is set, `module` must be `offer` or `offer_un1t`. A guard (`assertNotLegacyBoard`) refuses edits to rows with no `board_type`, so today's five boards cannot be changed.
- **`pipeline_stages`** gets `stage_role` (`new | first_class | class_n | checkpoint | done | converted | pile | custom`) and `role_config jsonb` (e.g. `{day: 7}`, `{count: 3}`). The migration fills in roles for existing slugs; their behaviour does not change.
- **New table `pipeline_stage_followups`:** `pipeline_id`, `stage_id`, `sequence_id`, `whatsapp_template_id`, `pack_key`, `state` (`draft | awaiting_approval | live | rejected | off`), `want_live`, timestamps.
  - Security: service role only (RLS on, no policy, `REVOKE ALL FROM anon, authenticated`).
  - Linked sequences also carry `pipeline_id` and `pipeline_stage_id` in `trigger_config`, so `email_sequences` gets no new column.
- **Slugs:** `<board key>_<role>[_n]`, with a generated board key `o_<name>`. They never change after creation; renaming a stage changes only `name`. `UNIQUE (location_id, slug)` (mig 150) is the backstop.
- **Remove the hard-coded slug lists.** Labels, colours and order come from `pipeline_stages`; badges, check-ins and headlines come from `stage_role` via a new `shared/pipelines/stage-roles.js`. Representative files:
  - `src/components/KanbanBoard.jsx`, `AudienceBuilder.jsx` (options fetched per studio), `ContactsTable.jsx`, `PipelineReclassifyTab.jsx`, `DealCard.jsx`
  - `src/lib/pipeline-card-signal-slugs.js`, `src/lib/pipeline-board.js`, `src/lib/agent/followups.js` (`CHECKIN_STAGES`), `src/lib/dashboard/business-rail.js`
  - `mobile/components/dashboard/StudioDashboard.jsx`
- **Guard and gates:** a new test, `tests/pipeline-slug-literals-guard.test.js`, stops new slug lists appearing outside `shared/pipelines/`. Run `get_advisors` after the migration, plus the CI mirror.

### PR 3: Offer engine
- **Modules.** `shared/pipelines/offer.js` (contacts input, Glofox studios) and `offer-un1t.js` (`inputSource 'un1t_online'`), registered in `BOARD_MODULES`. The module interface gains `config`: `stagesFor(config)`, `claimLive(..., config)`, `classify(..., config)`, covering duration, checkpoint days, Nth-class counts, quiet window and converted window.
- **Entry rules** come from a fixed list. Each loader lives in `src/lib/pipeline-offer-claims.js`, and a failed read places nobody that run (as today).
  - **The source row is the claim:**
    - `trial_purchase` (by plan code or landing path, from `trial_purchases`)
    - `corp_promo` (`corp_promo_claims`, status granted)
    - `un1t_product` (`shapePipelineSnapshot` generalised to return claims per board)
  - **Recorded once in `pipeline_board_claims`:** `lead_source`, `glofox_plan` and `tag`.
- **Router.** `routeContact` (`shared/pipelines/router.js`) takes board descriptors `{key, module, priority, config}` instead of a Set, which also fixes today's mix-up where the nightly pass passes keys and `ensureDealForContact` passes modules. Precedence:
  1. Cold and Gympass
  2. Configured boards by `priority`
  3. The existing €39 board (fixed at 200)
  4. The existing Programmes board (fixed at 300)
  5. Acquisition

  A **golden test** runs today's router fixtures through the new signature and must give identical answers.
- **Callers.** `reclassifyAllContacts`, `maybeReclassifyAfterSync` (`src/lib/un1t-pipeline-cadence.js`), `ensureDealForContact` (`src/lib/glofox-sync.js`) and `placeContactNow` (`src/lib/pipeline-place-now.js`) all load configured boards via `loadBoardsForLocation`. `PLACE_NOW_COLUMNS` becomes the union of every module's `requiredFields`.
- **Fire on create, configured boards only.** The nightly pass's `createsToApply` and `triggerSequencesForDealPlacement` fire `null → slug` for boards with a `board_type`, keeping the 50-per-stage mass guard. Existing boards keep today's behaviour.
- **Silent switch-on.** Turning a board on runs one placement pass with triggers off, so nobody who already qualifies is messaged on day one.

### PR 4: Recipes and follow-up packs
- **Recipe library** `shared/pipelines/recipes.js`, starting with `paid_trial_offer`, `programme_lead` and `promo_claim`. Each recipe has a board type, default entry rule, stages with roles and days, and per stage a follow-up pack: WhatsApp template components with `{{first_name}}`, a category, a branch skeleton (e.g. `has_future_booking_at_studio`) and default copy in Garrett's style. The existing €39 copy becomes the default wording.
- **Lift two helpers out of their routes:**
  - `submitWhatsappTemplate()` from `POST /api/whatsapp/templates`, keeping the per-WABA name check. Template names get a per-studio suffix.
  - `publishSequence()` from the publish route.
- **Approval hook.** The `applyTemplateEvent` hook from PR 1 also publishes any `awaiting_approval` + `want_live` follow-up when its template is approved, sets `state = 'live'`, and marks REJECTED with a notification.

### PR 5: Builder and settings
- **Pages:**
  - `/settings/pipelines`: list of boards (existing ones read-only) with the coverage panel.
  - `/settings/pipelines/new`: the wizard.
  - `/settings/pipelines/[id]`: the same sections, editable later.
- **Wizard steps:** pick a recipe or type → entry rule (pickers fed from that studio's plan codes, un1t products, promos and lead sources) → stages (tick, rename, day/class counts) → follow-ups (suggested wording per stage, editable, live preview) → Mia notes → review → **create (off)** → submit templates → dry run (count per stage plus overlap with existing boards) → turn on.
- **Routes** use the house skeleton, return 404 for another studio's board, and are registered in `openapi.js`:
  - `GET/POST /api/locations/[id]/pipelines`. POST uses `guardMasterOrOwner` and a new service-role RPC, `create_configured_pipeline`, so the board and its stages are created in one transaction. `check:rpc-names` and the function-execute guard apply.
  - `PATCH /api/pipelines/[id]` and `/enable`, `/disable`, `/dry-run` (owner gate). A stage can be removed only when empty.
  - `PUT /api/pipelines/[id]/followups/[stageId]`, open to managers via `canBuildSequencesAt` + `canManageWaTemplatesAt`.
- The wizard picks `offer` vs `offer_un1t` from `locations.membership_source` and refuses to mix them at one studio.

### PR 6: Mia, reports, onboarding
- **Mia:**
  - `describeContactBoard(db, contactId)` gives board, stage, "day N of M", entry label and the builder's notes, added to Mia's context.
  - **End-of-offer conversation:** a board setting that reuses the trial-done runner's flow (`src/lib/agent/trial-done-runner.js`) on configured boards (opener template, one follow-up, fresh eligibility checks). The existing Hatch runner is left as is.
- **Reports**, from `GET /api/pipelines/[id]/report`:
  - funnel per stage, now and over 7/30 days
  - conversion rate and revenue (offer price plus purchases after)
  - per-follow-up sent/delivered/read/replied and booked-after
  - health warnings: stage with no follow-up, template rejected or paused, follow-ups paused, nobody entered in 7 days
- **Onboarding:** `seedRecipeBoards()` in `src/lib/location-seed.js` creates recipe boards switched off for a new studio (and for other gyms); the wizard finishes them once the studio has a WhatsApp number.

### Left out of v1
- A free-form rule builder
- Manual boards
- Moving today's boards onto the new system
- Cloning boards across studios
- Org-saved custom recipes (later: "save this board as a recipe")
- A/B tests

### Risks and how they're handled
- **A change to today's routing:** golden router tests, plus a dry run at Stillorgan and Hatch before PR 3 merges.
- **A new board taking people from the €39 board:** the dry-run overlap warning, and a priority the builder sets.
- **A mass message at switch-on:** the silent baseline plus the 50-per-stage guard.
- **Late messages after a slow approval:** the 48 h staleness cap.
- **WABA name clashes:** per-studio suffixes.
- **Meta delays or rejections:** each follow-up shows its state, and the board stays usable while it waits.

## Verification
- **Every PR:** the 13-command CI mirror from CLAUDE.md, plus `npm run build` for new routes and pages. Migrations go in via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`, followed by `get_advisors` (security).
- **PR 1:**
  - Publishing a sequence whose template is PENDING is refused (route test).
  - A PENDING template defers without `error_count`; on approval the enrolment resumes; a step more than 48 h late exits (scheduler tests).
  - On prod, the coverage panel shows every €39 stage covered at both studios today.
- **PR 3:**
  - Golden router fixtures are identical.
  - `reclassifyAllContacts({ dryRun: true })` at Stillorgan and Hatch shows zero changes to existing boards.
  - A test offer board at Test Studio places a seeded contact into each stage.
- **PR 4 and PR 5, end to end on Test Studio:**
  - Build a board from the `paid_trial_offer` recipe in the wizard (browser pane, Richard's session), submit templates, and confirm follow-ups sit in `awaiting_approval` and switch to `live` on the approval webhook.
  - Dry run, turn on, and check that nobody already qualifying is enrolled (silent baseline).
  - Move a test contact into "1st class" and confirm one enrolment and one send after the wait.
- **PR 6:** Mia's context for a test contact shows the board, the day and the notes; the report numbers match hand SQL counts for the test board.

## First step after approval
Commit this as `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` on a fresh branch off `origin/main`, then write the detailed task plan for PR 1 (superpowers:writing-plans) and build it.
