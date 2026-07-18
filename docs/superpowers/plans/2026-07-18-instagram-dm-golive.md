# Instagram DM Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the per-channel agent gate (`channel_connections.agent_enabled`) so Instagram DMs can go live staff-only, plus the operator runbook for the Meta-side wiring.

**Architecture:** One additive migration; a pure predicate in `src/lib/agent/channels.js` gating the `runChannelAgent` call in `handleInstagramInbound`; the flag threaded through the channels API (zod schemas + patch fields) and a toggle in ConnectionsSection. Everything else (webhook, send path, inbox) already exists — the Meta wiring is an operator runbook, not code.

**Tech Stack:** Next.js 16 App Router, Supabase (migration via MCP against project `iyvtbjjxdggiadzwwvdj`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-instagram-dm-golive-design.md`
**Worktree:** `~/code/un1t-crm-igdm`, branch `instagram-dm-golive` (baseline: 7,055 tests passing)

**Repo invariants that bind this plan** (from CLAUDE.md):
- Migrations forward-only, applied via Supabase MCP `apply_migration` against the **un1t-crm** project (`iyvtbjjxdggiadzwwvdj`, NOT sentinel), then `get_advisors` (type=security). Apply BEFORE the code deploys (i.e. before the PR merges — Task 1 does it).
- CI mirror before pushing: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails` — AND `npm run build` (new import added; vitest won't catch import resolution).
- Repo test philosophy: pure helpers unit-tested; IO handlers (webhook/DB) are not unit-mocked (`parseInstagramEvents() is pure (unit-tested). The rest is IO.` — instagram.js header). The gate therefore lives in a tested pure predicate; the 3-line wiring is review + E2E verified.
- Commit style: `TICKET.X — summary`. Ticket prefix for this work: `IG-DM`.
- zsh: bracketed route paths (`[id]`) are globs — single-quote them in git/shell commands.

---

### Task 1: Migration 407 — `agent_enabled` column

**Files:**
- Create: `supabase/migrations/407_channel_connections_agent_enabled.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/407_channel_connections_agent_enabled.sql` (confirm 406 is still the latest file in `supabase/migrations/` first; if a 407 has appeared on main, renumber to the next free slot everywhere this plan says 407):

```sql
-- 407 — per-channel customer-agent gate (IG-DM).
-- agent_enabled=false (the default) means the customer agent (Mia)
-- never auto-replies on this channel; staff inbox flows (persistence,
-- unread, pushes) are unaffected. Default OFF so a freshly connected
-- channel is staff-only until an operator explicitly opts in.
alter table channel_connections
  add column if not exists agent_enabled boolean not null default false;

comment on column channel_connections.agent_enabled is
  'When false the customer agent (Mia) never auto-replies on this channel; staff inbox flows are unaffected (IG-DM, mig 407).';
```

- [ ] **Step 2: Apply to prod via Supabase MCP**

Call `mcp__…__list_projects` to confirm the un1t-crm project ref is `iyvtbjjxdggiadzwwvdj`, then `apply_migration` with name `channel_connections_agent_enabled` and the SQL above. (Additive, default false — safe to apply ahead of the code deploy; that ordering is the repo invariant.)

- [ ] **Step 3: Run security advisors**

Call `get_advisors` (type=security). Expected: no NEW findings versus the pre-existing baseline (the two intentional SECURITY DEFINER warnings from the 2026-06-10 audit remain — do not "fix" them).

- [ ] **Step 4: Verify the column exists**

Call `execute_sql`:

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'channel_connections' and column_name = 'agent_enabled';
```

Expected: one row, `boolean`, default `false`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/407_channel_connections_agent_enabled.sql
git commit -m "IG-DM.1 — mig 407: channel_connections.agent_enabled (per-channel Mia gate, default off)"
```

---

### Task 2: Pure predicate + patch fields (TDD)

**Files:**
- Modify: `src/lib/agent/channels.js` (default fields list ~line 68; new export after `buildConnectionPatch`)
- Test: `src/lib/agent/channels.test.js`

- [ ] **Step 1: Write the failing tests**

In `src/lib/agent/channels.test.js`, add `isAgentEnabledForConnection` to the existing import from `./channels`, then append:

```js
describe('isAgentEnabledForConnection', () => {
  it('null/undefined connection → false (default closed)', () => {
    expect(isAgentEnabledForConnection(null)).toBe(false)
    expect(isAgentEnabledForConnection(undefined)).toBe(false)
  })
  it('agent_enabled false or missing → false', () => {
    expect(isAgentEnabledForConnection({})).toBe(false)
    expect(isAgentEnabledForConnection({ agent_enabled: false })).toBe(false)
  })
  it('agent_enabled true → true', () => {
    expect(isAgentEnabledForConnection({ agent_enabled: true })).toBe(true)
  })
})
```

And inside the existing `describe('buildConnectionPatch', …)` block:

```js
  it('passes agent_enabled through the default fields', () => {
    const p = buildConnectionPatch({ agent_enabled: true })
    expect(p.agent_enabled).toBe(true)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/agent/channels.test.js`
Expected: FAIL — `isAgentEnabledForConnection` is not exported; the patch test fails because `agent_enabled` is not in the default fields list.

- [ ] **Step 3: Implement**

In `src/lib/agent/channels.js`:

(a) extend the default fields list in `buildConnectionPatch`:

```js
  const fields = opts.fields || ['platform', 'label', 'external_account_id', 'page_id', 'app_id', 'display_name', 'is_active', 'agent_enabled']
```

(b) add the predicate after `buildConnectionPatch` (channel-generic — applies to messenger later):

```js
/**
 * Should the customer agent auto-reply on this connection's channel?
 * Default CLOSED: a missing row or unset flag means staff-only — the
 * agent only runs when an operator has explicitly opted the channel in
 * (mig 407). Staff inbox flows are unaffected either way. Pure.
 */
export function isAgentEnabledForConnection(connection) {
  return !!connection?.agent_enabled
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/agent/channels.test.js`
Expected: PASS (all pre-existing tests in the file still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/channels.js src/lib/agent/channels.test.js
git commit -m "IG-DM.2 — isAgentEnabledForConnection predicate + agent_enabled in patch fields"
```

---

### Task 3: Gate the agent trigger + thread the field through the channels API

**Files:**
- Modify: `src/lib/agent/instagram.js` (import ~line 13; the `runChannelAgent` try/catch near the end of `handleInstagramInbound`)
- Modify: `src/app/api/locations/[id]/channels/route.js` (POST zod schema)
- Modify: `src/app/api/locations/[id]/channels/[connId]/route.js` (PATCH zod schema + explicit fields list)

- [ ] **Step 1: Gate `handleInstagramInbound`**

In `src/lib/agent/instagram.js`, extend the existing channels import:

```js
import { resolveLocationByExternalAccount, isAgentEnabledForConnection, META_GRAPH_URL } from './channels'
```

Then wrap the agent trigger at the end of `handleInstagramInbound` (currently `// Trigger the agent (shared brain). Best-effort.` followed by a try/catch around `runChannelAgent`). Replace that block with:

```js
  // Trigger the agent (shared brain). Best-effort. IG-DM.3 — gated
  // per-connection: Mia only auto-replies on channels an operator has
  // explicitly opted in (agent_enabled, mig 407). Everything above
  // (persistence, unread, staff pushes) already ran, so a gated-off
  // channel is a fully working staff-only inbox. The shared settings
  // blob can't express this: enabled/test_mode is per-location across
  // channels, and test_mode's allowlist is phone-based (IG senders have
  // IGSIDs), so the connection row is the right per-channel switch.
  if (isAgentEnabledForConnection(connection)) {
    try {
      await runChannelAgent(db, instagramAdapter, {
        conversationId,
        locationId,
        recipient: event.senderId,
        contactId,
        messageType,
        body,
        connection,
      })
    } catch (err) {
      console.error('[radar-agent] IG auto-reply failed', err?.message)
    }
  }
```

(The inner call is byte-identical to the existing one — only the `if` wrapper and comment change.)

**Spec deviation, on purpose:** the spec asks for a "staff persistence still happens when the gate is off" unit test. The repo convention is that IO handlers are not unit-mocked (see the instagram.js header), and the gate is the LAST statement in the function — every staff-side effect has already run by the time it's evaluated, which the placement above guarantees structurally. The live E2E in `docs/instagram-setup.md` (inbound lands in inbox + push arrives + Mia silent) is the real regression check. Verified during planning: `followups.js` has no IG references, and `handoff-sla.js`'s IG channel entry only acts on conversations with agent handoffs, which cannot exist while the gate is off.

- [ ] **Step 2: Add `agent_enabled` to both route schemas**

In `src/app/api/locations/[id]/channels/route.js`, add to `ChannelConnectionSchema`:

```js
  agent_enabled: z.boolean().optional(),
```

In `src/app/api/locations/[id]/channels/[connId]/route.js`, add the same line to `ChannelPatchSchema`, and extend the explicit fields list in the PATCH handler:

```js
  const patch = buildConnectionPatch(body, {
    fields: ['label', 'external_account_id', 'page_id', 'app_id', 'display_name', 'is_active', 'agent_enabled'],
  })
```

(POST uses `buildConnectionPatch(body)` with the default list, which Task 2 already extended. The channels routes are not registered in `src/lib/openapi.js` today, so there is no spec entry to update.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — same count as baseline plus the 4 new tests from Task 2 (7,059).

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/instagram.js 'src/app/api/locations/[id]/channels/route.js' 'src/app/api/locations/[id]/channels/[connId]/route.js'
git commit -m "IG-DM.3 — gate IG agent trigger on connection.agent_enabled; accept the flag in channels routes"
```

---

### Task 4: ConnectionsSection toggle

**Files:**
- Modify: `src/components/customer-agent/ConnectionsSection.jsx`

- [ ] **Step 1: Add the toggle + include it in the save payload**

In `saveInstagram()`, after the `IG_FIELDS` loop that builds `payload`, add:

```js
      payload.agent_enabled = !!draft.agent_enabled
```

In the JSX, between the fields grid (`</div>` closing `grid sm:grid-cols-2 gap-3`) and the `{error && …}` line, insert:

```jsx
        <label className="flex items-center gap-2 mt-4 cursor-pointer">
          <input
            type="checkbox"
            checked={!!draft.agent_enabled}
            onChange={e => setField('agent_enabled', e.target.checked)}
          />
          <span className="text-sm text-un1t-text">Mia auto-replies on Instagram</span>
        </label>
        <p className="text-xs text-un1t-muted mt-1">
          Off by default. Inbound DMs still land in the inbox and notify staff — Mia only answers when this is on.
        </p>
```

(`draft` is seeded from the masked connection row, and `maskConnectionRow` passes non-secret fields through, so `draft.agent_enabled` loads the saved value with no other changes. No new permission key — the section already gates on MANAGER_ROLES via the API.)

- [ ] **Step 2: Lint + guardrails**

Run: `npm run lint && npm run check:guardrails`
Expected: clean (no new chips/colours; checkbox + text only).

- [ ] **Step 3: Commit**

```bash
git add src/components/customer-agent/ConnectionsSection.jsx
git commit -m "IG-DM.4 — Mia-on-Instagram toggle in ConnectionsSection (default off)"
```

---

### Task 5: Operator runbook + CHANGELOG

**Files:**
- Create: `docs/instagram-setup.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Write the runbook**

Create `docs/instagram-setup.md` with exactly the §2 (Meta wiring, steps 1–10), §3 (verification), and §4 (App Review) content from the spec (`docs/superpowers/specs/2026-07-18-instagram-dm-golive-design.md`), reformatted as a standalone operator doc titled `# Instagram DM setup — operator runbook`, plus the spec's Known limitations and Rollback sections verbatim. Add one intro line pointing back to the spec. Do not paraphrase the token steps — the Never-expire system-user token and the derived-Page-token steps (spec §2 steps 6–7) must survive word-for-word; those are the two trap-avoiders.

- [ ] **Step 2: CHANGELOG entry**

Read the last numbered entry in `docs/CHANGELOG.md` and append the next number:

```
#NNN IG-DM — Instagram DM go-live groundwork: per-channel agent gate (mig 407, agent_enabled default off), gated IG agent trigger, ConnectionsSection Mia toggle, operator runbook docs/instagram-setup.md. Meta wiring + E2E tracked in the runbook; App Review for instagram_manage_messages deferred until the WA Tech Provider decision.
```

- [ ] **Step 3: Commit**

```bash
git add docs/instagram-setup.md docs/CHANGELOG.md
git commit -m "IG-DM.5 — operator runbook (Meta wiring + E2E) and CHANGELOG entry"
```

---

### Task 6: CI mirror, build, PR

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`
Expected: all six green (no new routes → route-guards unchanged; no new permission keys → parity unchanged).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: build succeeds (this is the only check that catches the new import in instagram.js failing to resolve).

- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "IG-DM — Instagram DM go-live: per-channel agent gate + operator runbook" --body "$(cat <<'EOF'
## Summary
- mig 407 (**already applied to prod** via MCP, advisor-clean): `channel_connections.agent_enabled`, default **false**
- `handleInstagramInbound` only triggers Mia when the connection opts in — a freshly connected IG account is a staff-only inbox (persistence, unread, pushes unaffected)
- `agent_enabled` accepted by the channels POST/PATCH routes; "Mia auto-replies on Instagram" toggle in ConnectionsSection (default off)
- `docs/instagram-setup.md` — operator runbook: Meta wiring (Never-expire system-user token → derived Page token), E2E verification, App Review sequencing (deferred until the WA Tech Provider decision lands)

Spec: docs/superpowers/specs/2026-07-18-instagram-dm-golive-design.md
WhatsApp paths untouched (WA does not use channel_connections).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report the PR URL.

---

### Post-merge (operator phase, with Richard — not part of this branch)

Follow `docs/instagram-setup.md` together in the browser: confirm the IG account is Professional + Page-linked → enable Connected-tools message access in the IG app → subscribe the `instagram`/`messages` webhook on app `1650634536237918` → system-user token (Never expire) → derive the Page token → subscribe the Page to the app → fetch the IG business account id → paste into ConnectionsSection with the Mia toggle OFF → E2E from an app-role IG account → trigger the feed-sync cron to light up the events-page strip. App Review for `instagram_manage_messages` only after Meta's WA Tech Provider decision.
