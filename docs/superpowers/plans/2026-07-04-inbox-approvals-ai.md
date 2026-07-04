# Inbox Approvals Wave 3 — AI-Layer Next-Step Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After staff decide an approval in the inbox, an async Mia call (Anthropic Messages API) generates ONE bespoke suggested follow-up message, rendered as an extra "Mia suggests" step beside the rule-based playbook steps — click-to-prefill the composer, staff-reviewed, silent degradation to playbook-only.

**Architecture:** New POST `/api/agent/membership-requests/[id]/suggest` (location-staff auth copied from the conversation-scoped GET; 404 non-leak) loads recent conversation history (`formatHistoryForClaude`, ≤15 rows) + compact contact context, calls the house Anthropic pattern (`ANTHROPIC_API_KEY`, model `claude-sonnet-4-6`, max_tokens 300, `{error}|{text}` shape from `src/lib/agent/followups.js:268-303`), returns `{ success, suggestion }` or `{ success: true, suggestion: null }` on any model failure. `ApprovalActionCard` fires it fire-and-forget after a successful decide (and on mount for already-decided cards? NO — decide-time only, YAGNI), renders the result as one extra pill in the next-steps row. Gated on `locations.settings.customer_agent.enabled` + optional `inline_suggestion.enabled !== false`.

**Branch:** `feat/inbox-approvals-ai` off fresh origin/main (create at execution time).
**Spec:** Wave 3 section of `docs/superpowers/specs/2026-07-03-inbox-inline-approvals-design.md` (commit this plan file to `docs/superpowers/plans/2026-07-04-inbox-approvals-ai.md` on that branch as Task 0).

**Design decisions locked (from approved spec + Richard's answers):**
- Suggestion NEVER auto-sends and NEVER auto-prefills — it is a click-to-prefill step labelled "Mia suggests" (auto-prefill would clobber the decline draft the decline flow already places in the composer).
- Playbook steps render instantly and are never delayed/blocked by the AI call.
- Any failure (no key, timeout, HTTP error, empty text) = suggestion silently absent.
- Anthropic only (house rule). Reuse the followups.js call shape verbatim — do NOT introduce an SDK.

## Read-first invariants
- Service-role routes: authorize in app code; detail routes 404-not-403 (copy the PATCH sibling's checks incl. the uniform 404).
- supabase-js builders awaited; `{ success, ... }` response shape; no new console.log in prod paths (console.warn for skip-logs matches house style `[agent-...]`).
- Register the new route in `src/lib/openapi.js` ONLY if siblings are registered (grep first — Wave 1 found membership-requests unregistered; follow suit).
- Fire-and-forget side effects in their own try/catch.
- vitest `--pool=threads`.

### Task A1: suggestion composer lib (`src/lib/agent/approval-suggest.js`) + tests
Pure-ish lib: `buildSuggestionInstruction(kind, outcome, contactCtx)` (pure, unit-tested) + `composeApprovalSuggestion(db, row)` (loads history via the channel's messages table — `whatsapp_messages`/`instagram_messages` by `row.channel` — last 15, `formatHistoryForClaude` from `src/lib/agent/core.js`; loads contact fields `name, first_name, pipeline_stage_slug, glofox_membership_state, glofox_membership_plan, recent_bookings`; loads location + settings gate; calls the Anthropic fetch pattern copied from followups.js `composeAgentText` with a Wave-3 instruction; returns `{ text }` or `{ error }`).
Instruction shape (pure fn, tested): tells Mia the staff decision just made (kind + outcome + decision_note/reason), asks for ONE short warm follow-up message to the customer in her voice, first-person, no placeholders, ≤2 sentences, `[[SKIP]]` if nothing useful. Unit tests: instruction contains kind/outcome/name; SKIP + empty-text handling in a small pure `sanitizeSuggestion(text)` helper (strips, rejects `[[SKIP]]`, caps 500 chars).
TDD for the pure parts; the db/fetch orchestration is covered by route-level care (house has no DB tests).

### Task A2: POST `/api/agent/membership-requests/[id]/suggest/route.js`
Auth: `getCurrentUser` 401 → load row (`maybeSingle`) 404 → `getUserLocationIds` 404-non-leak (copy PATCH) → gate: row.status must NOT be 'pending' (suggestions are post-decision; 400 otherwise) → settings gate (`customer_agent.enabled` true AND `customer_agent.inline_suggestion?.enabled !== false`; if gated off return `{ success: true, suggestion: null }`) → `composeApprovalSuggestion` with an AbortController timeout of `inline_suggestion.timeout_ms ?? 5000` → on `{error}` return `{ success: true, suggestion: null }` + `console.warn('[approval-suggest]', ...)`; on text return `{ success: true, suggestion: text }`. Never a 5xx for model failures. `npm run check:route-guards` must stay green.

### Task A3: card integration (`src/components/ApprovalActionCard.jsx`)
New state `suggestion` (null) + `suggestLoading`. In `decide()` after `onDecided?.(...)`, fire-and-forget `fetchSuggestion()` (own try/catch; POST the new route; set state on success; never surface errors). Render: when `decided && suggestion`, append one pill to the next-steps row (create the row even when playbook steps are empty but a suggestion exists): label "Mia suggests", `type="button"`, same pill styling, distinguished with a subtle accent (e.g. `border-purple-500/40`); title/tooltip shows the first ~80 chars; onClick → `onPrefillComposer?.(suggestion)`. While `suggestLoading`, render a tiny muted "Mia is thinking…" text (no spinner dependency) that disappears on resolve — absent entirely on failure. No suggestion fetch on mount for already-decided cards (decide-time only).

### Task A4: settings toggle (operator-editable copy rule does NOT apply — this is an internal tool toggle, but the enable flag must exist)
In the `/settings/customer-agent` page, add an "Inline suggestion after approvals" toggle bound to `settings.customer_agent.inline_suggestion.enabled` (default ON when absent), following the page's existing followups/check-in toggle pattern (read the page; mirror one existing sub-feature block + its save path). No migration needed (JSONB settings).

### Task A5: CI mirror + build + changelog + PR
Full six-check mirror + `npm run build`; CHANGELOG entry; push; `gh pr create` (base main, no merge). PR body notes: no migration; gated by customer_agent.enabled + inline_suggestion.enabled; silent degradation.

**Review protocol:** per task, spec review then quality review (fresh subagents), fix loops, then final whole-branch review before the PR.
