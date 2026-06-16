# Automations Builder — Phase 2: Authoring Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Phase-1 engine additions (`glofox_provision` action + `contact_created` trigger) **authorable by an operator** — selectable on the visual builder canvas, pickable as a trigger, emittable by the "Build with AI" agent, and flagged in the pre-publish review banner.

**Architecture:** Phase 1 registered the two types in the engine + graph vocabulary (`schema/validate/view/edit` + executor + dispatcher) but deliberately left the *authoring* surfaces untouched. This phase wires them into the four operator-facing surfaces, all additive registry/string edits — no schema, no engine logic, no new imports beyond one lucide icon.

**Tech Stack:** Next.js 16 (App Router), React, lucide-react, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-operator-authored-automations-design.md` (Phase 2). Base branch `feat/automations-builder-p2` off `main` (Phase 1 already merged, PR #549).

---

## File map

| File | Change |
|---|---|
| `src/components/sequences/nodeStyles.js` | `NODE_STYLES.glofox_provision` (icon + chip + label) + add to `ADDABLE_TYPES` |
| `src/components/sequences/SequenceSettings.jsx` | `['contact_created', 'When a new lead is created']` in `TRIGGER_OPTIONS` |
| `src/components/sequences/SequenceFlowBuilder.jsx` | `glofox_provision` in `WRITE_STEP_LABELS` |
| `src/lib/sequences/agent/prompt.js` | `glofox_provision` config-doc line + `contact_created` trigger guidance |
| `src/lib/sequences/agent/prompt.test.js` | assert the prompt documents both new types |

## Out of scope (deferred)
- The IA rebrand (`/automations` home, redirects, "Sequence"→"Automation") — **Phase 3**.
- Templates gallery + run history — **Phase 4**.

---

## Task 1: Builder pickability + review banner

**Files:**
- Modify: `src/components/sequences/nodeStyles.js`
- Modify: `src/components/sequences/SequenceSettings.jsx`
- Modify: `src/components/sequences/SequenceFlowBuilder.jsx`

- [ ] **Step 1: Add the node style + make it addable in `nodeStyles.js`**

Add `UserPlus` to the lucide-react import (it's the existing import block at the top of the file):

```js
import {
  Mail, MessageCircle, MessageSquare, Hourglass, Tag, PencilLine,
  ClipboardList, Webhook, GitBranch, ArrowRightCircle, CircleDot, UserPlus,
} from 'lucide-react'
```

Add the style entry to `NODE_STYLES` (after the `move_pipeline_stage` line):

```js
  move_pipeline_stage: { icon: ArrowRightCircle, chip: 'bg-emerald-500/10 text-emerald-700', label: 'Move pipeline' },
  glofox_provision: { icon: UserPlus, chip: 'bg-teal-500/10 text-teal-700', label: 'Create in Glofox' },
}
```

Add it to `ADDABLE_TYPES` (operational actions group, after `move_pipeline_stage`):

```js
export const ADDABLE_TYPES = [
  'email', 'whatsapp', 'sms', 'wait',
  'apply_tag', 'update_field', 'internal_task', 'move_pipeline_stage', 'glofox_provision', 'webhook',
]
```

- [ ] **Step 2: Verify the icon import resolves**

Run: `cd /Users/richardivers/code/un1t-crm-ab && node -e "import('lucide-react').then(m => console.log('UserPlus' in m ? 'OK' : 'MISSING'))"`
Expected: `OK`. (If `MISSING`, pick another existing icon such as `UserRoundPlus` or `BadgePlus` and use it consistently in the import + `NODE_STYLES`.)

- [ ] **Step 3: Add the trigger option in `SequenceSettings.jsx`**

In the `TRIGGER_OPTIONS` array (starts ~line 22), add the `contact_created` entry immediately after the `manual` entry so it sits near the top of the dropdown:

```js
const TRIGGER_OPTIONS = [
  ['manual', 'Manually enrolled'],
  ['contact_created', 'When a new lead is created'],
  ['booking_created', 'When a booking is created'],
  // …rest unchanged…
]
```

(Read the file first to copy the exact existing `manual` label text; match it. `contact_created` needs NO trigger-config UI block — like `manual`, it has no config — so do not add a conditional config section for it.)

- [ ] **Step 4: Flag it in the review banner in `SequenceFlowBuilder.jsx`**

In the `WRITE_STEP_LABELS` map (~line 20), add `glofox_provision`:

```js
const WRITE_STEP_LABELS = {
  apply_tag: 'add a tag', update_field: 'update a contact field',
  webhook: 'call an external webhook', move_pipeline_stage: 'move the pipeline stage',
  glofox_provision: 'create Glofox accounts + attach trials',
}
```

- [ ] **Step 5: Lint + verify nothing broke**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx eslint src/components/sequences/nodeStyles.js src/components/sequences/SequenceSettings.jsx src/components/sequences/SequenceFlowBuilder.jsx`
Expected: no errors.

Run the graph + sequences test suites to confirm no regression:
Run: `npx vitest run src/lib/sequences/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add src/components/sequences/nodeStyles.js src/components/sequences/SequenceSettings.jsx src/components/sequences/SequenceFlowBuilder.jsx
git commit -m "feat(automations): builder pickability — glofox_provision palette node + contact_created trigger + review-banner flag"
```

---

## Task 2: AI authoring — teach the agent the new types

**Files:**
- Modify: `src/lib/sequences/agent/prompt.js`
- Modify: `src/lib/sequences/agent/prompt.test.js`

**Context:** `buildAgentSystemPrompt()` already interpolates the full `NODE_TYPES` and `TRIGGER_TYPES` lists (via `.join(', ')`), so `glofox_provision` and `contact_created` already *appear* in the prompt after Phase 1. What's missing is (a) the per-type **required-config doc line** for `glofox_provision` (the hardcoded bulleted list under "NODE TYPES"), and (b) **trigger guidance** so the agent knows when to choose `contact_created`.

- [ ] **Step 1: Write the failing test**

In `src/lib/sequences/agent/prompt.test.js`, add a test asserting the system prompt documents both new types (read the file first to match its existing import of `buildAgentSystemPrompt` + test style):

```js
it('documents the glofox_provision action and the contact_created trigger', () => {
  const p = buildAgentSystemPrompt()
  expect(p).toContain('glofox_provision')
  expect(p).toMatch(/Glofox account/i)         // the config-doc line
  expect(p).toContain('contact_created')
  expect(p).toMatch(/new lead/i)               // trigger guidance phrasing
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx vitest run src/lib/sequences/agent/prompt.test.js -t "glofox_provision action"`
Expected: FAIL — the `/Glofox account/i` and `/new lead/i` assertions fail (the type names appear in the joined lists, but the doc line + guidance phrasing don't exist yet).

- [ ] **Step 3: Add the config-doc line + trigger guidance in `prompt.js`**

In `buildAgentSystemPrompt()`, in the "Required config per type:" bulleted list, add a `glofox_provision` line immediately after the `move_pipeline_stage:` line and before the `branch:` line:

```js
- move_pipeline_stage: { stage_slug } — one of new_lead, active_trial, hot_conversion, active_member, at_risk_member, classpass_active, lapsed, dormant, dormant_classpass.
- glofox_provision: {} (no config). Creates the contact's Glofox account + attaches the studio trial. Use when the request is about registering/adding a new lead in Glofox (e.g. "when a new lead comes in, add them to Glofox with a trial").
- branch:  { predicate } where predicate is { type:"has_tag", tag } OR { type:"field_equals", field, value } OR { type:"field_in", field, values:[...] }.
```

In the `TRIGGER + NAME:` paragraph, extend the example list to include `contact_created` — change the existing examples sentence so it reads (add the `contact_created` clause):

```js
CHOOSE the trigger that best fits the request and set trigger.type (+ any trigger.config) accordingly — e.g. a new-lead onboarding flow → contact_created; a welcome flow → booking_created or manual; a re-engagement flow → inactivity; a tag-driven flow → tag_added; a stage-based flow → pipeline_stage_change.
```

(Read the exact current sentence first and edit it in place — keep the rest of the paragraph, including the "Avoid webhook unless…" clause, intact.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx vitest run src/lib/sequences/agent/prompt.test.js`
Expected: PASS (the whole file — confirm no existing assertion broke).

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add src/lib/sequences/agent/prompt.js src/lib/sequences/agent/prompt.test.js
git commit -m "feat(automations): teach the Build-with-AI agent the glofox_provision action + contact_created trigger"
```

---

## Definition of done (CI mirror — run from the worktree)

```bash
cd /Users/richardivers/code/un1t-crm-ab
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```

All green. No migration, no `shared/permissions.js` change (no new permission key — authoring stays gated by the existing `automations`/sequence permission), so mobile-parity is unaffected. **`npm run build` (Turbopack) can't run under the symlinked `node_modules` in this worktree — the Vercel PR check is the build gate** (the only new import is `UserPlus` from lucide-react, verified to resolve in Task 1 Step 2).

**What this delivers:** an operator can now (a) pick **"When a new lead is created"** as an automation trigger, (b) drop a **"Create in Glofox"** action node on the canvas, (c) describe *"when a new lead comes in, create them in Glofox with a trial and tag them hot"* in Build-with-AI and get a valid draft, and (d) sees a review-banner heads-up that the draft "will also create Glofox accounts + attach trials" before publishing. Combined with Phase 1, the full `contact_created → glofox_provision` automation is now operator-authorable end-to-end.

---

## Self-review

- **Spec coverage (Phase 2):** builder pickability (node palette + trigger picker) → Task 1; AI authoring → Task 2; review-banner flags the write step → Task 1 Step 4; validation already done in Phase 1 (noted). ✓
- **Placeholders:** none — every edit shows complete code; the icon-existence check (Task 1 Step 2) is a real verification command with a fallback.
- **Consistency:** `glofox_provision` label is `'Create in Glofox'` everywhere (nodeStyles + the Phase-1 view.js `describeNode`); `contact_created` label `'When a new lead is created'` matches the Phase-1 `view.js` `TRIGGER_LABELS` entry. `WRITE_STEP_LABELS` phrasing is operator-facing prose consistent with the sibling entries.
- **Ambiguity:** "pickable" pinned to the two concrete registries (`ADDABLE_TYPES`, `TRIGGER_OPTIONS`); AI authoring pinned to the prompt's config-doc list + trigger-guidance sentence, with a test that fails before and passes after.
