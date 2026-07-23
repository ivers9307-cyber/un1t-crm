# Hyrox Training Club — House style + example sessions ("train it on our style") — Design Spec

- **Date:** 2026-07-23
- **Status:** Draft for review (design approved conversationally)
- **Repo:** un1t-crm
- **Location:** Stillorgan (per-location; only Glofox-connected location today)
- **Builds on:** the shipped Hyrox Training Club (`src/lib/hyrox/*`, `/admin/hyrox`, the operator-editable `charter` on `locations.settings.hyrox`).

> Line numbers below come from the current tree and may drift — treat as "find near here", verify before editing.

---

## 1. Goal & scope

Make the AI generate Hyrox sessions in **UN1T's** style, not a generic one — "train it on how we run our classes." There is no model fine-tuning (the estate is Messages-API-only, no OpenAI, no weight training), so "training" here means **context engineering**: feed the generator UN1T's house style + real example sessions, so its output matches the gym's structure, formats, and coaching voice. It stays fully operator-editable.

### In scope (v1)
1. **Two new operator-editable fields** on `locations.settings.hyrox` (the JSONB the `charter` already lives on — **no migration**): `house_style` (a free-text playbook) and `style_examples[]` (exemplar sessions).
2. **Prompt injection** — a `styleBlock` folds `charter` + `house_style` into **both** the arc and session prompts, and the `style_examples` into the **session** prompt as few-shot, inside the prompt-cached stable prefix.
3. **Operator surface** — a "House style & examples" panel on `/admin/hyrox` (managers/coaches): edit the playbook, paste past sessions, remove examples. Saved via a new `PUT /api/hyrox/settings` route.
4. **"Save as style example"** — a button in the session review drawer that snapshots that session into `style_examples` (the "star as you go" half of seeding examples).
5. **Guardrails** — cap the number + length of examples fed to a generation; keep the no-em-dash rule; per-location scoping.

### Explicitly out of scope (YAGNI / later)
- **Approvals/edits feedback loop** — the generator drifting toward preferences from what coaches approve vs edit (a Phase-2 idea Richard deferred).
- **AI-distilled "style profile"** — having the model summarise the examples into a compact profile to save tokens. Prompt caching makes it unnecessary for v1; parked.
- **Fine-tuning / embeddings retrieval** — not available / overkill for a handful of examples.
- **Per-example activation UI beyond a simple cap** — v1 feeds the N most-recent examples; a full "pick which are active" manager is deferred.

---

## 2. Decisions locked (from the brainstorm)

| # | Decision | Choice |
|---|---|---|
| D1 | Mechanism | **Context injection** (house-style guide + few-shot examples), not fine-tuning. |
| D2 | Levers | **House-style playbook** + **real example sessions**. (Approvals-learning = Phase 2.) |
| D3 | Examples sourcing | **Both** — paste past hand-written sessions to seed now, AND "star" great generated sessions as exemplars over time. |
| D4 | Storage | Per-location `locations.settings.hyrox` JSONB (no migration); code defaults via `resolveHyroxSettings`. |
| D5 | Injection | house_style → arc + session prompts; examples → session prompt only; all prompt-cached. |

---

## 3. Data model (`locations.settings.hyrox`)

Extend the existing JSONB (no DDL). New keys alongside `charter`:

```jsonc
"hyrox": {
  "charter": "…",                 // existing — the quality bar
  "house_style": "…",             // NEW: free-text playbook (structure, cue language, formats, equipment, terminology, do/don't)
  "style_examples": [             // NEW: exemplar sessions, newest first
    {
      "id": "uuid",               // client-generated (crypto.randomUUID) for remove/dedupe
      "source": "pasted" | "generated",
      "label": "e.g. Wed engine session — great flow",
      "text": "…the session as coaching text…",
      "added_at": "ISO"
    }
  ]
}
```

- **Pasted** examples: `text` is the operator's pasted workout, as-is.
- **Starred (generated)** examples: `text` is the session rendered to a compact coaching-text block (from `full_session` + `board`), so every example is uniform plain text the model reads.
- `resolveHyroxSettings(loc)` (`src/lib/hyrox/settings.js`) extends to return `{ charter, houseStyle, styleExamples }` — `houseStyle` defaults to `''`, `styleExamples` to `[]`.

---

## 4. Prompt injection (`src/lib/hyrox/prompt.js`)

- New `styleBlock({ charter, houseStyle })` — returns the charter block plus, when non-empty, a `UN1T HOUSE STYLE (follow this — how this gym runs its classes):\n<houseStyle>` block. Used by **both** `buildArcPrompt` and `buildExpansionPrompt` (replacing the current `charterBlock`).
- `buildExpansionPrompt` additionally takes `styleExamples` and, when present, appends a **few-shot** block: `EXAMPLE SESSIONS in UN1T's style — match their structure, format, and coaching voice (do not copy them verbatim):\n\n<example 1>\n---\n<example 2>…`.
- **Caps** (guardrail): feed at most `MAX_STYLE_EXAMPLES` (e.g. 3) most-recent examples, each truncated to `MAX_EXAMPLE_CHARS` (e.g. 2500 chars). Keeps the prompt bounded.
- The whole style/charter/examples block is part of the **stable prefix**, so it rides the existing ephemeral `cache_control` (prompt caching) — repeated generations for the block don't re-pay for it.
- No-em-dash rule unchanged; house_style/examples are operator text (not member-facing), but the model is still told to keep member-facing strings em-dash-free.

The generation-driving code passes the resolved settings through: `createBlockWithArc` / `expandBlockWeek` / the expand + generate routes read `resolveHyroxSettings(loc)` (they already read `charter`) and thread `houseStyle` + `styleExamples` into the prompt builders.

---

## 5. Operator surface

**Panel on `/admin/hyrox`** (`HyroxPlanner.jsx`), a collapsible "House style & examples" section, visible to `canManage`:
- A **house style** textarea (prefilled from settings; blank = none).
- The **charter** textarea (moved here from the generate form, or shown alongside — it's the same operator-editable idea).
- An **example sessions** list: each row shows its label + a snippet + a remove (×); an "Add example" affordance opens a paste box (label + text) that appends a `source:'pasted'` entry.
- **Save** posts to `PUT /api/hyrox/settings`.

**New route `PUT /api/hyrox/settings`** (`src/app/api/hyrox/settings/route.js`) — mirror the settings-route skeleton (`src/app/api/settings/scoring/route.js`): `getCurrentUser` (401) → grant gate `hasPermissionForLocation(user, location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)` (403/404) → `validateBody` (Zod: `{ location_id, charter?, house_style?, style_examples?[] }`, examples capped in the schema) → read-modify-write `locations.settings.hyrox` (merge, never clobber sibling settings keys) → `{ success, data }`. Register in `openapi.js`.

---

## 6. "Save as style example" (star as you go)

In the review drawer (`HyroxPlanner.jsx`), a **"Save as style example"** button (managers/coaches). It renders the current session to a compact coaching-text block and appends a `source:'generated'` entry to `style_examples` via the settings route (or a thin `POST /api/hyrox/sessions/[id]/exemplar` that does the render server-side and appends). Server-side render keeps the text representation consistent — **recommended**: a small `sessionToExampleText(session)` pure helper (testable) + the `POST …/exemplar` route. Idempotency: dedupe by session id in the examples list so double-clicks don't duplicate.

---

## 7. Guardrails & build order

- **Caps:** `MAX_STYLE_EXAMPLES` fed per generation + `MAX_EXAMPLE_CHARS` per example (pure constants); the settings schema also caps stored count/length so the blob can't grow unbounded.
- **Per-location**; defaults keep an unconfigured location behaving exactly as today (charter default, no house style, no examples).

**Build order (single plan):**
1. `resolveHyroxSettings` extension + `sessionToExampleText` helper + tests (pure).
2. `styleBlock` + `buildExpansionPrompt` few-shot injection + caps + tests (pure).
3. Thread `houseStyle`/`styleExamples` through `generate-block.js` + the blocks/expand routes.
4. `PUT /api/hyrox/settings` + `POST /api/hyrox/sessions/[id]/exemplar` routes + openapi.
5. `/admin/hyrox` "House style & examples" panel + drawer "Save as style example" button.
6. CI mirror + build.

No migration; no new permission key (reuses `approvals_hyrox_sessions`). Verify with the real-model eval (`npm run eval:agent`) that a generation with a house-style + examples still parses and reflects the style before relying on it.
