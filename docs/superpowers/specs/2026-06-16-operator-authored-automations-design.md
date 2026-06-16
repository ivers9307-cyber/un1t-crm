# Operator-Authored Automations — Design (north star + phased decomposition)

**Status:** approved in design dialogue 2026-06-16. This is the **umbrella design** for letting the operator build and edit automations themselves. It is deliberately bigger than one implementation plan — §"Decomposition" breaks it into sub-projects, each of which gets its own spec/plan → build cycle. Phase 1 is the first shippable increment and is the one that goes to `writing-plans` next.

**Goal:** Give the operator one place — **Automations** — to build, edit, and run any "when X happens, do Y" automation themselves (no code), where Y can be **messaging** (email/SMS/WhatsApp) *or* **operational** (create in Glofox + trial, tag, move pipeline stage, create task, notify staff…), authored by **describing it in plain English and refining on a visual canvas**.

**Locked decisions (design dialogue):**
1. **Unify — rebrand Sequences → Automations.** One surface for everything that runs by itself. "Sequences" (the comms drip engine) and the curated `/automations` hub (PRs #544/#545) converge into a single **Automations** area. Sequences become one flavour of automation (the ones whose actions are messages).
2. **Authoring = AI-describe + visual edit.** Operator types intent → the existing "Build with AI" agent drafts the flow → operator reviews/tweaks on the existing flow-graph canvas → publish.

---

## The crucial context: the engine already exists

The Sequences engine is *already a general automation engine*. Verified in `src/lib/sequences/`:

- **Triggers** (`triggers.js` + `cron-triggers.js`): `manual`, `booking_created`, `pipeline_stage_change`, `tag_added`, `membership_state_change`, `event_reminder`.
- **Conditions**: `audience_filter` on every automation (the same whitelisted field/op registry as campaigns), enforced by `contactMatchesSequenceAudience`.
- **Action step types** (`scheduler.js` branch-by-`step_type`): `wait`, `email`, `sms`, `whatsapp`, **`apply_tag`, `update_field`, `internal_task`, `webhook`, `move_pipeline_stage`, `branch`**.
- **Execution**: enrolment model (`sequence_enrollments`) + cron runner (`/api/cron/run-sequences`, every 5 min), per-enrolment failure counting + auto-pause.
- **Builder**: visual flow-graph editor at `/communications/sequences/[id]` (recursive tree-of-lanes).
- **AI authoring**: "Build with AI" agent (`src/lib/sequences/agent/` + graph route) emits a graph from a prompt, self-corrects against `validateGraph`, writes a `draft_graph`, surfaces a **review banner that flags write steps**, then Publish.

So the visual builder, AI authoring, conditions, and operational action-execution are **already built**. The work is to (a) add the missing operational primitives + a new-lead trigger, (b) extend AI authoring + validation to know them, and (c) re-home/rebrand the whole thing as "Automations" so an operator reads it as "build any automation," not "send a drip."

DB note: the tables (`email_sequences`, `sequence_steps`, `sequence_enrollments`) **keep their names** — this is a UI/IA rebrand + capability extension, not a schema rename (same back-compat posture as the `lead_status → pipeline_stage_slug` rename, where the column/table internals stayed and only the surface changed). Lower risk, no data migration.

---

## Target model: everything is an automation

An **automation** = `{ trigger, conditions (audience_filter), action graph, enabled, location scope }` — which is exactly what an `email_sequences` row + its `sequence_steps` already are. The unification is conceptual + presentational, not a new data model.

- **Triggers** = the existing set **+ a new `contact_created`** ("a new lead is created") so the flagship "new lead → create in Glofox + trial" is authorable as an automation.
- **Actions** = the existing palette **+ operational primitives**, the first being **`glofox_provision`** (create the Glofox account + attach the studio trial), wrapping the *already-vetted* `findOrCreateGlofoxMember` create-and-trial path (idempotent, audits to `glofox_push_events`, never throws). Future action candidates (own phases): `notify_staff`, `enrol_in_automation`, `create_deal`.
- **Conditions** = the existing `audience_filter` (gate the whole automation) + `branch` nodes (in-flow conditionals).
- **The two existing entry styles converge:**
  - **Templates / simple toggles** — the curated `glofox_lead_provisioning` (PR #544/#545) stays as the "just turn it on" experience, presented in the Automations home as a **pre-built template** with an on/off toggle + the backfill button. (It keeps its synchronous lead-create hook — instant, not cron-delayed.)
  - **Custom automations** — operator-built flows (trigger → conditions → action graph), authored via AI + canvas. These run through the engine's trigger→enrolment→cron path.

---

## What gets built (capabilities)

1. **`glofox_provision` action step** (`steps.js` + `scheduler.js` branch): given the enrolment's contact, run the vetted Glofox create-and-trial primitive at the contact's location. Reuses `findOrCreateGlofoxMember({createIfMissing:true, attachTrial:true, source:'automation'})` — idempotent, audited, never-throw; failures surface in the existing Glofox Review queue (`/admin/glofox-import`). Config: none required (uses the location's trial config); optional override later.
2. **`contact_created` trigger** (`triggers.js`): fire on new-lead creation. Reuse the three lead-create hook sites already wired for the curated automation (`/api/contacts`, `/api/public/leads`, assistant `create_contact`) to call `triggerSequencesForContactCreated(contactId)`, mirroring the existing best-effort, never-throw trigger dispatchers. Honour `audience_filter` per the existing `contactMatchesSequenceAudience` reachability check.
3. **`validateGraph` + AI agent extensions**: teach the graph validator and the "Build with AI" system prompt about the new trigger + operational action(s), their required config, and their safety semantics, so a prompt like *"when a new lead comes in, create them in Glofox with a trial and tag them 'new-lead-auto'"* produces a valid, publishable graph. Operational/write actions ride the existing **review-banner-before-publish** gate.
4. **IA unification (the rebrand)**:
   - **`/automations` is the home** for all automations: a list of (a) pre-built **templates** (curated toggles, incl. the Glofox one) and (b) **custom automations** (the flows, formerly "sequences"), with a **"Build an automation"** entry (AI-describe + canvas).
   - The flow-graph editor moves to **`/automations/[id]`**; `/communications/sequences/*` **redirect** to the new paths (retirement-to-redirect, the same pattern Pillar 2 used for the broadcast pages).
   - **Terminology**: "Sequence" → "Automation" / "Flow" in the UI only (DB names unchanged). Triggers/steps keep internal names.
   - **Nav**: the existing "Automations" sidebar section becomes the home; retire the "Communications → Sequences" entry. Clean conceptual split: **Communications = manual/ad-hoc sends + inbox; Automations = anything that runs by itself.**
5. **Safety + permissions**:
   - Authoring gated by the `automations` permission (owner/manager/master), the one already shipped.
   - Operational/write actions flagged in the AI review banner; operator must confirm before publish.
   - **Bulk guardrail**: enrolling an automation against an existing audience (vs. forward-only on trigger) reuses the **confirm-with-count + throttle + idempotent** pattern from the Phase-2 backfill — no automation can silently mass-act on thousands.
   - Every operational action is a **vetted, server-implemented primitive** (safe-list). Operators wire/configure; they never write code or call arbitrary endpoints (the existing `webhook` step stays manager-gated and URL-validated).
6. **Observability**: a per-automation **run history** (reuses `sequence_enrollments` + the send/▷action records) so the operator can see what fired, for whom, and the outcome; operational-action failures link to their review surface (Glofox Review for `glofox_provision`).

---

## Decomposition (sub-projects — each its own spec/plan → build)

Ordered so each ships working, testable software and de-risks the next. **Phase 1 is what goes to `writing-plans` next.**

- **Phase 1 — Engine capability: `glofox_provision` action + `contact_created` trigger.** Add the operational action step + the new trigger to the existing engine (steps.js/scheduler.js/triggers.js + validateGraph), wire the trigger into the 3 lead-create sites, tests. *No IA change yet* — this makes the engine able to express "new lead → create in Glofox + trial" as a flow. Lowest-risk, highest-leverage; everything else builds on it. Shippable on its own (new capability, unused until an automation uses it).
- **Phase 2 — AI authoring + validation for operational flows.** Extend the "Build with AI" agent + `validateGraph` to know the new trigger/action(s); ensure the review-banner flags `glofox_provision`. Operators can now *describe* an operational automation and get a valid draft. Shippable behind the existing builder.
- **Phase 3 — IA unification (the rebrand).** `/automations` becomes the home listing templates + custom automations; flow editor at `/automations/[id]`; `/communications/sequences/*` → redirects; "Sequence" → "Automation" terminology; nav consolidation. The biggest *surface* change; pure re-homing of a working engine (back-compat redirects, DB unchanged).
- **Phase 4 — Templates gallery + run history.** Curated automations presented as installable/cloneable **templates** (Glofox provisioning, win-back, etc.); per-automation **run history** view. Polishes the "operator self-serve" experience.
- **Phase 5 (optional, demand-driven) — more operational actions + guardrail hardening.** `notify_staff`, `enrol_in_automation`, `create_deal`; per-action bulk-confirm; finer permissions on which actions an operator may wire.

Each phase is independently shippable and reversible. Phases 1–2 are pure additive engine work (safe to merge dark). Phase 3 is the visible rebrand. Build in order; re-validate scope at each phase's own spec.

---

## Out of scope (explicit)
- **Arbitrary/code automations.** Operators compose from a vetted action palette only — never raw code or arbitrary HTTP beyond the existing manager-gated `webhook` step.
- **DB table renames.** `email_sequences`/`sequence_steps`/`sequence_enrollments` keep their names; the rebrand is UI/IA + capability only.
- **Replacing the curated Glofox automation.** The shipped `glofox_lead_provisioning` toggle + backfill stays (it's the instant, synchronous "simple" path); the `glofox_provision` *action* is the building block for *custom* flows. They coexist.
- **Cross-tenant / org-level automations.** Per-location, like everything else.

## Open questions for Phase-3 (resolve in that phase's spec, not now)
- Do the existing comms sequences re-home under a single "Automations" list, or a tabbed "Automations | (Messaging) Flows" split? (Lean: one list, filterable by trigger/action type.)
- Does the curated `glofox_lead_provisioning` toggle eventually get *re-expressed* as a template-flow (so there's one model), or stay a bespoke hook indefinitely? (Lean: keep the hook for instant firing; offer an equivalent template for those who want to edit it.)

---

## Self-review
- **Placeholders:** none — every capability names the concrete file/step/trigger it extends; future actions are explicitly deferred to Phase 5.
- **Consistency:** the unification (decision 1) + AI authoring (decision 2) are reflected throughout; "keep DB names, rebrand UI" is stated once and held. The curated hub (PR #544/#545) is reconciled (templates) rather than contradicted.
- **Scope:** explicitly too big for one plan → decomposed into 5 phases, Phase 1 marked as the next `writing-plans` target. Each phase is a coherent, shippable unit.
- **Ambiguity:** "build automations" pinned to "compose from a vetted trigger/condition/action palette via AI + canvas," NOT arbitrary code (out-of-scope says so). The Sequences↔Automations relationship is pinned to "rebrand/unify, engine unchanged, DB names unchanged."
- **Safety:** operational actions reuse vetted primitives + review-banner + bulk-confirm; authoring is permission-gated; `webhook` stays the only general escape hatch and remains manager-gated.
