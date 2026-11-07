# PIPEBUILD small fixes: Turn on, Turn off, reinstall wording

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on waits until every follow-up has finished installing; the Turn off confirmation says what happens to follow-ups already on their way; a reinstall with new wording never silently links an old template of the same name.

**Architecture:** Two optional props on `BoardLaunchPanel` that only the wizard passes; one sentence of staff copy; a wording check in `installFollowupPack`'s name-clash branch plus one retry at a fresh template version in `applyFollowupAction`. No migration.

**Tech Stack:** React client components, Vitest + Testing Library, Supabase service role.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` (must-not-happen: "messages going out wrong"); follow-ups noted in PR #2313.

## Global Constraints

- Board settings (`BoardSettings.jsx`) keep today's Turn on behaviour: it passes neither new prop.
- Turning a board off keeps today's behaviour (no sequences paused, no enrolments exited); only the confirmation copy changes.
- A linked template's wording must equal the wording being installed; when it does not, the install never links it.
- supabase-js resolves `{ data, error }`: handle errors; name columns.

## Review Focus

1. A wizard run where the first pack installs, the user dry-runs, and the second pack is still installing: Turn on stays disabled.
2. A pack that fails outright (no row, an issue shown) counts as settled, so the user can still turn on with the packs that worked.
3. A retry in the wizard (same wording) still links the templates the first attempt submitted — the convergence the code relies on must keep working.
4. Meta's stored component shape may differ from what was submitted: compare the BODY text only (the editable part), trimmed.

---

### Task 1: Turn on waits for every install; Turn off says what happens

**Files:**
- Modify: `src/components/pipelines/BoardLaunchPanel.jsx` (`:16` LIVE_STATES, `:50-51` canTurnOn, the Turn on row ~`:134-138`), `src/components/pipelines/BoardWizard.jsx` (`finish` `:116-121` keeps the pack keys in `launch`; `:157` passes the new props), `src/components/pipelines/BoardSettings.jsx` (`TURN_OFF_CONFIRM` `:26`)
- Test: `src/components/pipelines/BoardLaunchPanel.test.jsx`, `src/components/pipelines/BoardWizard.test.jsx`, `src/components/pipelines/BoardSettings.test.jsx`

**Interfaces:**
- `BoardLaunchPanel` gains `installing = false` and `expectedKeys = null`. `settled = !installing && (expectedKeys == null || expectedKeys.every((k) => followups.some((f) => f.pack_key === k) || issues.some((i) => i.key === k)))`; `canTurnOn = !!dry && hasFollowup && settled && !enabled`. While not settled, show beside the disabled button: `Installing follow-ups…`.
- `BoardWizard`: `launch.expectedKeys = followupPacks(wizardState).map((p) => p.key)` set in `finish`; passes `installing={busy}` and `expectedKeys={launch.expectedKeys}`.
- `TURN_OFF_CONFIRM` gets, appended as its last sentence: `Follow-ups already on their way stop the next time they check the board, and turning it back on does not restart them.`

- [ ] **Step 1: Failing tests** — panel: dry run done + one live follow-up + `installing` → Turn on disabled and "Installing follow-ups…" shown; `expectedKeys: ['a','b']` with a row for `a` only → disabled; with a row for `a` and an issue for `b` → enabled; no props (settings) → today's behaviour. Wizard: Turn on stays disabled until the last install resolves (stub the install fetch with a deferred second response). Settings: the confirm dialog contains the new sentence.
- [ ] **Step 2: Run** `npx vitest run src/components/pipelines/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npx eslint` touched files; `npm run check:guardrails`.
- [ ] **Step 5: Commit** `PIPEBUILD.5r — Turn on waits for every install; Turn off says what happens to follow-ups`.

### Task 2: A reinstall never links old wording

**Files:**
- Modify: `src/lib/pipeline-followup-packs.js` (name-clash branch `:183-205`, `readOwnTemplate` `:429-443`), `src/lib/pipeline-board-followups.js` (`applyFollowupAction` install/replace around the version rule `:344-346`)
- Test: `src/lib/pipeline-followup-packs.test.js`, `src/lib/pipeline-board-followups.test.js`

**Interfaces:**
- `readOwnTemplate` also selects `components`; the clash branch links the existing template only when its BODY text (the `type: 'BODY'` component's `text`, trimmed) equals the BODY text of `t.components`. On a mismatch, `installFollowupPack` returns `{ ok: false, status: 409, code: 'template_wording_differs', error: 'A template with this name already exists with different wording.' }` (match the file's failure shape) and links nothing, writes no sequence.
- `applyFollowupAction`: when the install returns `code: 'template_wording_differs'`, retry ONCE with `version + 1` (fresh names for every template of the pack); the row's stored `version` becomes the one that linked. A second `template_wording_differs` is returned to the caller as is.
- Same wording on a clash still links (the wizard's retry convergence).

- [ ] **Step 1: Failing tests** — packs: clash with the same BODY text → links the existing id; clash with different BODY text → `template_wording_differs`, no link, no sequence insert; a stored template whose components lack a BODY → treated as different. Followups: an install whose first attempt returns `template_wording_differs` succeeds on the retry at `version + 1` and stores that version; two in a row → the error is returned.
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-followup-packs.test.js src/lib/pipeline-board-followups.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run check:select-columns`.
- [ ] **Step 5: Commit** `PIPEBUILD.5s — a reinstall never links a template with old wording`.
