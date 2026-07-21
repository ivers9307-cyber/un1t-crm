# Auto-handoff on repeated verification failure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After N (default 2) consecutive failed `verify_identity` attempts in a Mia conversation, stop asking and hand off to a human via the existing handoff path.

**Architecture:** A `smallint` counter (`agent_verify_attempts`) on both conversation tables tracks consecutive verify failures. The auto-reply tool loop updates it via pure helpers in `core.js`; after the loop, if the count reaches the threshold, it calls the existing `handoff()` instead of sending the model's retry text. Counter resets on success, on the forced handoff, and on agent re-arm.

**Tech Stack:** Next.js 16 / Node, Supabase (Postgres, supabase-js service client), Vitest. Anthropic Messages API (Mia). Spec: `docs/superpowers/specs/2026-07-21-agent-verify-failure-handoff-design.md`.

**Working directory:** worktree `/Users/richardivers/code/un1t-crm-vfail`, branch `agent-verify-fail-handoff` (off `origin/main`).

**Design note (intentional simplification vs spec):** the spec proposed a secondary prompt line. Dropped — the deterministic handoff already discards the model's pre-handoff "try again" text (the customer sees only the holding message), so the prompt nudge adds nothing and risks the model handing off after 1 failure instead of 2. Counter is the single source of truth.

---

## File structure

- **Create** `supabase/migrations/433_agent_verify_attempts.sql` — the column on both conversation tables.
- **Modify** `src/lib/agent/core.js` — 4 pure helpers (threshold default, resolver, decision, counter arithmetic).
- **Modify** `src/lib/agent/core.test.js` — tests for the 4 helpers.
- **Modify** `src/lib/agent/auto-reply.js` — import helpers; load/update/reset/persist the counter; force-handoff branch.
- **Modify** `docs/CHANGELOG.md` — Done entry.

---

## Task 1: Migration — `agent_verify_attempts` column

**Files:**
- Create: `supabase/migrations/433_agent_verify_attempts.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/433_agent_verify_attempts.sql`:

```sql
-- AGENT-VERIFY-HANDOFF.1 — track consecutive failed identity-verification
-- attempts per conversation so Mia can auto-hand-off after N (default 2)
-- instead of looping the customer on the email+surname quiz.
--
-- Incremented in the agent auto-reply loop on each verify_identity failure,
-- reset to 0 on success, on the forced handoff, and on agent re-arm. NULL is
-- never stored (NOT NULL DEFAULT 0). Present on BOTH channel conversation
-- tables so the shared loop behaves identically for WhatsApp and Instagram.
-- A constant DEFAULT makes this a metadata-only add (no table rewrite).

alter table public.whatsapp_conversations
  add column if not exists agent_verify_attempts smallint not null default 0;

alter table public.instagram_conversations
  add column if not exists agent_verify_attempts smallint not null default 0;

comment on column public.whatsapp_conversations.agent_verify_attempts is
  'AGENT-VERIFY-HANDOFF.1 — consecutive failed verify_identity attempts; reset on success/handoff/re-arm.';
comment on column public.instagram_conversations.agent_verify_attempts is
  'AGENT-VERIFY-HANDOFF.1 — consecutive failed verify_identity attempts; reset on success/handoff/re-arm.';
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Apply against the un1t-crm project (ref `iyvtbjjxdggiadzwwvdj` — confirm via `list_projects`, NOT the sentinel project). Use `apply_migration` with name `agent_verify_attempts` and the SQL above. Migrations are forward-only and must be applied BEFORE the dependent code deploys.

- [ ] **Step 3: Verify the column exists on both tables**

Run this via MCP `execute_sql`:

```sql
select table_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema='public' and column_name='agent_verify_attempts'
order by table_name;
```

Expected: two rows (`instagram_conversations`, `whatsapp_conversations`), `data_type=smallint`, `column_default=0`, `is_nullable=NO`.

- [ ] **Step 4: Run security advisors**

Run MCP `get_advisors` with `type=security`. Expected: no NEW errors/warnings attributable to this change (adding a plain column introduces none).

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-vfail
git add supabase/migrations/433_agent_verify_attempts.sql
git commit -m "AGENT-VERIFY-HANDOFF.1 — mig 433: agent_verify_attempts on both conversation tables"
```

---

## Task 2: Pure helpers in `core.js` (TDD)

**Files:**
- Modify: `src/lib/agent/core.js` (add after `resolveAgentEffort`, ~line 519)
- Test: `src/lib/agent/core.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/agent/core.test.js`:

```js
import {
  resolveVerifyFailHandoff,
  shouldHandoffAfterVerifyFail,
  nextVerifyAttempts,
  VERIFY_FAIL_HANDOFF_DEFAULT,
} from './core'

describe('resolveVerifyFailHandoff', () => {
  it('defaults to 2 when unset or non-numeric', () => {
    expect(resolveVerifyFailHandoff(null)).toBe(2)
    expect(resolveVerifyFailHandoff({})).toBe(2)
    expect(resolveVerifyFailHandoff({ handoff_after_verify_failures: 'x' })).toBe(2)
    expect(VERIFY_FAIL_HANDOFF_DEFAULT).toBe(2)
  })
  it('honours a positive override (rounded)', () => {
    expect(resolveVerifyFailHandoff({ handoff_after_verify_failures: 3 })).toBe(3)
    expect(resolveVerifyFailHandoff({ handoff_after_verify_failures: 2.6 })).toBe(3)
  })
  it('treats 0 / negative as disabled', () => {
    expect(resolveVerifyFailHandoff({ handoff_after_verify_failures: 0 })).toBe(0)
    expect(resolveVerifyFailHandoff({ handoff_after_verify_failures: -1 })).toBe(0)
  })
})

describe('shouldHandoffAfterVerifyFail', () => {
  it('true at or above a positive threshold', () => {
    expect(shouldHandoffAfterVerifyFail(2, 2)).toBe(true)
    expect(shouldHandoffAfterVerifyFail(3, 2)).toBe(true)
  })
  it('false below the threshold', () => {
    expect(shouldHandoffAfterVerifyFail(1, 2)).toBe(false)
    expect(shouldHandoffAfterVerifyFail(0, 2)).toBe(false)
  })
  it('never fires when disabled (threshold 0)', () => {
    expect(shouldHandoffAfterVerifyFail(5, 0)).toBe(false)
  })
})

describe('nextVerifyAttempts', () => {
  it('increments on an explicit failure', () => {
    expect(nextVerifyAttempts(0, { verified: false })).toBe(1)
    expect(nextVerifyAttempts(1, { verified: false })).toBe(2)
  })
  it('resets to 0 on success', () => {
    expect(nextVerifyAttempts(3, { verified: true })).toBe(0)
  })
  it('leaves the count unchanged for a non-verify result', () => {
    expect(nextVerifyAttempts(2, null)).toBe(2)
    expect(nextVerifyAttempts(2, { requested: true })).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/richardivers/code/un1t-crm-vfail
npx vitest run src/lib/agent/core.test.js
```

Expected: FAIL — `resolveVerifyFailHandoff is not a function` (and the other two undefined).

- [ ] **Step 3: Implement the helpers**

In `src/lib/agent/core.js`, immediately AFTER the `resolveAgentEffort` function (the line `}` closing it, ~line 519), add:

```js

// AGENT-VERIFY-HANDOFF.1 — auto-hand-off after repeated identity-verification
// failures so Mia can't loop a customer on the email+surname quiz. The count
// lives on the conversation (agent_verify_attempts); these pure helpers own the
// threshold + counter arithmetic so the auto-reply wiring stays thin.
export const VERIFY_FAIL_HANDOFF_DEFAULT = 2

// Per-location threshold from the agent settings blob. 0/negative disables the
// auto-handoff. Mirrors resolveHandoffSlaMinutes. Pure.
export function resolveVerifyFailHandoff(settings) {
  const raw = Number(settings?.handoff_after_verify_failures)
  if (!Number.isFinite(raw)) return VERIFY_FAIL_HANDOFF_DEFAULT
  return raw > 0 ? Math.round(raw) : 0
}

// Should this many consecutive failed attempts trigger a handoff? Pure.
export function shouldHandoffAfterVerifyFail(attempts, threshold) {
  return threshold > 0 && (Number(attempts) || 0) >= threshold
}

// New failed-attempt count given a verify_identity tool result: reset to 0 on
// success, +1 on an explicit failure, unchanged for any other result. Pure.
export function nextVerifyAttempts(current, result) {
  const n = Number(current) || 0
  if (!result || typeof result.verified !== 'boolean') return n
  return result.verified ? 0 : n + 1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/agent/core.test.js
```

Expected: PASS (all existing core tests plus the new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/core.js src/lib/agent/core.test.js
git commit -m "AGENT-VERIFY-HANDOFF.1 — pure helpers: verify-fail threshold + counter arithmetic"
```

---

## Task 3: Wire the counter into the auto-reply loop

**Files:**
- Modify: `src/lib/agent/auto-reply.js`

No new pure logic here — the behaviour is proven by Task 2's helper tests. This task is the thin wiring; verify it via the full CI mirror + `next build` (Step 8), which catches the import/select/typo class this task can introduce. The full model loop is not unit-tested in this codebase (the metered `anthropicMessages` wrapper isn't mocked in `auto-reply*.test.js`), so do NOT fabricate a loop test — rely on the helper tests + build/CI + the post-merge live check in Task 5.

- [ ] **Step 1: Import the helpers**

In `src/lib/agent/auto-reply.js`, in the `from './core'` import block (~lines 28–39, currently ending `shouldNotifyAgentActivity,`), add three names. Change:

```js
  resolveAutoVerify,
  resolveActingContactId,
  shouldNotifyAgentActivity,
} from './core'
```

to:

```js
  resolveAutoVerify,
  resolveActingContactId,
  shouldNotifyAgentActivity,
  resolveVerifyFailHandoff,
  shouldHandoffAfterVerifyFail,
  nextVerifyAttempts,
} from './core'
```

- [ ] **Step 2: Load the counter in the conversation select**

Find (~line 245):

```js
    .select(`agent_active, agent_handed_off_at, contact_id, agent_verified_contact_id, agent_verified_at, agent_last_reply_at, agent_activity_notified_at${nameCol ? `, ${nameCol}` : ''}`)
```

Replace with (adds `agent_verify_attempts`):

```js
    .select(`agent_active, agent_handed_off_at, contact_id, agent_verified_contact_id, agent_verified_at, agent_last_reply_at, agent_activity_notified_at, agent_verify_attempts${nameCol ? `, ${nameCol}` : ''}`)
```

- [ ] **Step 3: Reset the counter on agent re-arm**

Find (~line 279):

```js
        .update({ agent_active: true, agent_handed_off_at: null })
```

Replace with:

```js
        .update({ agent_active: true, agent_handed_off_at: null, agent_verify_attempts: 0 })
```

- [ ] **Step 4: Resolve the threshold**

Find (~line 486):

```js
    const agentEffort = resolveAgentEffort(settings?.effort)
```

Add immediately AFTER it:

```js
    const verifyFailThreshold = resolveVerifyFailHandoff(settings)
```

- [ ] **Step 5: Declare the running counter before the model loop**

Find (~line 512):

```js
    let modelText = ''
```

Add immediately BEFORE it:

```js
    let verifyFails = conv?.agent_verify_attempts ?? 0
```

- [ ] **Step 6: Update the counter inside the tool loop**

Find the verify-success block (~lines 558–572):

```js
            if (block.name === 'verify_identity' && result?.verified) {
              // Re-read the contact id the server just stamped so the
              // follow-up lookups in this same turn are authorised.
              const { data: fresh } = await db.from(adapter.conversationsTable)
                .select('agent_verified_contact_id')
                .eq('id', conversationId)
                .single()
              const rawVerified = fresh?.agent_verified_contact_id || toolCtx.verifiedContactId
              // AGENT-AUTH.2 — act on the person's PRIMARY account, not whichever
              // duplicate the email+surname quiz happened to match.
              const r = await personGroupResolver(db, [rawVerified])
              toolCtx.verifiedContactId = resolveActingContactId({
                contactId: rawVerified, groupOf: r.groupOf, primaryOf: r.primaryOf,
              }) || rawVerified
            }
```

Replace with (wrap in a `verify_identity` guard, update the counter, keep the success path nested):

```js
            if (block.name === 'verify_identity') {
              // AGENT-VERIFY-HANDOFF.1 — track consecutive failures so a stuck
              // quiz hands off (reset on success, +1 on failure).
              verifyFails = nextVerifyAttempts(verifyFails, result)
              if (result?.verified) {
                // Re-read the contact id the server just stamped so the
                // follow-up lookups in this same turn are authorised.
                const { data: fresh } = await db.from(adapter.conversationsTable)
                  .select('agent_verified_contact_id')
                  .eq('id', conversationId)
                  .single()
                const rawVerified = fresh?.agent_verified_contact_id || toolCtx.verifiedContactId
                // AGENT-AUTH.2 — act on the person's PRIMARY account, not whichever
                // duplicate the email+surname quiz happened to match.
                const r = await personGroupResolver(db, [rawVerified])
                toolCtx.verifiedContactId = resolveActingContactId({
                  contactId: rawVerified, groupOf: r.groupOf, primaryOf: r.primaryOf,
                }) || rawVerified
              }
            }
```

- [ ] **Step 7: Force the handoff (and persist the count) after the loop**

Find the human-takeover guard and the model-handoff branch (~lines 615–622):

```js
    if (await humanTookOverDuringTurn(db, adapter, conversationId, turnStartIso)) {
      return { handled: false, reason: 'human_took_over' }
    }

    if (parsed.action === 'handoff') {
```

Insert the new block BETWEEN the takeover guard's closing `}` and `if (parsed.action === 'handoff') {`, so it reads:

```js
    if (await humanTookOverDuringTurn(db, adapter, conversationId, turnStartIso)) {
      return { handled: false, reason: 'human_took_over' }
    }

    // AGENT-VERIFY-HANDOFF.1 — after N failed verify_identity attempts (default
    // 2), stop asking and hand off. Deterministic server-side counter so a model
    // that would keep re-asking can't loop the customer; the model's retry text
    // for this turn is discarded in favour of the handoff holding message. The
    // SLA sweep re-alerts if nobody picks it up.
    if (shouldHandoffAfterVerifyFail(verifyFails, verifyFailThreshold)) {
      try {
        await db.from(adapter.conversationsTable)
          .update({ agent_verify_attempts: 0 })
          .eq('id', conversationId)
      } catch { /* handoff still proceeds; the next re-arm resets anyway */ }
      await handoff(db, adapter, { ...common, reason: 'verify_failed', settings })
      return { handled: true, action: 'handoff', reason: 'verify_failed' }
    }

    // Persist the running attempt count when it changed (an under-threshold
    // failure, or a reset after a success). Best-effort; a turn with no verify
    // attempt leaves it unchanged and writes nothing.
    if (verifyFails !== (conv?.agent_verify_attempts ?? 0)) {
      try {
        await db.from(adapter.conversationsTable)
          .update({ agent_verify_attempts: verifyFails })
          .eq('id', conversationId)
      } catch { /* next turn recomputes from the stored value */ }
    }

    if (parsed.action === 'handoff') {
```

- [ ] **Step 8: Run the full CI mirror + build**

```bash
cd /Users/richardivers/code/un1t-crm-vfail
npx vitest run && npx eslint src/lib/agent/auto-reply.js src/lib/agent/core.js && npm run check:guardrails && npm run build
```

Expected: all tests pass, lint clean, guardrails clean, `next build` succeeds. (If `node_modules` is a symlink to the primary worktree, that's fine for these.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent/auto-reply.js
git commit -m "AGENT-VERIFY-HANDOFF.1 — auto-hand-off after N failed verify_identity attempts"
```

---

## Task 4: Changelog + PR

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add the Done entry**

In `docs/CHANGELOG.md`, insert a new row directly after the table header separator line (`|---|------|-------|`), above the current top row:

```markdown
| 398 | Mia — auto-hand-off after repeated identity-verification failure | After **N (default 2)** consecutive failed `verify_identity` attempts in a conversation, Mia stops re-asking and hands off to a human instead of looping the email+surname quiz (Richard hit a 3× loop). **Mig 433** adds `agent_verify_attempts smallint NOT NULL DEFAULT 0` to `whatsapp_conversations` + `instagram_conversations`. Counting lives in pure `core.js` helpers (`resolveVerifyFailHandoff` — settings `handoff_after_verify_failures`, 0 disables; `shouldHandoffAfterVerifyFail`; `nextVerifyAttempts`); `auto-reply.js` seeds the counter from the conversation, updates it per `verify_identity` result in the tool loop (reset on success, +1 on failure), and after the loop — if the threshold is met — calls the existing `handoff()` (reason `verify_failed`; standard holding message + manager page + SLA re-alert), discarding the model's retry text. Counter resets on success, on the forced handoff, and on agent re-arm. Only the email-quiz path is affected (phone-auto-verified senders never call `verify_identity`); WhatsApp + Instagram via the shared loop. No settings-UI field in v1 (tunable via the settings blob). |
```

- [ ] **Step 2: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: changelog #398 — Mia verify-failure auto-handoff"
```

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "Mia: auto-hand-off after repeated identity-verification failure" --body "Implements docs/superpowers/specs/2026-07-21-agent-verify-failure-handoff-design.md. Mig 433 (applied) + pure helpers + auto-reply wiring. Hands off after 2 failed verify_identity attempts (configurable, 0 disables). WhatsApp + Instagram. Full CI mirror + next build green."
```

- [ ] **Step 4: Watch PR checks**

```bash
gh pr checks --watch --interval 20
```

Expected: `Next build`, `Test & lint`, `Vercel` all pass.

---

## Task 5: Post-merge live verification

- [ ] **Step 1:** After merge + Vercel prod deploy, from the WhatsApp test number send a booking/account request and give a **wrong** email+surname twice. Expected: after the 2nd failure Mia sends the handoff holding message (not a 3rd "try again"), the conversation flips `agent_active=false`, and managers get the handoff page.
- [ ] **Step 2:** Verify recovery — a fresh conversation (or after re-arm) that gives correct details on the first try still verifies normally (counter reset works). Confirm via `select agent_verify_attempts, agent_active from whatsapp_conversations where id = '<id>'`.

---

## Self-review notes

- **Spec coverage:** column (Task 1) ✓; threshold config default 2 / 0 disables (Task 2 `resolveVerifyFailHandoff`) ✓; increment/reset/threshold (Task 2 `nextVerifyAttempts` + `shouldHandoffAfterVerifyFail`) ✓; force-handoff reusing `handoff()` with reason `verify_failed` (Task 3 Step 7) ✓; reset on success/handoff/re-arm (Task 3 Steps 3, 6, 7) ✓; WA+IG parity (mig both tables + shared loop) ✓; internal reason wording (`verify_failed`) ✓. The spec's optional prompt line is intentionally dropped (documented above).
- **Types/names consistent:** `resolveVerifyFailHandoff`, `shouldHandoffAfterVerifyFail`, `nextVerifyAttempts`, `VERIFY_FAIL_HANDOFF_DEFAULT`, `agent_verify_attempts`, `verifyFails`, `verifyFailThreshold`, settings key `handoff_after_verify_failures` — used identically across tasks.
- **No placeholders:** every code/SQL block is complete; migration number 433 is the next after 432.
