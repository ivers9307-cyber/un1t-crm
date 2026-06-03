# Sequencing & Communication Automation — Redesign Design

**Date:** 2026-06-03 · **Status:** approved design, pre-implementation · **Author:** brainstorming session (operator + Claude) · **Method:** full code audit of the sequencing stack + collaborative design.

> Companion planning doc. On approval of the implementation plan, Phase 1 ships first. This is the **center of member + lead nurturing**, so the bar is: powerful, legible, easy, and future-proof for an AI agent to author flows.

---

## TL;DR — the reframe

**We are not rebuilding the automation engine. We're replacing a 1990s cockpit on a genuinely strong engine.**

The audit found the backend automation engine (`src/lib/sequences/*`) already supports ~10 triggers and 10 step types — including field writes, branching, outbound webhooks, inactivity/anniversary, and segment entry/exit. The operator's feeling that the platform "can't freely automate data" and "feels restricted / old-fashioned" is **not an engine limitation** — it's the editor: a 1,516-line linear-list form where branches are typed as *step numbers* ("then → step 4"), so you can never see the journey.

The redesign (3 pillars, build order chosen by the operator):

1. **Visual flow builder** *(build first)* — a guided vertical-rail canvas over a new declarative node-graph. Branches fork into visible YES/NO lanes; you see the whole flow.
2. **Unified ad-hoc send** *(next project)* — one channel-aware surface for "message off the cuff" (one person or a segment) with a bridge into a flow. Ends the 5-surface scatter.
3. **Agent-authorable graph** *(foundation laid now)* — the flow is one declarative graph + a shared validator, so a future AI agent generates flows from a natural-language ask the same way a human drags them.

**This document covers Pillar 1 + the Pillar 3 foundation.** Pillar 2 (unified send) is a separate design once the builder lands.

---

## Decisions locked this session

| # | Decision | Choice |
|---|----------|--------|
| Build order | What ships first | **Flow builder first** (it's the biggest visible win *and* lays the agent-ready graph foundation) |
| Canvas feel | Free node canvas vs guided rail | **Guided vertical rail** (Customer.io/ActiveCampaign-style) — modern + legible for non-technical staff + renders an agent-built flow cleanly. (Free canvas rejected: invites spaghetti, intimidates.) |
| Agent model | How agent-built flows land | **Draft for review** — agent assembles → lands as a draft on the canvas → operator reviews/tweaks → operator publishes. Never sends a real member message unreviewed. **Tiered auto-publish is a later config flip, no rework.** |
| Engine | Rebuild vs reuse | **Reuse, untouched.** The graph compiles to the existing `sequence_steps` that the proven runner already executes. |

---

## Audit — current state

### The engine already does this (the buried power)

`src/lib/sequences/` is a capable marketing-automation engine, comparable to the core of HubSpot/ActiveCampaign workflows:

- **Triggers** (`triggers.js`, `cron-triggers.js`): `manual`, `booking_created`, `pipeline_stage_change`, `tag_added`, `event_reminder`, `segment_added`, `segment_removed`, `anniversary` (N days after any date field), `inactivity` (win-back), inbound `webhook`, plus `race_registered`, `race_finished`, `order_status`, `first_booking`, `achievement`.
- **Step handlers** (`steps.js`): `email`, `whatsapp`, `sms`, `wait`, `apply_tag`, `update_field` (writes a contact field), `internal_task` (creates a task), `webhook` (outbound POST/PUT/GET…), `branch` (if/else on a predicate), `move_pipeline_stage`.
- **Audience gating** (`audience.js`), **cooldowns** (`cooldown.js`), **segment sync** (`segment-sync.js`), **scheduling** (`scheduler.js`). Well-modularised and unit-tested.

### Why it *feels* restricted and old-fashioned

1. **Linear list + number-pointer branching** (`SequenceEditor.jsx`, 1,516 lines). Steps are an ordered list with ↑/↓ arrows. A `branch` step routes by typing the destination **step number** into `then_step_order` / `else_step_order` integer inputs. You cannot see the journey or where a branch goes — you hold it in your head. **This is the #1 "old-fashioned" smell.**
2. **Everything is a `<select>` + a giant inline conditional form.** Add-step = pick from a 10-item dropdown, then a big per-type form appears inline in a single monolith. No discoverability of what's possible; no view of the flow's shape.
3. **No flow-level validation or preview.** A branch pointing at a wrong/looping step number surfaces only as a runtime error, not a visible flag.
4. **Ad-hoc messaging is a separate, fragmented world** (the operator's second core job). "Message off the cuff" lives in 5+ disconnected places: the per-contact composer (`ContactComposer`), the WhatsApp inbox, the Instagram inbox, WhatsApp broadcasts, email campaigns, SMS broadcasts. No single "message this person/segment now on the best channel" surface, and no bridge to "…and start a flow."
5. **IA sprawl + a half-finished move.** The sequence list moved to `/communications/sequences` but the editor still lives at `/email/sequences/[id]` (Phase-1.5 never finished). Templates exist in two places.

### Existing data model (mig 005, extended)

- `email_sequences` — `id, location_id, name, description, trigger_type, trigger_config JSONB, active, …`
- `sequence_steps` — `id, sequence_id, step_order, delay_*, step_type, channel content, template_id, branch config (then/else step_order)`. **Execution artifact.**
- `sequence_enrollments` — `sequence_id, contact_id, current_step_order, status, next_step_at, …`. **In-flight runtime state — must not be disrupted.**

---

## Architecture — one graph, two authors, untouched engine

```
   You (guided-rail builder)        AI agent (later, builds from your ask)
                 \                            /
                  \   both write the same    /
                   ▼                        ▼
         ┌──────────────────────────────────────────┐
         │  FLOW GRAPH  — nodes[] + edges[]           │   ← single source of truth
         │  JSONB · versioned · draft / published     │     for editing + agent
         └──────────────────────────────────────────┘
                          │ on publish
              ┌───────────┴───────────┐
              ▼                       ▼
     validateGraph()          compileGraphToSteps()
   (shared: builder red-flags,   (graph topology →
    agent self-correct,           step_order + then/else)
    publish gate)                       │
                                        ▼
                          🗄️  sequence_steps  (UNCHANGED table)
                                        │
                                        ▼
                     🏎️  existing runner — scheduler.js / steps.js (UNTOUCHED)
```

The graph is the source of truth for **editing and agent authoring**. The compiled `sequence_steps` remain the **execution** artifact. The runner never changes. Existing live sequences get a one-time `decompileStepsToGraph()` backfill so they render in the new builder; their in-flight enrolments keep running on the steps they already have.

**Why this shape:** maximal de-risk (the money path — sending real member messages — is untouched), one schema serves human + agent, validation is written once and shared by all three consumers (builder, agent, publish).

---

## The node-graph model

### Storage

A new `graph JSONB` column on `email_sequences` (+ `graph_version INT`, + a `draft`/`published` lifecycle — see Migration). The graph is the canonical editable representation; `sequence_steps` is regenerated from it on publish.

### Shape

```jsonc
{
  "version": 1,
  "trigger": { "type": "booking_created", "config": { "event_type_id": "…" } },
  "nodes": [
    { "id": "n1", "type": "wait",     "config": { "days": 0, "hours": 1 } },
    { "id": "n2", "type": "whatsapp", "config": { "template_id": "…", "variables": { } } },
    { "id": "n3", "type": "wait",     "config": { "days": 2 } },
    { "id": "n4", "type": "branch",   "config": { "predicate": { "type": "has_tag", "tag": "attended" } } },
    { "id": "n5", "type": "email",    "config": { "subject": "How was your first session?", "template_id": "…" } },
    { "id": "n6", "type": "sms",      "config": { "body": "We saved your spot — come back this week" } }
  ],
  "edges": [
    { "from": "trigger", "to": "n1" },
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n3" },
    { "from": "n3", "to": "n4" },
    { "from": "n4", "to": "n5", "label": "yes" },
    { "from": "n4", "to": "n6", "label": "no" }
  ]
}
```

- **`trigger`** — exactly one entry (mirrors the existing `email_sequences.trigger_type/trigger_config`). Edges from the reserved source id `"trigger"`.
- **Node** — `{ id (stable string), type (the step vocabulary), config (per-type) }`. No `step_order` — order is implied by edges.
- **Edge** — `{ from, to, label? }`. Linear nodes have one out-edge; `branch` has two (`label: "yes" | "no"`). A node with no out-edge is a terminal/exit.
- **Node-type catalogue** = the existing engine vocabulary, 1:1: `email · whatsapp · sms · wait · apply_tag · update_field · internal_task · webhook · branch · move_pipeline_stage`. New step types added to the engine later automatically become available nodes.

This JSON is **exactly** what the agent emits — the agent's "tool surface" is this schema. Stable string ids + explicit edges make it reliable for an LLM to generate and for `validateGraph` to check.

---

## Core lib functions (pure, fully unit-tested)

These live in `src/lib/sequences/graph/` and follow the codebase convention (branchy logic in tested pure modules; thin IO/JSX shells elsewhere).

### `validateGraph(graph) → { ok, errors[] }`

Shared by the builder (inline red flags), the agent (self-correct loop), and publish (hard gate). Structured, machine-readable errors:

- Orphan node (unreachable from `trigger`); node with no path forward where one is required.
- `branch` missing a `yes` or `no` out-edge; non-branch node with >1 out-edge.
- Edge to a non-existent node id; edge from a node that doesn't exist.
- Loop-guard violation (an edge that would re-enter an earlier node — mirrors the existing runner's `then/else > own order` rule).
- Missing/invalid required `config` per node type (e.g. `whatsapp` without a template, `update_field` writing a non-allowlisted field, `webhook` with a non-https url).
- Channel/consent sanity (e.g. a `whatsapp` node referencing a MARKETING template on a transactional trigger — reuse existing policy checks).

### `compileGraphToSteps(graph) → SequenceStepRow[]`

Topological walk from `trigger`; assigns `step_order`; for `branch`, derives `then_step_order` / `else_step_order` from the `yes`/`no` edges, preserving the runner's existing config contract. Deterministic (stable ordering) so re-compiles are diff-stable. Pure — returns rows; the route persists them.

### `decompileStepsToGraph(steps, trigger) → graph`

Inverse, for the one-time backfill + rendering legacy sequences: reads `step_order` + then/else pointers → emits nodes + edges. Round-trip tested (`compile(decompile(steps)) ≈ steps`).

---

## The builder (Phase 2 — guided rail)

Replaces `SequenceEditor.jsx` (1,516-line monolith) with a decomposed set built on the shared UI primitives (`Card`, `Button`, `Field`, `Modal`, `EmptyState`, `Loading`):

- **`FlowCanvas`** — renders the graph as a vertical rail: trigger at top, nodes stacked, a `+` insert affordance between every node, branch nodes split into labelled **YES / NO** lanes (auto-layout from the graph — nothing to misalign).
- **`FlowNode`** — a node card: channel-colored accent, icon, title, one-line summary; click to open its config.
- **`NodeConfigPanel`** — a focused side/sheet panel per node type (not a giant inline form). Per-type editors (`EmailNodeConfig`, `WhatsAppNodeConfig`, `BranchNodeConfig`, `WaitNodeConfig`, …), each small and independently testable.
- **Live validation** — `validateGraph` runs on edit; errors surface inline on the offending node + a publish-blocking summary.
- **Draft → Publish** — editing mutates the draft graph; **Publish** runs validate + `compileGraphToSteps` + persists steps (the only moment execution changes).
- **Route** — canonical `/communications/sequences/[id]`; redirect stubs from `/email/sequences/*` (finishes the half-done move).

---

## Agent foundation (Phase 3 — contract now, NL agent later)

Built now so the agent slots in with zero rework:

- **Schema** — the canonical graph JSON above (documented, versioned). This *is* the agent's write contract.
- **Write endpoint** — `PUT /api/sequences/[id]/graph` accepts a full graph, runs `validateGraph`, saves as the **draft** graph. Reused by the builder's save. The future agent writes here too.
- **Draft lifecycle** — a flow can hold an unpublished draft graph distinct from the live (compiled) steps; "Publish" promotes it.
- **Review flagging** — nodes that **write data or call outside the platform** (`update_field`, `webhook`, `move_pipeline_stage`, `apply_tag`) are visually flagged in the review so an agent-drafted flow never slips a side effect past the operator.
- **Later (separate project):** an `/agent` endpoint: natural-language ask → emit graph → `validateGraph` self-correct loop → save draft → open in builder. Tier-C auto-publish = a per-sequence/agent config flag.

---

## Migration & backwards-compatibility

1. Add `graph JSONB` + `graph_version` (+ draft fields) to `email_sequences`. Nullable; no behaviour change on deploy.
2. One-time backfill: `decompileStepsToGraph` for every existing sequence → populate `graph`. Idempotent, reversible (steps are untouched).
3. The new builder reads `graph`; **Publish** recompiles steps. In-flight `sequence_enrollments` keep running on their existing steps — **zero disruption to live journeys**.
4. Ship Phases 1–2 behind a flag / on the new route; dogfood; cut the editor over; retire `SequenceEditor.jsx`.
5. The runner (`scheduler.js`, `steps.js`) is **never modified**.

---

## Phasing → implementation plan

- **Phase 1 — Foundation (invisible).** Graph schema + `validateGraph` + `compileGraphToSteps` + `decompileStepsToGraph` in `src/lib/sequences/graph/` with thorough unit tests (round-trip, every validation branch). Migration: `graph` column + backfill. No UI. *Lowest risk, highest leverage; everything else builds on it.*
- **Phase 2 — Builder (the visible win).** `FlowCanvas` + `FlowNode` + `NodeConfigPanel` + per-type editors; live validation; Publish path; canonical route + redirects; retire the monolith.
- **Phase 3 — Agent contract.** `PUT …/graph` + draft lifecycle + review flagging. (NL agent itself = a later project.)
- **Then — Pillar 2:** unified ad-hoc send (its own design doc).
- **Then — the deferred 4 roadmap items** (win-back/dunning content, analytics/BI, member NPS, onboarding journey) — explicitly parked until the sequencing review lands, per the operator.

---

## Testing strategy

- **Phase 1** is pure functions → exhaustive unit tests (vitest), no DB. Round-trip `compile(decompile(steps)) ≈ steps`; every `validateGraph` error branch; deterministic compile ordering. This is where correctness is *proven*.
- **Phase 2** — per-type config editors are small + testable; the canvas is a thin renderer over the (tested) graph. Standard CI mirror + `next build` (new routes/components).
- **Phase 3** — route-level tests for the graph endpoint (validate-on-save, draft promotion).
- The runner keeps its existing test suite untouched (it doesn't change).

---

## Non-goals (this design)

- Rebuilding or extending the **automation engine** — it's reused as-is. (New triggers/step types are independent future work; they drop into the node catalogue automatically.)
- Building the **NL agent** itself — only its contract/foundation.
- **Pillar 2 (unified ad-hoc send)** — acknowledged + scoped as the next project, designed separately.
- A **free-form node canvas** — explicitly rejected in favour of the guided rail.

## Open questions (resolve during planning)

1. Graph storage: single `graph JSONB` column (chosen — simplest, agent-friendly, easy to draft/version) vs normalized `flow_nodes`/`flow_edges` tables (queryable but heavier). **Leaning JSONB**; revisit only if we need per-node querying.
2. Should Phase 1 + Phase 2 land as one push or two PRs? (Phase 1 ships invisibly and is independently valuable + low-risk → lean two.)
3. Draft storage: a second JSONB column (`draft_graph`) vs a status flag on a single graph. (Lean `draft_graph` + published `graph` for a clean "discard draft".)
