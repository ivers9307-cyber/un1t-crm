# Automations Builder — Phase 1: Engine Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Sequences automation engine able to express *"when a new lead is created → create them in Glofox with a trial"* — by adding one operational **action step** (`glofox_provision`) and one **trigger** (`contact_created`), with no UI/IA change yet.

**Architecture:** The Sequences engine (`src/lib/sequences/`) is already a general automation engine (graph vocabulary in `graph/`, step executors in `steps.js`, the cron runner in `scheduler.js`, trigger dispatchers in `triggers.js`). Phase 1 extends each of those registration points for the two new types, wraps the *already-vetted* `findOrCreateGlofoxMember` create-and-trial primitive as a step executor, and fires a new `contact_created` trigger from the same three interactive lead-create sites the curated automation already hooks. Mergeable dark — nothing fires until an operator builds an automation using these (and the builder-pickability lands in Phase 2).

**Tech Stack:** Next.js 16 (App Router), Supabase (service-role), Vitest, Zod. No migration, no schema change (per the umbrella spec: `email_sequences`/`sequence_steps`/`sequence_enrollments` keep their names).

**Spec:** `docs/superpowers/specs/2026-06-16-operator-authored-automations-design.md` (Phase 1).

---

## Out of scope for Phase 1 (deferred — do NOT build here)
- **Builder pickability** — adding `glofox_provision` to the node palette and `contact_created` to the trigger picker in `SequenceSettings.jsx`. That's **Phase 2** (authoring). Phase 1 only makes the engine + graph *vocabulary* aware so a graph containing these validates/compiles/persists and executes.
- **AI "Build with AI" agent** changes — Phase 2.
- **Any rebrand / `/automations` re-home** — Phase 3.
- **Wiring the trigger into bulk-import or glofox-sync** — deliberately excluded (mass-create guard), same as the curated hook.

---

## File map

| File | Change |
|---|---|
| `src/lib/sequences/graph/schema.js` | add `'glofox_provision'` to `NODE_TYPES` + `CONFIG_NODE_TYPES`; add `'contact_created'` to `TRIGGER_TYPES` |
| `src/lib/sequences/graph/schema.test.js` | update expected arrays |
| `src/lib/sequences/graph/validate.js` | explicit `case 'glofox_provision'` (no required config) |
| `src/lib/sequences/graph/validate.test.js` | add a passing-graph case |
| `src/lib/sequences/graph/view.js` | `TYPE_LABELS` + `describeNode` + `TRIGGER_LABELS` entries |
| `src/lib/sequences/graph/view.test.js` | add node + trigger rows |
| `src/lib/sequences/graph/edit.js` | `defaultConfigForType` case |
| `src/lib/sequences/steps.js` | new `glofoxProvisionStep` executor |
| `src/lib/sequences/steps.test.js` | tests for `glofoxProvisionStep` |
| `src/lib/sequences/scheduler.js` | import + `else if` branch for `glofox_provision` |
| `src/lib/sequences/triggers.js` | new `triggerSequencesForContactCreated` dispatcher |
| `src/lib/sequences/triggers.test.js` | tests for the dispatcher |
| `src/app/api/sequences/route.js` (+ `[id]/route.js` if it has a second enum) | add `'contact_created'` to the `trigger_type` enum |
| `src/app/api/contacts/route.js`, `src/app/api/public/leads/route.js`, `src/app/api/assistant/chat/route.js` | fire `triggerSequencesForContactCreated` after contact insert |

---

## Task 1: Register the `glofox_provision` action node in the graph vocabulary

**Files:**
- Modify: `src/lib/sequences/graph/schema.js`
- Modify: `src/lib/sequences/graph/schema.test.js`
- Modify: `src/lib/sequences/graph/validate.js`
- Modify: `src/lib/sequences/graph/validate.test.js`
- Modify: `src/lib/sequences/graph/view.js`
- Modify: `src/lib/sequences/graph/view.test.js`
- Modify: `src/lib/sequences/graph/edit.js`

- [ ] **Step 1: Update the schema tests to expect the new node type (failing test first)**

In `src/lib/sequences/graph/schema.test.js`, the `NODE_TYPES` / `CONFIG_NODE_TYPES` assertions currently end with `'move_pipeline_stage'`. Add `'glofox_provision'` after it in **both** expected arrays (the test currently has these lines for `NODE_TYPES`):

```js
      'email', 'whatsapp', 'sms', 'wait', 'apply_tag', 'update_field',
      'internal_task', 'webhook', 'branch', 'move_pipeline_stage', 'glofox_provision',
```

Apply the same `, 'glofox_provision'` addition to the `CONFIG_NODE_TYPES` expectation in that file (find the array that lists `apply_tag … move_pipeline_stage` for config nodes and append it).

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/schema.test.js`
Expected: FAIL — `NODE_TYPES` (and/or `CONFIG_NODE_TYPES`) does not contain `'glofox_provision'`.

- [ ] **Step 3: Add the node type to `schema.js`**

In `src/lib/sequences/graph/schema.js`, append `'glofox_provision'` to both arrays:

```js
export const CONFIG_NODE_TYPES = [
  'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch', 'move_pipeline_stage', 'glofox_provision',
]
// Order matters for the test + for stable UI listing.
export const NODE_TYPES = [
  'email', 'whatsapp', 'sms', 'wait',
  'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch', 'move_pipeline_stage', 'glofox_provision',
]
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/schema.test.js`
Expected: PASS.

- [ ] **Step 5: Add a passing-graph validation test (failing first)**

In `src/lib/sequences/graph/validate.test.js`, add this test (it asserts a trigger→glofox_provision graph with empty config has no errors):

```js
it('accepts a glofox_provision node with no config', () => {
  const g = {
    version: 1,
    trigger: { type: 'contact_created', config: {} },
    nodes: [{ id: 'n1', type: 'glofox_provision', config: {} }],
    edges: [{ from: 'trigger', to: 'n1' }],
  }
  const r = validateGraph(g)
  expect(r.ok).toBe(true)
  expect(r.errors).toEqual([])
})
```

Note: this test also depends on `'contact_created'` being a valid trigger (Task 2). If Task 2 isn't done yet, temporarily use `trigger: { type: 'manual', config: {} }` to keep Task 1 self-contained, then switch it to `contact_created` in Task 2. (Recommended: do Task 1 then Task 2 in order and use `manual` here.)

- [ ] **Step 6: Run the validate test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/validate.test.js -t "glofox_provision"`
Expected: FAIL — the node type isn't in `NODE_TYPES` yet *unless Step 3 ran*; if Step 3 already ran, this should actually PASS because `requiredConfigError` falls through to `default → null`. If it passes already, proceed; the explicit case in Step 7 is documentation-only.

- [ ] **Step 7: Add the explicit no-config case to `validate.js`**

In `src/lib/sequences/graph/validate.js`, inside `requiredConfigError`'s `switch`, add a case just before `default` (documents that the action needs no config; behaviour is identical to the default):

```js
    case 'glofox_provision':
      return null // no required config — uses the location's trial settings
    default:
      return null
```

- [ ] **Step 8: Run the validate test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/validate.test.js`
Expected: PASS.

- [ ] **Step 9: Add the node label + summary test (failing first)**

In `src/lib/sequences/graph/view.test.js`, find the table of `describeNode` cases (rows like `[{ type: 'apply_tag', config: { tag: 'vip' } }, 'Apply tag', 'Add tag “vip”']`) and add:

```js
    [{ type: 'glofox_provision', config: {} }, 'Create in Glofox', 'Create Glofox account + trial'],
```

- [ ] **Step 10: Run the view test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/view.test.js`
Expected: FAIL — `describeNode` returns `{ typeLabel: 'Glofox provision', summary: 'Glofox provision' }` (the `humanise` fallback), not the expected label/summary.

- [ ] **Step 11: Add the label + summary to `view.js`**

In `src/lib/sequences/graph/view.js`:

In `TYPE_LABELS`, add the entry:

```js
  webhook: 'Webhook', branch: 'Branch', move_pipeline_stage: 'Move pipeline',
  glofox_provision: 'Create in Glofox',
```

In `describeNode`'s `switch`, add a case before `default`:

```js
    case 'glofox_provision': summary = 'Create Glofox account + trial'; break
    default: summary = typeLabel
```

- [ ] **Step 12: Run the view test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/view.test.js`
Expected: PASS.

- [ ] **Step 13: Add the default config to `edit.js`**

In `src/lib/sequences/graph/edit.js`, in `defaultConfigForType`'s `switch`, add a case before `default` (explicit; matches the default `{}` but documents the type):

```js
    case 'move_pipeline_stage': return { stage_slug: '' }
    case 'glofox_provision': return {}
    default: return {}
```

- [ ] **Step 14: Run the full graph test suite + commit**

Run: `npx vitest run src/lib/sequences/graph/`
Expected: PASS (all files).

```bash
git add src/lib/sequences/graph/
git commit -m "feat(automations): register glofox_provision action node in the flow-graph vocabulary"
```

---

## Task 2: Register the `contact_created` trigger in the graph vocabulary + API

**Files:**
- Modify: `src/lib/sequences/graph/schema.js`
- Modify: `src/lib/sequences/graph/schema.test.js`
- Modify: `src/lib/sequences/graph/view.js`
- Modify: `src/lib/sequences/graph/view.test.js`
- Modify: `src/app/api/sequences/route.js`
- Modify: `src/app/api/sequences/[id]/route.js` (only if it has its own `trigger_type` enum)

- [ ] **Step 1: Update the schema test to expect the new trigger (failing first)**

In `src/lib/sequences/graph/schema.test.js`, the `TRIGGER_TYPES` test loops over a list with `.toContain`. Add `'contact_created'` to that loop list, e.g.:

```js
    for (const t of ['manual', 'booking_created', 'pipeline_stage_change', 'tag_added',
      'membership_state_change', 'contact_created']) {
      expect(TRIGGER_TYPES).toContain(t)
    }
```

(Keep whatever other types the existing loop already lists; just add `'contact_created'`.)

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/schema.test.js`
Expected: FAIL — `TRIGGER_TYPES` does not contain `'contact_created'`.

- [ ] **Step 3: Add the trigger type to `schema.js`**

In `src/lib/sequences/graph/schema.js`, append `'contact_created'` to `TRIGGER_TYPES` (add at the end of the array):

```js
export const TRIGGER_TYPES = [
  'manual', 'booking_created', 'first_booking', 'pipeline_stage_change', 'tag_added',
  'event_reminder', 'segment_added', 'segment_removed', 'membership_state_change', 'anniversary', 'inactivity',
  'race_registered', 'race_finished', 'order_completed', 'order_failed', 'order_abandoned',
  'achievement_unlocked', 'webhook', 'contact_created',
]
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/schema.test.js`
Expected: PASS.

- [ ] **Step 5: Add the trigger label test (failing first)**

In `src/lib/sequences/graph/view.test.js`, find the `describeTrigger` assertions (e.g. `expect(describeTrigger({ type: 'booking_created' })).toBe('When a booking is created')`) and add:

```js
expect(describeTrigger({ type: 'contact_created' })).toBe('When a new lead is created')
```

- [ ] **Step 6: Run the view test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/view.test.js -t "contact_created"`
Expected: FAIL — falls back to the humanised string, not `'When a new lead is created'`.

- [ ] **Step 7: Add the trigger label to `view.js`**

In `src/lib/sequences/graph/view.js`, in the `TRIGGER_LABELS` map, add:

```js
  manual: () => 'Manually enrolled',
  contact_created: () => 'When a new lead is created',
  booking_created: () => 'When a booking is created',
```

- [ ] **Step 8: Run the view test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/view.test.js`
Expected: PASS.

- [ ] **Step 9: Add the trigger to the API create enum**

In `src/app/api/sequences/route.js`, the `trigger_type: z.enum([...])` (around line 18) lists the allowed trigger types. Add `'contact_created'` to the array so a sequence can be created/updated with that trigger via the API:

```js
  trigger_type: z.enum([
    'manual', 'booking_created', 'first_booking', 'status_change',
    // ...keep all existing entries...
    'pipeline_stage_change', 'segment_added', 'segment_removed', 'membership_state_change', 'achievement_unlocked',
    'contact_created',
  ]).optional(),
```

- [ ] **Step 10: Add the trigger to the PUT enum if one exists**

Check whether the update route declares its own enum:

Run: `grep -n "trigger_type" 'src/app/api/sequences/[id]/route.js'`

If it has a `z.enum([...])` for `trigger_type`, add `'contact_created'` there too (same as Step 9). If the grep returns nothing or no enum, no change needed.

- [ ] **Step 11: Run the graph suite + commit**

Run: `npx vitest run src/lib/sequences/graph/`
Expected: PASS.

```bash
git add src/lib/sequences/graph/ src/app/api/sequences/
git commit -m "feat(automations): register contact_created trigger in graph vocabulary + sequences API enum"
```

---

## Task 3: `glofoxProvisionStep` executor + scheduler wiring

**Files:**
- Modify: `src/lib/sequences/steps.js`
- Modify: `src/lib/sequences/steps.test.js`
- Modify: `src/lib/sequences/scheduler.js`

- [ ] **Step 1: Write the failing tests for the executor**

In `src/lib/sequences/steps.test.js`, add `glofoxProvisionStep` to the import from `./steps.js` (find the existing `import { ... } from './steps.js'` and add the name), then add this `describe` block:

```js
describe('glofoxProvisionStep', () => {
  it('calls findOrCreate in create-and-trial mode with source=automation at the sequence location', async () => {
    const calls = []
    const fake = async (args) => { calls.push(args); return { status: 'created' } }
    await glofoxProvisionStep({}, {
      contact: { id: 'c1', location_id: 'loc-from-contact', email: 'a@b.com', first_name: 'A', last_name: 'B' },
      sequence: { id: 's1', location_id: 'loc-1' },
      _findOrCreateGlofoxMember: fake,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      locationId: 'loc-1',
      createIfMissing: true,
      attachTrial: true,
      source: 'automation',
    })
    expect(calls[0].contact.id).toBe('c1')
  })

  it('falls back to the contact location when the sequence has none', async () => {
    const calls = []
    const fake = async (args) => { calls.push(args); return { status: 'linked' } }
    await glofoxProvisionStep({}, {
      contact: { id: 'c1', location_id: 'loc-contact', email: 'a@b.com' },
      sequence: {},
      _findOrCreateGlofoxMember: fake,
    })
    expect(calls[0].locationId).toBe('loc-contact')
  })

  it('does not throw when findOrCreate reports a failed status', async () => {
    const fake = async () => ({ status: 'failed', error: 'missing first_name or last_name' })
    await expect(glofoxProvisionStep({}, {
      contact: { id: 'c2', location_id: 'loc-1', email: 'x@y.com' },
      sequence: { id: 's1', location_id: 'loc-1' },
      _findOrCreateGlofoxMember: fake,
    })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/sequences/steps.test.js -t "glofoxProvisionStep"`
Expected: FAIL — `glofoxProvisionStep is not a function` / not exported.

- [ ] **Step 3: Implement the executor in `steps.js`**

Append to `src/lib/sequences/steps.js`:

```js
// ── glofox_provision (AUTOMATIONS Phase 1) ───────────────────────
//
// Operational action: create the contact's Glofox account + attach the
// studio trial as a step in an automation flow. Wraps the vetted
// findOrCreateGlofoxMember create-and-trial primitive — idempotent
// (links by email if the member already exists), audited to
// glofox_push_events (source='automation'), and never-throws on a
// per-contact data problem (missing name / no Glofox creds → a 'failed'
// status that surfaces in the Glofox Review queue, NOT a runner error).
//
// Config: none — uses the location's settings.glofox trial config.
// `_findOrCreateGlofoxMember` is a test seam; production resolves the
// real helper via dynamic import (mirrors movePipelineStageStep).
export async function glofoxProvisionStep(db, { contact, sequence, _findOrCreateGlofoxMember }) {
  const findOrCreate = _findOrCreateGlofoxMember
    || (await import('../glofox-push.js')).findOrCreateGlofoxMember
  const locationId = sequence?.location_id || contact.location_id
  await findOrCreate({
    db,
    locationId,
    contact,
    source: 'automation',
    createIfMissing: true,
    attachTrial: true,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/sequences/steps.test.js -t "glofoxProvisionStep"`
Expected: PASS (all three cases).

- [ ] **Step 5: Wire the executor into the scheduler**

In `src/lib/sequences/scheduler.js`, add `glofoxProvisionStep` to the import block from `./steps.js`:

```js
import {
  sendEmailStep,
  sendWhatsappStep,
  sendSmsStep,
  applyTagStep,
  updateFieldStep,
  webhookStep,
  internalTaskStep,
  processBranchStep,
  movePipelineStageStep,
  glofoxProvisionStep,
} from './steps.js'
```

Then add a branch in the step-type `if/else` chain, immediately before the final `else { throw new Error(...) }`:

```js
      } else if (step.step_type === 'move_pipeline_stage') {
        // GLOFOX4.3 — move the contact's open deal to a target
        // pipeline stage. Config: { stage_slug }. Writes a
        // 'pipeline' activity row for the audit trail. Idempotent.
        await movePipelineStageStep(db, { step, contact, sequence })
        sendId = null
      } else if (step.step_type === 'glofox_provision') {
        // AUTOMATIONS Phase 1 — create the contact in Glofox + attach
        // the trial. No send_id. Idempotent + audited; per-contact
        // failures land in the Glofox Review queue, not as runner errors.
        await glofoxProvisionStep(db, { contact, sequence })
        sendId = null
      } else {
        throw new Error(`Unknown step_type "${step.step_type}".`)
      }
```

- [ ] **Step 6: Run the scheduler + steps suites to verify nothing broke**

Run: `npx vitest run src/lib/sequences/scheduler.test.js src/lib/sequences/steps.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sequences/steps.js src/lib/sequences/steps.test.js src/lib/sequences/scheduler.js
git commit -m "feat(automations): glofox_provision step executor + scheduler wiring"
```

---

## Task 4: `triggerSequencesForContactCreated` dispatcher

**Files:**
- Modify: `src/lib/sequences/triggers.js`
- Modify: `src/lib/sequences/triggers.test.js`

- [ ] **Step 1: Verify there is no restrictive CHECK on the enrolment source_type**

Run: `grep -rn "source_type" supabase/migrations/ | grep -i "check\|sequence_enroll"`
Expected: no CHECK constraint that restricts `sequence_enrollments.source_type` to a fixed list (it's free-text; `membership_state_change` shipped as a value without a migration). If a restrictive CHECK *does* exist, STOP and flag it — a migration adding `'contact_created'` would be required (out of this task's assumption).

- [ ] **Step 2: Write the failing tests**

In `src/lib/sequences/triggers.test.js`, add this `describe` block (it reuses the file's existing `mockDb` helper + mocked `createServerClient`/`enrolContacts`/`contactMatchesSequenceAudience`/`logWarn`):

```js
describe('triggerSequencesForContactCreated', () => {
  it('does nothing when no contactId is given', async () => {
    await triggers.triggerSequencesForContactCreated(null)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('enrols the contact into each matching active contact_created sequence', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 'seq-1', audience_filter: null }] },
    }))
    await triggers.triggerSequencesForContactCreated('c1')
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      contactIds: ['c1'],
      sourceType: 'contact_created',
      sourceRef: 'created',
    })
  })

  it('skips contacts that do not match the sequence audience', async () => {
    contactMatchesSequenceAudience.mockResolvedValue(false)
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: { id: 'c1', location_id: 'loc-1' } },
      email_sequences: { list: [{ id: 'seq-1', audience_filter: { foo: 'bar' } }] },
    }))
    await triggers.triggerSequencesForContactCreated('c1')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('does nothing when the contact is not found', async () => {
    createServerClient.mockReturnValue(mockDb({
      contacts: { single: null },
    }))
    await triggers.triggerSequencesForContactCreated('missing')
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('never throws if the db read fails', async () => {
    createServerClient.mockReturnValue({ from: () => { throw new Error('boom') } })
    await expect(triggers.triggerSequencesForContactCreated('c1')).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/sequences/triggers.test.js -t "triggerSequencesForContactCreated"`
Expected: FAIL — `triggers.triggerSequencesForContactCreated is not a function`.

- [ ] **Step 4: Implement the dispatcher in `triggers.js`**

Append to `src/lib/sequences/triggers.js` (the imports `createServerClient`, `logWarn`, `contactMatchesSequenceAudience`, `enrolContacts` already exist at the top of the file):

```js
// ── contact_created ──────────────────────────────────────────────

/**
 * Called from the interactive lead-creation sites (manual POST /api/contacts,
 * the website POST /api/public/leads form, and the assistant create_contact
 * tool) right after a NEW contact row is inserted. Enrols the contact into
 * every active sequence with trigger_type='contact_created' whose
 * audience_filter the contact matches.
 *
 * Deliberately NOT wired into bulk-import or Glofox-sync (the mass-create
 * guard) — same scoping as the curated glofox_lead_provisioning hook.
 *
 * Best-effort — errors swallowed + logged so it can never fail the upstream
 * contact insert.
 *
 * @param {string} contactId
 */
export async function triggerSequencesForContactCreated(contactId) {
  if (!contactId) return
  const db = createServerClient()
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('id, location_id')
      .eq('id', contactId)
      .single()
    if (!contact) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, audience_filter')
      .eq('location_id', contact.location_id)
      .eq('trigger_type', 'contact_created')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const matches = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'contact_created',
        sourceRef: 'created',
      })
    }
  } catch (e) {
    logWarn('sequences', `contact_created trigger failed for ${contactId}`, { err: e })
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/sequences/triggers.test.js -t "triggerSequencesForContactCreated"`
Expected: PASS (all five cases).

- [ ] **Step 6: Run the whole triggers suite + commit**

Run: `npx vitest run src/lib/sequences/triggers.test.js`
Expected: PASS.

```bash
git add src/lib/sequences/triggers.js src/lib/sequences/triggers.test.js
git commit -m "feat(automations): triggerSequencesForContactCreated dispatcher"
```

---

## Task 5: Fire the trigger from the three interactive lead-create sites

**Files:**
- Modify: `src/app/api/contacts/route.js`
- Modify: `src/app/api/public/leads/route.js`
- Modify: `src/app/api/assistant/chat/route.js`

**Context:** each site already dynamic-imports + calls `maybeProvisionLeadInGlofox` right after inserting the new contact. Add the `contact_created` dispatch immediately after that call, matching each site's await style (the contacts route is fire-and-forget / no `await`; the other two `await`). Use the same dynamic-import style the file already uses for `maybeProvisionLeadInGlofox`.

- [ ] **Step 1: Wire `src/app/api/contacts/route.js`**

Find (around line 88):

```js
    const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
    maybeProvisionLeadInGlofox({ db, locationId: data.location_id, contact: data, source: 'manual' })
```

Add immediately after:

```js
    // AUTOMATIONS Phase 1 — fire any custom contact_created automations (best-effort).
    const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
    triggerSequencesForContactCreated(data.id)
```

- [ ] **Step 2: Wire `src/app/api/public/leads/route.js`**

Find (around line 96):

```js
      const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
      await maybeProvisionLeadInGlofox({ db, locationId, contact: contactRow, source: 'website_lead' })
```

Add immediately after:

```js
      const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
      await triggerSequencesForContactCreated(contactRow.id)
```

- [ ] **Step 3: Wire `src/app/api/assistant/chat/route.js`**

Find (around line 102):

```js
        const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
        await maybeProvisionLeadInGlofox({ db, locationId, contact: data, source: 'assistant' })
```

Add immediately after:

```js
        const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
        await triggerSequencesForContactCreated(data.id)
```

- [ ] **Step 4: Verify the import path resolves the way the existing trigger callers use it**

Run: `grep -rn "from '@/lib/sequences/triggers'\|import('@/lib/sequences/triggers')\|sequences/triggers" src/app/api/public/book/route.js src/app/api/contacts/'[id]'/route.js`
Expected: shows how booking/tag triggers are imported elsewhere. If existing callers import from a different specifier (e.g. `@/lib/sequences` barrel), match that specifier instead in Steps 1–3.

- [ ] **Step 5: Run the affected route tests (if present) + lint + build**

Run: `npx vitest run src/app/api/contacts src/app/api/public/leads src/app/api/assistant`
Expected: PASS (existing tests still green — the new dynamic import resolves and doesn't change response shape).

Run: `npm run build`
Expected: build succeeds — this is the only gate that catches an unresolved `import('@/lib/sequences/triggers')` (vitest mocks imports; Turbopack does not).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/contacts/route.js src/app/api/public/leads/route.js src/app/api/assistant/chat/route.js
git commit -m "feat(automations): fire contact_created trigger from the 3 lead-create sites"
```

---

## Definition of done (run the full CI mirror before opening the PR)

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build
```

All green. No migration, no `shared/permissions.js` change (no new permission key — authoring stays gated by the existing `automations` permission; this is engine-only), so mobile-parity is unaffected.

**What this delivers:** an operator-authored automation whose graph is `trigger: contact_created → node: glofox_provision` will, once such a sequence exists and is active, enrol every newly-created interactive lead and create them in Glofox with the trial on the next cron tick — entirely through the existing engine. Nothing is selectable in the builder UI yet (Phase 2) and nothing is re-homed (Phase 3); Phase 1 is mergeable dark.

---

## Self-review

**Spec coverage (Phase 1 items):**
- `glofox_provision` action step (spec §"What gets built" 1) → Tasks 1 + 3. ✓
- `contact_created` trigger (spec item 2) → Tasks 2 + 4 + 5. ✓
- "wire the trigger into the 3 lead-create sites" (spec item 2) → Task 5. ✓
- "tests" → every task is TDD. ✓
- "No IA change yet" → builder pickability + rebrand explicitly deferred (Out of scope). ✓
- Reuses the vetted `findOrCreateGlofoxMember` with `source:'automation'` (already CHECK-valid via mig 277) → Task 3. ✓
- Mass-create guard (not wired into import/sync) → stated in Task 4 docstring + Out of scope. ✓
- `validateGraph` knows the new types (spec item 3, the validation half) → Tasks 1 (node) + 2 (trigger). The **AI agent** half of item 3 is correctly deferred to Phase 2.

**Placeholder scan:** none — every code step shows complete code; every run step has an exact command + expected result. The two "match the existing specifier/style" steps (5.4, and the await-style note) are verification-against-reality steps, not unfilled blanks.

**Type/name consistency:** `glofoxProvisionStep(db, { contact, sequence, _findOrCreateGlofoxMember })` is defined in Task 3 and called identically in the scheduler (Task 3) and tests. `triggerSequencesForContactCreated(contactId)` is defined in Task 4 and called identically in Task 5. `'glofox_provision'` and `'contact_created'` string literals are consistent across schema/validate/view/edit/steps/scheduler/triggers/API. `enrolContacts({ sequenceId, contactIds, sourceType, sourceRef })` matches the existing dispatchers' call shape. `findOrCreateGlofoxMember({ db, locationId, contact, source, createIfMissing, attachTrial })` matches its real signature.
