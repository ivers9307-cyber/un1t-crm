# Mia: move an event entry through approvals (EVENT-MOVE.7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can ask Mia (the WhatsApp/Instagram agent) to move their event entry to another date; Mia offers the eligible options, files an approval card, and when staff approve, the move runs on the shared function with `actor_type = 'agent'`.

**Architecture:** Two new agent tools in `src/lib/agent/event-tools.js`: `list_event_move_options` (read-only; the same eligibility as staff's `listMoveTargets`, filtered to what a customer may see: no capacity numbers, only events with room for the entry, with the price difference) and `move_event_entry` (never direct: inserts an `agent_membership_requests` row of a new kind `event_move`, pending, and notifies approvals). The approvals executor (`PATCH /api/agent/membership-requests/[id]`) gains an `event_move` branch calling `moveRegistration` with the approving staff member recorded in the actor name; decline sends the existing decline notice. Mig 711 widens the `kind` CHECK.

**Tech Stack:** Postgres CHECK change, agent tool definitions (Anthropic Messages API tool schemas), Next.js route branch, vitest.

**Worktree:** `~/code/un1t-crm-evmove7`, branch `mia-move-event-entry`, off `origin/main`.

**Facts (verify by reading):** `reschedule_event_wave` definition `event-tools.js:108-125`, handler `:511-569` (same-event only; ownership via `linkedAccountsForContact`; logs `kind:'event_booking'`); `get_my_event_registrations` `:352-387` (how the customer's registrations are found); `logEventRequest` `:630-647` inserts `agent_membership_requests { location_id, contact_id, kind, channel, conversation_id, details, status }`; kinds CHECK in mig 369 (`pause, cancellation, class_booking, consultation, class_cancellation, event_booking, event_cancellation, membership_purchase`), statuses mig 568; draft pattern = insert `status:'pending'` then `notifyAgentApprovalRequest(db, { requestId, locationId, kind, customerName, summary })` (`./approval-notify`); executor `src/app/api/agent/membership-requests/[id]/route.js` (`EXECUTING_KINDS` in `src/lib/agent/request-recovery.js:23`; `event_cancellation` branch `:178-200` is the model: do the thing, then `sendAgentThreadMessage` with a confirmation text builder); `moveRegistration` / `listMoveTargets` in `src/lib/registration-move.js` (`allowedEventIds`, `actor`, `notify`, `expectedSourceEventId`; refuses `pending_payment` since EVENT-MOVE.4); the approvals UI reads `details` to render a card (`src/lib/approvals/providers/` for `agent_requests`: find how `event_cancellation` is summarised and mirror it).

**House rules:** NEVER surface capacity or counts to a customer (the options tool returns only name, date, time label, and a price-difference sentence); customer copy: low-key, no em-dashes, no emoji; Mia invents tools unless told a convention is not one, so the tool descriptions must say exactly when to use them; every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Migration 711

`supabase/migrations/711_agent_requests_event_move.sql`: replace the `agent_membership_requests` `kind` CHECK (drop by its constraint name from mig 369, re-add with `event_move` appended), with a header comment (WHY: Mia moves entries through approvals; WHAT: one new kind; safe to apply early). Add `event_move` to `EXECUTING_KINDS` in `src/lib/agent/request-recovery.js` and to any kind list in `src/lib/approvals/providers/` that filters cards. Tests: the existing migration guard tests + a unit test that `EXECUTING_KINDS` includes it. Commit `EVENT-MOVE.7 — mig 711: agent request kind event_move`.

### Task 2: Tools

In `src/lib/agent/event-tools.js`:
- `list_event_move_options({ registration_id })`: ownership check as `reschedule_event_wave`; refuse unless status is `confirmed` (an unpaid entry answers "pay first" wording); calls `listMoveTargets(db, { registrationId, allowedLocationIds: null })` and maps each target to `{ event_id, name, date_label, times: [{ wave_id, label }] (only waves with `spots_left === null || spots_left >= headcount`), price_difference_sentence }` where the sentence is "same price" / "€X more per person" / "€X less per person, not refunded"; events with no eligible time are dropped. NEVER include `spots_left`, capacity or counts. Tool description: "Use when a customer asks to change the date or event of an existing event entry. Shows the dates they can move to. Do not promise the move; it needs staff approval."
- `move_event_entry({ registration_id, target_event_id, target_wave_id, note })`: ownership + `confirmed` check; validates the target is in the options (re-run the options logic); inserts `agent_membership_requests` kind `event_move`, `status:'pending'`, `details: { registration_id, source_event_id, source_event_name, target_event_id, target_event_name, target_wave_id, target_wave_label, headcount, price_gap_cents, entry_label, note }`; `notifyAgentApprovalRequest` with summary "Move <entry label> from <A> to <B>"; returns a result telling Mia to say the request is with the team and they will confirm (and to mention the difference when positive: "the team will send a link for the difference", matching EVENT-MOVE.5). Tool description says it files a request, never moves directly.
- Update `reschedule_event_wave`'s description: a different event is `move_event_entry`, not "cancel + rebook".
- Register both in the tools array and in Mia's system prompt tool guidance if tools are listed there (grep for `reschedule_event_wave` across `src/lib/agent/`).
Tests: `src/lib/agent/event-tools*.test.js` style; cover ownership refusal, unpaid refusal, options shape (and that no key named spots/capacity/count exists in the output), request row shape, and the target-not-in-options refusal.
Commit `EVENT-MOVE.7 — Mia tools: list_event_move_options, move_event_entry (approval)`.

### Task 3: Executor + card

- `PATCH /api/agent/membership-requests/[id]`: `event_move` branch: `moveRegistration(db, { registrationId: details.registration_id, targetEventId, targetWaveId, expectedSourceEventId: details.source_event_id, actor: { type:'agent', id: null, name: \`Mia, approved by ${user.full_name || user.email}\` }, notify: true, force: false })`. On `ok`: `sendAgentThreadMessage` with a short confirmation ("Done, your entry is now on <B>, <date> <time>. New tickets are on their way by email." plus, when `price_gap_cents > 0`, "The team will send a link for the €X difference."). On refusal: status `failed`, `details.failure = error`, a thread message "We could not move your entry: <plain message>. The team will be in touch." Decline: existing decline notice. Mirror the `event_cancellation` branch's structure, error handling and tests.
- Approvals card: wherever `event_cancellation` requests are summarised for the approvals UI (web + the `agent_requests` provider), add `event_move`: "Move <entry> from <A, date> to <B, date time>" with the difference line. Tests.
Commit `EVENT-MOVE.7 — approvals execute an event_move; card summary`.

### Task 4: Gate, PR
Full CI mirror + build; PR `EVENT-MOVE.7 — Mia moves an event entry through approvals` leading with "🔴 Apply mig 711 before merging"; changelog entry; memory note: the Mia audit file's tool list.
