# Inbox Redesign — Plan 2: Thread header + Handled-by (WA agent-pause) — Implementation Plan

> **For agentic workers:** implement task-by-task; steps are checkboxes. TDD the pure logic; verify UI via build/lint/guardrails.

**Goal:** Give WhatsApp a real "pause Mia" toggle (new sticky column + endpoint + a guard in the Mia send path), expose it — and Instagram's existing toggle — through one unified **Handled by Mia ⇄ You** control, and declutter the thread header (Resolve primary, everything else into a `⋯` overflow, channel-badged avatar).

**Architecture:** A dedicated, nullable, **sticky** `whatsapp_conversations.agent_paused_at` (NOT a reuse of `agent_active`, which auto-rearms after 12h and is flipped by every staff WA reply). Mia's auto-reply gate `shouldAgentReply` returns `{reply:false}` when it's set; three other WA send entry points also honour it. A new `PATCH /api/whatsapp/conversations/[id]/agent` mirrors the IG route. UI adds a shared control used by WA (reads `agent_paused_at`) and IG (reads `agent_active`), hidden for Email (no agent).

**⚠️ Prod / sensitive:** this plan applies a **migration to the shared prod Supabase DB** and changes **Mia customer-agent behaviour**. Migration is applied via Supabase MCP **before** the reading code merges (per repo invariant). There is an explicit human checkpoint before the migration is applied.

**Grounding (verified 2026-07-22, exact sites):**
- IG toggle to mirror: `src/app/api/instagram/conversations/[id]/agent/route.js` (PATCH, body `{active:boolean}`, flips `instagram_conversations.agent_active`, auth = `getCurrentUser` + `assertLocationAccessOr404`, resp `{success, agent_active}`).
- Mia WA gate: `src/lib/agent/core.js` → `shouldAgentReply(...)` L176–242 (pure). Insert pause check after the enabled/test-mode gate (~after L180), before the kill-switch block (~L193).
- Conv-state read that must select the new column: `src/lib/agent/auto-reply.js` L248–251 (the ONLY hard-coded column list on the read path).
- Follow-up ladder candidate query: `src/lib/agent/followups.js` L397–405 (add `.is('agent_paused_at', null)`).
- Mid-turn takeover recheck: `src/lib/agent/auto-reply.js` `humanTookOverDuringTurn` L207–230 (also treat `agent_paused_at` as takeover).
- WA conversations fetch uses `select('*')` (`src/app/api/whatsapp/conversations/route.js` L17; `[id]/route.js` L22) — new column reaches the UI automatically.
- Headers: `WAInbox.jsx` L650–726 (no agent toggle today; imports `UserCheck`, not `Bot`), `IGInbox.jsx` L356–398 (has the toggle; `agentActive = conversation?.agent_active !== false`), `EmailInbox.jsx` L250–282 (Resolve only, **no agent** — hide the control).
- Reuse `ChannelAvatar`/`ChannelGlyph` (`src/components/inbox/ChannelBits.jsx`) + `channelOf`/`CHANNELS` (`shared/channels.js`).
- Next migration number: **435**. Convention: `supabase/migrations/NNN_snake_case.sql`, `alter table ... add column if not exists ...; comment on column ...`.

**Repo invariants:** service-role routes get NO RLS → new route needs `getCurrentUser` + `assertLocationAccessOr404` + register in `src/lib/openapi.js`; migrations forward-only via Supabase MCP against project `iyvtbjjxdggiadzwwvdj`, run `get_advisors` after DDL, apply **before** reading code deploys; `<button>` in a form defaults to submit (set `type="button"`); chip recipe `bg-<c>-500/10 text-<c>-700`; supabase-js `.update()` must be awaited; `next build` is the real gate.

---

### Task 1 — Migration file: `whatsapp_conversations.agent_paused_at`

**File:** Create `supabase/migrations/435_whatsapp_agent_pause.sql`

- [ ] Write it (match the mig-433 style):
```sql
-- INBOX-REDESIGN 2026-07 — WhatsApp "pause Mia" toggle.
-- Dedicated, sticky, nullable timestamp. Deliberately NOT a reuse of
-- agent_active: that flag auto-rearms after handoff_cooldown_hours and is
-- flipped by every staff WA reply (manualTakeoverPatch), so it can't express
-- an explicit "stay off until I resume". null = Mia active; set = Mia paused.
alter table public.whatsapp_conversations
  add column if not exists agent_paused_at timestamptz;

comment on column public.whatsapp_conversations.agent_paused_at is
  'When set, Mia will not auto-reply to this WhatsApp conversation (sticky; cleared only by the resume endpoint). Nullable, no default — metadata-only add. (INBOX-REDESIGN mig 435)';
```
- [ ] Commit the file (the file is the record; it is applied to prod separately, see the Deploy step):
```bash
git add supabase/migrations/435_whatsapp_agent_pause.sql
git commit -m "INBOX-REDESIGN.2.1 — mig 435: whatsapp_conversations.agent_paused_at

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Do NOT apply the migration during the build.** It is applied via Supabase MCP at the Deploy step, after the human checkpoint, before merge.

---

### Task 2 — Pause/resume endpoint `PATCH /api/whatsapp/conversations/[id]/agent`

**Files:** Create `src/app/api/whatsapp/conversations/[id]/agent/route.js`; modify `src/lib/openapi.js` (register the route).

- [ ] **Read `src/app/api/instagram/conversations/[id]/agent/route.js` first and mirror it exactly** (same imports, auth helpers, `validateBody`, response shape). The only differences:
  - Table is `whatsapp_conversations`.
  - Body `{ active: boolean }`. `active:false` = pause → set `agent_paused_at = new Date().toISOString()`. `active:true` = resume → set `agent_paused_at = null`. (Sticky: no `agent_handed_off_at` stamping — that IG detail is for its rearm machinery, which we're intentionally decoupling from.)
  - `await` the update. Response `{ success: true, agent_paused_at }`.
  - Select `id, location_id` for the access check; 404 if missing; `assertLocationAccessOr404(user, conv.location_id)`.
- [ ] Register the route in `src/lib/openapi.js` following the pattern used for the IG agent route (find `instagram/conversations` there and add the WA equivalent).
- [ ] Verify: `npm run build && npm run lint && npm run check:route-guards` (route-guards must see the new route as session-guarded). Paste results.
- [ ] Commit: `INBOX-REDESIGN.2.2 — WA pause/resume-Mia endpoint`.

---

### Task 3 — Mia send-path pause guard (the sensitive change; TDD the pure gate)

**Files:** `src/lib/agent/core.js`, `src/lib/agent/auto-reply.js`, `src/lib/agent/followups.js`. Test: the existing `core.js`/`shouldAgentReply` test file (find it — grep `shouldAgentReply` under the tests) — add a case.

- [ ] **Write the failing test** for `shouldAgentReply`: a conversation with `agent_paused_at` set (and settings enabled, not test-mode) returns `{ reply: false, reason: 'agent_paused' }` and does NOT set `onDuty`. (Match the existing test's construction of `settings`/`conversation`/`message`.) Run it → fails.
- [ ] **Implement the gate** in `src/lib/agent/core.js` `shouldAgentReply`, immediately after the enabled/test-mode gate (~after L180), before the kill-switch (~L193):
```js
if (conversation?.agent_paused_at) return { reply: false, reason: 'agent_paused' }
```
Placing it before the content gates means a paused thread returns `reply:false` with no `onDuty:true`, so Mia stays fully silent (no soft-handoff ack). Run the test → passes. Run the full `shouldAgentReply` suite → still green.
- [ ] **Extend the conv-state select** in `src/lib/agent/auto-reply.js` L248–251: add `agent_paused_at` to the hard-coded column list (keep it a plain same-table column — never an embed).
- [ ] **Follow-up ladder:** in `src/lib/agent/followups.js` L397–405, add `.is('agent_paused_at', null)` to the candidate query so paused threads get no nudges.
- [ ] **Mid-turn takeover:** in `src/lib/agent/auto-reply.js` `humanTookOverDuringTurn` (L207–230), also treat a now-set `agent_paused_at` as takeover (re-read it alongside `agent_active`/last human outbound) so a pause landing while Mia composes drops the in-flight reply. Follow the existing re-read shape there.
- [ ] Verify: `npm test` (the agent suites must stay green + the new case passes), `npm run lint`. Paste totals.
- [ ] Commit: `INBOX-REDESIGN.2.3 — pause guard in Mia WA send path (shouldAgentReply + auto-reply + followups)`.

---

### Task 4 — Unified "Handled by Mia ⇄ You" control

**Files:** Create `src/components/inbox/HandledByControl.jsx`; modify `src/components/WAInbox.jsx` (add it to header) and `src/components/IGInbox.jsx` (replace its bespoke toggle with it). Email: not used.

- [ ] Create `HandledByControl.jsx` — a segmented `Mia | You` control. Props: `channel` ('wa'|'ig'), `conversation`, `onChanged()`.
  - Derive "who's handling": WA → paused = `!!conversation.agent_paused_at`; IG → paused = `conversation.agent_active === false`. `handledByMia = !paused`.
  - On toggle to You (pause): PATCH the channel's endpoint with `{active:false}` (WA: `/api/whatsapp/conversations/${id}/agent`; IG: `/api/instagram/conversations/${id}/agent`). On toggle to Mia (resume): `{active:true}`. Then call `onChanged()` (parents re-load the thread).
  - Visual: match the mockup — a segmented pill, `Mia` active = `bg-mia/10 text-mia`, `You` active = `bg-un1t-text text-un1t-bg`, label "Handled by". Buttons `type="button"`. Use `lucide-react` `Sparkles` for Mia, `UserCheck` for You (both already used elsewhere).
- [ ] **WAInbox:** import + render `<HandledByControl channel="wa" conversation={conversation} onChanged={() => loadThread(...)} />` in the header's right cluster (near Resolve). Wire `onChanged` to the existing thread reload used after other mutations.
- [ ] **IGInbox:** replace the existing bespoke `agentActive`/`toggleAgent` header block (L386–396) with `<HandledByControl channel="ig" conversation={conversation} onChanged={() => { loadThread(selectedId); fetchApprovals(selectedId); }} />`. Keep `toggleAgent` only if still used elsewhere; otherwise remove it (grep first).
- [ ] Verify: `npm run build && npm run lint && npm run check:guardrails`.
- [ ] Commit: `INBOX-REDESIGN.2.4 — unified Handled-by control (WA + IG)`.

---

### Task 5 — Thread header declutter + channel identity

**Files:** `src/components/WAInbox.jsx` (L650–726), light touch on `src/components/IGInbox.jsx` + `src/components/EmailInbox.jsx` headers.

- [ ] **WAInbox header:** restructure to: **Left** — `<ChannelAvatar channel="wa" initials={…} badge />` + name + a channel name label (`WhatsApp`, `text-channel-wa`) + stage; sub-line = phone · a slim window indicator (green "Window open" / amber "closed"). **Right** — the `HandledByControl` · a single primary **Resolve/Reopen** · a **`⋯` overflow** menu holding **Block/Unblock** and **Add to contacts / View contact**. Move Block + Add-to-contacts out of the always-visible row into the overflow (a simple menu is fine; if the repo has a menu primitive in `src/components/ui`, use it, else a small popover). Keep all existing handlers (`toggleResolved`, `toggleBlocked`, add-contact) wired.
- [ ] **IGInbox + EmailInbox headers:** add the `<ChannelAvatar badge>` + channel name label on the left for consistency (IG = pink, Email = blue). Do not add a Handled-by control to Email. Keep their Resolve as-is.
- [ ] Verify: `npm run build && npm run lint && npm run check:guardrails`. Manual visual is deferred to the Vercel preview.
- [ ] Commit: `INBOX-REDESIGN.2.5 — declutter thread header + channel identity`.

---

## Deploy (after all tasks build green) — HUMAN CHECKPOINT

1. Run the full CI mirror; open the PR; confirm all GitHub checks green.
2. **CHECKPOINT — pause for explicit human OK.** Then apply migration 435 to prod via Supabase MCP (`apply_migration` against project `iyvtbjjxdggiadzwwvdj` — confirm via `list_projects`, NOT the sentinel project). Run `get_advisors(type=security)` after. Verify the column exists (`information_schema`).
3. Only after the migration is applied: merge the PR (deploys the reading code). Verify prod: send/observe that a paused WA thread does not get a Mia auto-reply, and resume restores it (or note as a manual smoke).

## Self-review vs spec §4.3 / §4.4
- §4.3 unified Handled-by across channels → Tasks 2,3,4 (WA endpoint+guard, shared control; Email hidden). ✓
- §4.4 header declutter (Resolve primary, `⋯` overflow, channel badge + label) → Task 5. ✓
- Sticky-pause decoupling from `agent_active` rearm, all 4 WA send entry points guarded → Task 3. ✓
