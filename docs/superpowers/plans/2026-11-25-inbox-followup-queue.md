# Inbox Follow-up Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WhatsApp or Instagram thread a coach replied in is never forgotten: it waits, Mia may nudge it once, it comes back to "Needs reply", and only a coach completing it gives it back to Mia.

**Architecture:** New timestamp columns on both conversation tables record whose turn it is. One set of pure queue rules in `shared/` (thread + current time + studio follow-up config) decides queue, sort, chips and badge for web, phone and the count routes, so no sweep moves threads between queues. A new arm of the existing `agent-followups` cron sends Mia's one nudge. A `staff_owned_since` stamp keeps Mia silent on a coach's thread until a coach completes it.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes, forward-only SQL migration), vitest, Expo (mobile), Anthropic Messages API (Mia, unchanged).

**Spec:** `docs/superpowers/specs/2026-11-25-inbox-followup-queue-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Read `CLAUDE.md` and the `docs/rules/` file for any area before changing it (`data-access.md`, `supabase-traps.md`, `mobile.md`, `crons-webhooks.md`, `time-routing-forms.md`).
- Four pull requests, in order: Tasks 1-4, Tasks 5-6, Tasks 7-8, Task 9. Each branches off a fresh `origin/main` in its own git worktree (never the shared checkout), runs `npm ci` first, and adds `docs/changelog/entries/<PR>.md`. Commit messages: `INBOXFOLLOW.<pr> — summary`.
- The migration is applied with the Supabase MCP to project `iyvtbjjxdggiadzwwvdj` before PR 1 merges; run the security advisor after it. Check the next free migration number against `origin/main` on the day (874 when this was written).
- Every route uses `withAuth`, scopes by the conversation's own studio, and answers 404 for a thread the user cannot see. Client sessions never write the new columns.
- Destructure `error` from every write. A zero-row update is not an error; check the returned row when the code depends on it.
- No `'Europe/Dublin'` literal: zone maths through `@/lib/location-time` or `shared/zoned-time`.
- Mobile cannot import `src/lib`; shared code lives in `shared/` and is imported as `shared/…`.
- UI from `@/components/ui`; chips are `bg-<c>-500/10 text-<c>-700`; every non-submit button in a form has `type="button"`.
- Never trade a rare wrong value for a lost customer message: no new state may hide an inbound message.
- Mia sends nothing to the customer when a reply arrives on a coach's thread: no answer, no holding message.
- Values from the spec: quiet period default 48 h, allowed 4 h to 336 h; nudge grace 24 h after the quiet period; snooze note 140 characters; window chip amber under 4 h.
- Before pushing, run the CI mirror from `CLAUDE.md` once, then `npm run build`; never the full suite beside the build (8 GB machine).

## Review Focus

1. An inbound message arrives while a thread is snoozed: it must show in "Needs reply" with snooze cleared. (Task 3)
2. The customer replies between the nudge runner reading a candidate and sending: no nudge goes out. (Task 7)
3. A coach's thread whose last outbound is an automated reminder or Mia's nudge, 12-hour cooldown passed, customer writes: Mia stays silent and sends no holding line. (Task 4)
4. The studio changes its quiet period while threads are waiting: queues follow the new value at once; nothing stored goes stale. (Task 2)
5. A WhatsApp Business app echo of a coach's reply arrives late, after a newer inbound message: the thread stays in "Needs reply". (Task 3)

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/874_inbox_followup_state.sql` | Columns, indexes, backfill, grant note |
| `shared/inbox-queues.js` (+ test) | Pure queue rules, sort, chips, handled-by state |
| `src/lib/inbox-queues.js`, `mobile/lib/inbox.js` | Thin re-exports of the shared rules |
| `src/lib/inbox-state.js` (+ test) | Pure patch builders for every state transition |
| `src/lib/inbox-followup-config.js` (+ test) | Reads and clamps a studio's follow-up config |
| `shared/inbox-snooze.js` (+ test) | Snooze presets on a studio's clock |
| `src/app/api/{whatsapp,instagram}/conversations/[id]/snooze/route.js` | Snooze and unsnooze |
| `src/app/api/whatsapp/inbox-config/route.js` | Follow-up config for the phone |
| `src/components/inbox/RowChips.jsx`, `SnoozeControl.jsx` | Row chips; snooze menu |
| `src/lib/agent/staff-nudges.js` (+ test) | Nudge classifier and runner |

---

## PR 1: state, rules, web queues

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/874_inbox_followup_state.sql`
- Modify: the schema snapshot and `supabase/schema/access.json` (refresh as `check:schema-snapshot` requires)
- Test: `tests/role-access.test.js`

**Interfaces:**
- Produces, on both `whatsapp_conversations` and `instagram_conversations`: `customer_waiting_since timestamptz`, `staff_owned_since timestamptz`, `staff_waiting_since timestamptz`, `staff_nudged_at timestamptz`, `staff_nudge_outcome text`, `handoff_requested_at timestamptz`, `snoozed_until timestamptz`, `snoozed_by uuid references profiles(id)`, `snooze_note text check (char_length(snooze_note) <= 140)`. All nullable, no defaults.

- [ ] **Step 1:** Write the migration: the columns above; a partial index per table on `(location_id)` where `staff_waiting_since is not null and resolved_at is null`; the backfill below; a comment recording the grant decision (both tables carry a table-level `SELECT` for `authenticated` under RLS; all nine columns are safe for a staff session with inbox access at that studio; no new grants).
- [ ] **Step 2:** Backfill. `customer_waiting_since = last_message_at` where `resolved_at is null and last_message_direction = 'inbound'`. `handoff_requested_at = agent_handed_off_at` where unresolved, `agent_handed_off_at is not null`, and the newest outbound message in the thread has `source = 'agent'`. `staff_waiting_since` and `staff_owned_since` are not backfilled.
- [ ] **Step 3:** Add `role-access` cases: an inbox staff session reads the new columns at its own studio and not at another; it cannot update them.
- [ ] **Step 4:** Apply with the Supabase MCP, run the security advisor, refresh the snapshots. Run `npm run check:schema-snapshot && npm run check:select-columns`. Expected: pass.
- [ ] **Step 5:** Commit.

### Task 2: Shared queue rules

**Files:**
- Create: `shared/inbox-queues.js`, `shared/inbox-queues.test.js`
- Modify: `src/lib/inbox-queues.js`, `mobile/lib/inbox.js` (re-export; delete their own copies), `src/lib/inbox-queues.test.js`, `mobile/lib/inbox.test.js`
- Create: `src/lib/inbox-followup-config.js`, `src/lib/inbox-followup-config.test.js`

**Interfaces:**
- Produces from `shared/inbox-queues.js` (all pure; `cfg` is `{ quietHours: number, nudgeEnabled: boolean }`):
  - `DEFAULT_FOLLOWUP_CFG = { quietHours: 48, nudgeEnabled: false }`, `NUDGE_GRACE_HOURS = 24`
  - `isSnoozed(c, nowMs): boolean`
  - `returnAtMs(c, cfg, channel): number | null` (when a waiting thread comes back)
  - `returnReason(c, nowMs, cfg, channel): 'gone_quiet' | 'no_reply_after_nudge' | null`
  - `needsReply(c, nowMs, cfg, channel): boolean`
  - `needsMiaHelp(c): boolean`
  - `isWaiting(c, nowMs, cfg, channel): boolean`
  - `needsAction(c, nowMs, cfg, channel): boolean`
  - `hasPendingApproval(c): boolean`
  - `waitSinceMs(c, nowMs, cfg, channel): number | null` (sort key and wait chip for "Needs reply")
  - `sortNeedsReply(list, nowMs, cfg): array` (each item carries `_channel: 'wa' | 'ig'`, as `UnifiedInbox` already tags rows)
  - `windowState(c, nowMs, channel): { kind: 'open', msLeft: number, soon: boolean } | { kind: 'closed' } | null`
  - `handledBy(c, channel): 'mia' | 'paused' | 'person' | 'unclaimed'`
  - `QUEUES = [{ key: 'needs_reply', label: 'Needs reply' }, { key: 'mia_help', label: 'Mia needs help' }, { key: 'waiting', label: 'Waiting' }, { key: 'pending_approval', label: 'Approvals' }, { key: 'all', label: 'All' }]`
  - `filterByQueue(list, queue, nowMs, cfg)`, `queueCounts(list, nowMs, cfg)`
- Produces from `src/lib/inbox-followup-config.js`: `followupConfigFromSettings(customerAgentSettings): cfg` (pure; reads `followups.staff_threads.quiet_after_hours` and `.nudge_enabled`; clamps hours to 4..336; junk or missing gives the default) and `readInboxFollowupConfig(db, locationId): Promise<cfg>` (through `resolveAgentSettingsForLocation`; a failed read logs and returns the default).

The rules, which the tests pin:

```
snoozed      = snoozed_until > now
returnAt     = null when staff_waiting_since is null, else the later of snoozed_until (if any) and:
                 outcome 'sent'             -> staff_nudged_at + Q
                 outcome starts 'skipped'   -> staff_nudged_at
                 no outcome, nudges on, wa  -> staff_waiting_since + Q + 24h
                 otherwise                  -> staff_waiting_since + Q
returned     = returnAt != null and now >= returnAt
needsReply   = !resolved and !snoozed and (last_message_direction == 'inbound' or returned)
needsMiaHelp = !resolved and handoff_requested_at set
isWaiting    = !resolved and (snoozed or (staff_waiting_since set and !returned))
needsAction  = !resolved and last_message_at set and !snoozed and (needsReply or needsMiaHelp)
waitSince    = customer_waiting_since when last message inbound, else returnAt when returned
window       = wa only: open while window_expires_at > now, soon when under 4h left; closed otherwise; null for ig
handledBy    = paused (wa, agent_paused_at) > unclaimed (handoff_requested_at, no staff_owned_since)
               > person (staff_owned_since, or agent_active === false) > mia
```

- [ ] **Step 1:** Write `shared/inbox-queues.test.js`. One `describe` per export. Required cases, with `Q = 48h`: staff replied 47 h ago is waiting, 49 h ago with nudges off is needs-reply with reason `gone_quiet`; nudges on, wa, 49 h is still waiting and 73 h is `gone_quiet`; nudges on, ig, 49 h is `gone_quiet`; outcome `sent` 47 h after the nudge is waiting, 49 h is `no_reply_after_nudge`; outcome `skipped:no_consent` is needs-reply at once; snoozed inbound thread is waiting and not needs-action; snooze ending after `returnAt` returns at the snooze time; resolved thread is in no queue; changing `cfg.quietHours` from 48 to 4 moves a 5-hour-old waiting thread to needs-reply (Review Focus 4); `sortNeedsReply` puts the oldest `waitSince` first and rows with no `waitSince` last by `last_message_at`; `windowState` at 3 h 59 m left is `soon`; the four `handledBy` states including a wa thread with `agent_active === false` and no pause reading `person`.
- [ ] **Step 2:** Run `npx vitest run shared/inbox-queues.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `shared/inbox-queues.js` to the block above.
- [ ] **Step 4:** Replace the bodies of `src/lib/inbox-queues.js` and `mobile/lib/inbox.js` with re-exports (keep mobile's message-type labels where they are). `isAgentHandoff` stays exported as an alias of `needsMiaHelp` until Task 4 removes its callers. Update the two old test files to the new signatures.
- [ ] **Step 5:** Write the config tests (missing, junk, 2 gives 4, 9999 gives 336, read failure gives default) and implement `src/lib/inbox-followup-config.js`.
- [ ] **Step 6:** Run `npx vitest run shared/inbox-queues.test.js src/lib/inbox-queues.test.js mobile/lib/inbox.test.js src/lib/inbox-followup-config.test.js && npm run check:mobile-imports`. Expected: PASS.
- [ ] **Step 7:** Commit.

### Task 3: State transitions at every write point

**Files:**
- Create: `src/lib/inbox-state.js`, `src/lib/inbox-state.test.js`
- Modify: `src/app/api/webhooks/whatsapp/route.js` (inbound stamp, near line 764), `src/lib/agent/instagram.js` (inbound stamp near line 505, not the low-signal branch; agent outbound near 438), `src/app/api/whatsapp/conversations/[id]/send/route.js` (near 306), `src/app/api/instagram/conversations/[id]/send/route.js` (near 115), `src/lib/whatsapp-coexistence-ingest.js` (near 158-177), `src/lib/agent/auto-reply.js` (Mia's reply stamp, and both writers that stamp `agent_handed_off_at` for a handoff, near 1840 and 1874), `src/lib/agent/followups.js` `recordProactiveMessage` (near 321), both conversation PATCH routes (resolve), plus any other route under `conversations/[id]/` that sends a customer-visible message from the thread (card set, booking flow; not `react`)
- Test: the existing test file beside each modified module

**Interfaces:**
- Produces from `src/lib/inbox-state.js` (pure; each returns a patch object):
  - `inboundPatch(existing, nowIso)`: `customer_waiting_since` kept if set else `nowIso`; nulls `staff_waiting_since`, `staff_nudged_at`, `staff_nudge_outcome`, `snoozed_until`, `snoozed_by`, `snooze_note`
  - `staffReplyPatch(existing, nowIso)`: `staff_owned_since` kept if set else `nowIso`; `staff_waiting_since: nowIso`; nulls `customer_waiting_since`, `staff_nudged_at`, `staff_nudge_outcome`, `handoff_requested_at`, and the three snooze columns
  - `agentReplyPatch()`: `{ customer_waiting_since: null }`
  - `handoffRequestPatch(nowIso)`: `{ handoff_requested_at: nowIso }`
  - `completePatch()`: nulls all nine new columns
  - `handBackPatch()`: `completePatch()` plus `{ agent_active: true, agent_handed_off_at: null, handoff_escalated_at: null }`
  - `snoozePatch({ untilIso, userId, note })` and `unsnoozePatch()`

- [ ] **Step 1:** Write `src/lib/inbox-state.test.js` asserting each patch's exact keys and values, including that `inboundPatch` keeps an existing `customer_waiting_since` and that `staffReplyPatch` keeps an existing `staff_owned_since`.
- [ ] **Step 2:** Run it. Expected: FAIL. Implement. Expected: PASS.
- [ ] **Step 3:** Spread the patches into the existing updates. Inbound (both channels): add the new columns to the select that already loads the conversation, then `inboundPatch`. Staff reply from the thread and the coexistence echo: `staffReplyPatch`. Mia's reply and `recordProactiveMessage`: `agentReplyPatch`. Mia's handoff: `handoffRequestPatch`. Resolve `true` in both PATCH routes: `completePatch` alongside `resolveRearmPatch`. Do not add `staffReplyPatch` to `contacts/[id]/whatsapp`, `un1t-payment-link`, `cancellation-form`, `radar-outreach` or broadcasts (spec: only thread replies start the ladder).
- [ ] **Step 4:** Coexistence echo: apply `staffReplyPatch` only inside the guard that already protects `last_message_at` (echo newer than what the thread holds). Add a test: echo older than the thread's last inbound leaves `staff_waiting_since` null and `customer_waiting_since` set (Review Focus 5).
- [ ] **Step 5:** In each modified module's test file add one case per transition asserting the update carries the patch. For the WhatsApp webhook add: a thread with `snoozed_until` in the future receives an inbound message, and the update nulls the snooze columns and keeps `resolved_at: null` (Review Focus 1).
- [ ] **Step 6:** Run the touched test files and `npm run check:select-columns`. Expected: PASS.
- [ ] **Step 7:** Commit.

### Task 4: Coach keeps the thread; web queues and row

**Files:**
- Modify: `src/lib/agent/core.js` (`shouldAgentReply`), `src/lib/agent/auto-reply.js` (conversation select near 605), `src/lib/agent/handoff-sla.js` (`classifyAutoResolve`, the candidate select near 265), `src/components/inbox/MiaDecisionTrace.jsx` (`REASON_LABELS`)
- Modify: `src/app/api/whatsapp/conversations/route.js`, `src/app/api/instagram/conversations/route.js`, `src/app/api/whatsapp/unread-count/route.js`, `src/lib/home-queue.js`, `src/lib/today-feed-data.js`
- Create: `src/components/inbox/RowChips.jsx`
- Modify: `src/components/UnifiedInbox.jsx`
- Test: `src/lib/agent/core.test.js`, `src/lib/agent/handoff-sla.test.js`, the routes' test files, a component test for `RowChips`

**Interfaces:**
- Consumes: Task 2 exports; `readInboxFollowupConfig`.
- Produces: `shouldAgentReply` returns `{ reply: false, reason: 'staff_owned' }` when `conversation.staff_owned_since` is set, checked straight after the `agent_paused` check, with no `onDuty` and no `rearm`. `classifyAutoResolve` takes `staffOwned` and returns `{ resolve: false, reason: 'staff_owned' }` when true, checked before both resolve cases. Both list routes add `followup: cfg` to their JSON. `RowChips.jsx` exports `WaitChip({ conv, nowMs, cfg })`, `WindowChip({ conv, nowMs })`, `StateLine({ conv, nowMs, cfg })`.

- [ ] **Step 1:** Tests in `core.test.js`: staff-owned thread, `agent_active` false, handoff stamp 13 h old, `lastOutboundHuman` false, plain text inbound gives `{ reply: false, reason: 'staff_owned' }` with `onDuty` and `rearm` undefined (Review Focus 3); same thread with an audio message gives the same result (no soft handoff). In `handoff-sla.test.js`: `staffOwned: true` with a human reply 9 h quiet gives no resolve; with 49 h of nothing gives no resolve; `staffOwned: false` keeps today's results.
- [ ] **Step 2:** Run. Expected: FAIL. Implement both gates and add `staff_owned_since` to the two selects. Add `staff_owned: 'A coach is handling this conversation'` to `REASON_LABELS`. Confirm in `auto-reply.js` that a `reply: false` result without `onDuty` sends nothing to the customer; if any path does, close it and test it. Expected: PASS.
- [ ] **Step 3:** List routes: besides the latest 50, also read unresolved rows where any of `last_message_direction = 'inbound'`, `handoff_requested_at`, `staff_waiting_since`, `snoozed_until` is set (limit 300, ordered by `last_message_at`), merge by id, and return `followup`. Route tests: a 60-thread fixture with 55 waiting returns all 55.
- [ ] **Step 4:** `unread-count`, `home-queue.js` and `today-feed-data.js`: read the studio's cfg once and pass `nowMs`, `cfg` and the channel to `needsAction`. Update their tests.
- [ ] **Step 5:** `RowChips.jsx`. Wait chip: "waiting 2h 10m" when it is our turn, "quiet 2 days" when theirs. Window chip: "closes in 3h" (amber when `soon`), "template only" (grey); nothing for Instagram. State line, replacing the preview when it applies: `Snoozed until Fri 09:00 · <note>`, `Mia nudged Tue 10:02`, `No reply after nudge`, `Gone quiet`. Times in the studio's zone. Component test for each string.
- [ ] **Step 6:** `UnifiedInbox.jsx`: chips from `QUEUES` in that order with counts; "Needs reply" uses `sortNeedsReply`, the others keep newest-first; row uses `RowChips`; the amber "Needs human" badge keys on `needsMiaHelp`; a 60-second tick re-renders so threads move queues without a reload; `cfg` comes from the list response. Remove the `isAgentHandoff` alias and its last callers.
- [ ] **Step 7:** Run the touched tests, `npm run lint`, `npm run build`. Open `/communications/inbox` in the preview and confirm the five chips, the sort and the row chips render. Expected: PASS, no console errors.
- [ ] **Step 8:** Changelog entry; commit; open PR 1.

---

## PR 2: snooze and "Handled by"

### Task 5: Snooze

**Files:**
- Create: `shared/inbox-snooze.js`, `shared/inbox-snooze.test.js`, `src/app/api/whatsapp/conversations/[id]/snooze/route.js` (+ test), `src/app/api/instagram/conversations/[id]/snooze/route.js` (+ test), `src/components/inbox/SnoozeControl.jsx`
- Modify: `src/lib/schemas.js`, `src/components/WAInbox.jsx`, `src/components/IGInbox.jsx`, `tests/route-wrapper-guard.test.js` fixtures if it lists routes

**Interfaces:**
- Produces: `snoozePresets(nowMs, zone): [{ key: 'later' | 'tomorrow' | 'three_days' | 'next_week', label: string, untilIso: string }]` (later = now + 3 h; tomorrow 09:00; in 3 days 09:00; next Monday 09:00; all on `zone`'s clock via `shared/zoned-time`). `POST …/snooze` body `{ until: string | null, note?: string }`; `until: null` unsnoozes; answers `{ success: true, data: { snoozed_until, snooze_note } }`. `SnoozeControl({ channel, conversation, zone, onChanged })`.

- [ ] **Step 1:** Preset tests with a fixed clock in `Europe/Dublin` and one non-Dublin zone, including a Sunday (next week = the next day) and a daylight-saving boundary. Implement.
- [ ] **Step 2:** Route tests: 404 for a thread at a studio the user cannot access; 400 for `until` in the past or more than 90 days ahead, or a note over 140 characters; success writes `snoozePatch` with the caller's id; `until: null` writes `unsnoozePatch`; a failed update answers 500, never success. Use the same guards as the sibling `agent` route (`requireWebWhatsAppInboxAnywhere`, `assertLocationAccessOr404`, `requireWebWhatsAppInboxAt`), except that the phone must be able to call it: use the permission check the `send` route uses. Implement both routes with `validateBody` and a `SnoozeSchema` in `src/lib/schemas.js`.
- [ ] **Step 3:** `SnoozeControl`: a button beside Resolve opening the four presets, a date-time field and a note field; when snoozed it shows "Snoozed until … · Unsnooze". Errors show under the control, not in `window.alert`. Mount it in both thread headers and refresh the thread and queue on change.
- [ ] **Step 4:** Run the tests, `npm run check:route-guards`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 6: "Handled by" tells the truth

**Files:**
- Modify: `src/components/inbox/HandledByControl.jsx`, `src/app/api/whatsapp/conversations/[id]/agent/route.js`, `src/app/api/instagram/conversations/[id]/agent/route.js`, both conversation GET routes (to return the owner's first name)
- Test: route tests; a component test for `HandledByControl`

**Interfaces:**
- Consumes: `handledBy(c, channel)`, `handBackPatch()`.
- Produces: `PATCH …/agent` with `{ active: true }` applies `handBackPatch()` (and on WhatsApp also clears `agent_paused_at`); `{ active: false }` keeps today's behaviour. Both routes check the update's `error` and answer 500 on failure (the WhatsApp route ignores it today). The conversation GET adds `handled_by_name`: the assignee's first name, else the first name of the sender of the newest staff message, else null.

- [ ] **Step 1:** Route tests: hand-back on a staff-owned thread nulls the nine columns and re-arms; a failed update answers 500. Implement.
- [ ] **Step 2:** Component test: the four states render "Mia", the person's name (or "A coach" when the name is null), "Mia paused", "Waiting for a person"; choosing Mia on a `person` or `unclaimed` thread sends `{ active: true }`; Instagram never shows "Mia paused". Implement with `handledBy`.
- [ ] **Step 3:** Run the tests and `npm run build`. In the preview, reply in a Test Studio thread and confirm the control reads the coach's name, and that Resolve returns it to "Mia".
- [ ] **Step 4:** Changelog entry; commit; open PR 2.

---

## PR 3: Mia's nudge

### Task 7: Nudge classifier and runner

**Files:**
- Create: `src/lib/agent/staff-nudges.js`, `src/lib/agent/staff-nudges.test.js`
- Modify: `src/lib/agent/followups.js` (export what the runner reuses; generalise the template send), `src/app/api/cron/agent-followups/route.js`

**Interfaces:**
- Consumes from `followups.js`: `proactiveWindowOpen`, `studioOwnsWhatsAppNumber`, `composeAgentText`, `recordProactiveMessage`, `intentFlags`, `sentTodayCount`, the tick's settings and zone readers. Refactor `sendFollowupTemplate(db, conv, settings, facts)` so its body becomes `sendApprovedTemplate(db, conv, { templateName, facts })` and the old function calls it; export both.
- Produces:
  - `STAFF_NUDGE_DEFAULTS = { quiet_after_hours: 48, nudge_enabled: false, template_name: null }`
  - `classifyStaffNudge({ staffWaitingSinceMs, snoozedUntilMs, windowExpiresAtMs, nowMs, quietHours, hasContact, optedOut, blocked, marketingConsent, sensitiveIntent, templateReady, daytimeOpen, capReached }): { action: 'wait' | 'skip' | 'template' | 'freeform', reason?: string }` (pure)
  - `runStaffThreadNudges(db, { nowMs }): Promise<{ freeform, templates, skipped, waiting }>`

Classifier order, first match wins:

```
now < waiting + Q                              -> wait  (not_due)
snoozed_until > now                            -> wait  (snoozed)
snoozed_until > waiting + Q (snooze ran past)  -> skip  (after_snooze)
now > waiting + Q + 24h                        -> skip  (expired)
!hasContact | optedOut | blocked               -> skip  (no_contact | opted_out | blocked)
sensitiveIntent                                -> skip  (sensitive_intent)
!daytimeOpen | capReached                      -> wait  (quiet_hours | daily_cap)
window open                                    -> freeform
!templateReady                                 -> skip  (no_template)
!marketingConsent                              -> skip  (no_consent)
otherwise                                      -> template
```

- [ ] **Step 1:** Classifier tests: one per row above, plus the boundaries (exactly `Q`, exactly `Q + 24h`). Implement. Expected: PASS.
- [ ] **Step 2:** Runner tests with `createFakeDb`: nudges off for the studio sends nothing and stamps nothing; agent neither enabled nor in test mode sends nothing; test mode honours the phone allowlist; a `skip` stamps `staff_nudged_at` and `staff_nudge_outcome: 'skipped:<reason>'`; a `wait` stamps nothing; a `template` send records the message and stamps `sent`; a send that fails or throws stamps `skipped:send_failed`; paused and resolved threads are never candidates.
- [ ] **Step 3:** Claim before send (Review Focus 2). The runner updates `staff_nudged_at` and `staff_nudge_outcome: 'sending'` with `.eq('id', …).is('staff_nudged_at', null).eq('staff_waiting_since', <the value read>)` and `.select()`; it sends only when a row comes back, then writes the final outcome. Test: the fake DB changes `staff_waiting_since` to null between read and claim; no send happens. `returnAtMs` treats `sending` like `sent`. A claim left at `sending` for over 30 minutes is rewritten to `skipped:send_failed` on the next tick.
- [ ] **Step 4:** Implement the runner: per active location, read cfg and settings as `runAgentFollowups` does; candidates are `whatsapp_conversations` at the location with `staff_waiting_since` not null and at or before `now - Q`, `staff_nudged_at` null, `resolved_at` null, `agent_paused_at` null, ordered oldest first, limit 100, with the contact embed `contacts!contact_id(...)`. The free-text instruction tells Mia: the customer was talking to a coach who is waiting for their answer; send one short, warm check-in that refers to the coach's last message; no selling; reply `SKIP` if the thread reads as finished. A `SKIP` stamps `skipped:model_skip`.
- [ ] **Step 5:** Cron: call `runStaffThreadNudges` as its own failure domain after `runAgentFollowups`; a throw pushes `'staff_nudges'` to `armErrors` and logs with `logError`; add its counts to the heartbeat outcome.
- [ ] **Step 6:** Run `npx vitest run src/lib/agent/staff-nudges.test.js src/lib/agent/followups*.test.js` and the cron route's test. Expected: PASS.
- [ ] **Step 7:** Commit.

### Task 8: Settings

**Files:**
- Modify: `src/lib/agent/settings-contract.js`, `src/lib/agent/settings-overrides.js`, `src/app/settings/customer-agent/fields.js`, `org-fields.js`, `save-payload.js`, `sections/FollowupsSection.jsx`, `__fixtures__/agent-settings.js`
- Test: the existing tests beside each

**Interfaces:**
- Produces: `settings.customer_agent.followups.staff_threads = { quiet_after_hours, nudge_enabled, template_name }`, read by Task 2's config reader and Task 7's runner.

- [ ] **Step 1:** Add the three keys wherever `nudge_after_hours` is declared, following each file's existing pattern (contract, overrides, fields, payload, fixtures). Tests: save round-trips the three values; hours outside 4..336 are rejected by the contract.
- [ ] **Step 2:** `FollowupsSection.jsx`: a "Threads your team is waiting on" group with the quiet period (hours), the "Mia nudges quiet threads your team took over" switch, and a template picker listing the studio's approved templates. Helper text states that the quiet period applies with the switch off, and that with no approved template chosen the nudge is skipped outside the 24-hour window.
- [ ] **Step 3:** Run the settings tests and `npm run build`. Expected: PASS.
- [ ] **Step 4:** Live pass at Test Studio, with the quiet period at 4 hours and a test-mode allowlist: reply as staff, wait for the tick, confirm the nudge arrives labelled MIA and the row reads "Mia nudged"; reply as the customer and confirm the thread is in "Needs reply", Mia sent nothing, and "Why?" shows "A coach is handling this conversation"; complete the thread and confirm Mia answers the next message.
- [ ] **Step 5:** Changelog entry; commit; open PR 3.

---

## PR 4: phone app

### Task 9: Mobile parity

**Files:**
- Create: `src/app/api/whatsapp/inbox-config/route.js` (+ test)
- Modify: `mobile/lib/whatsapp-api.js`, the Instagram list helper beside it, `mobile/app/(staff)/(tabs)/whatsapp.jsx`, `mobile/app/(staff)/whatsapp/[conversationId].jsx`, `mobile/app/(staff)/instagram/[conversationId].jsx`, `mobile/lib/inbox.test.js`

**Interfaces:**
- Consumes: `shared/inbox-queues`, `shared/inbox-snooze`, the snooze routes, `handledBy`.
- Produces: `GET /api/whatsapp/inbox-config?location_id=` answering `{ success: true, data: { quietHours, nudgeEnabled } }`, with `withAuth`, `assertLocationAccess` and the inbox permission the phone already holds.

- [ ] **Step 1:** Route test (other studio answers as the sibling list route does; own studio returns the cfg). Implement.
- [ ] **Step 2:** Add the nine columns to both phone list selects (name every column; no `profiles` embed). Fetch the cfg with `api()` on focus; fall back to `DEFAULT_FOLLOWUP_CFG` if it fails.
- [ ] **Step 3:** List screen: the five queue chips with counts, the "Needs reply" sort, wait and window chips, the state line. Thread screens: snooze and unsnooze through the routes, and the four "Handled by" states (the WhatsApp hand-back stays hidden for users without `canUseWebControls`, as today).
- [ ] **Step 4:** Run `npx vitest run mobile/lib && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:mobile-parity && npm run check:ota-paths`. Expected: PASS.
- [ ] **Step 5:** Changelog entry; commit; open PR 4. Merging publishes an over-the-air update to every phone; say so in the PR body.

---

## After the last merge

- Richard submits the "a coach's thread went quiet" template to Meta and picks it in settings.
- Nudges stay off at both studios until that template is approved and the Test Studio pass in Task 8 has been repeated on production.
