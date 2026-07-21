# Design — Auto-handoff on repeated identity-verification failure

- **Date:** 2026-07-21
- **Status:** Approved (design), pending spec review
- **Area:** Mia customer agent — `src/lib/agent/{auto-reply,core,account-tools,prompt}.js`
- **Related:** PR #1011 (verify against all contacts on the sender's number); `[[agent-dupe-phone-reauth]]`; existing handoff machinery (`handoff()`, `[[HANDOFF]]` protocol, `handoff-sla.js`).

## Problem

When Mia can't verify a customer, `verify_identity` returns `{ verified: false }` and the prompt tells her to keep asking for the email + surname. There is **no deterministic give-up**: she can loop indefinitely. Richard hit exactly this — three consecutive "I can't match those details" replies with no escape to a human. The model *can* emit `[[HANDOFF]]`, but nothing instructs or forces it to after repeated verify failures, so in practice it keeps re-asking.

**Goal:** after N failed verification attempts in a conversation, Mia stops asking and hands off to a human (existing handoff path). N defaults to **2**.

## Scope

- The counter lives on the **email + surname quiz path only** (the `verify_identity` tool). That path is reached only when phone pre-verification (`resolveAutoVerify`) does not carry the sender: Instagram always (no phone), or WhatsApp with an unknown / ambiguous / stale-verification number. Phone-auto-verified senders never call `verify_identity`, so the counter never moves for them.
- Applies to **both** WhatsApp and Instagram (the tool loop in `auto-reply.js` is channel-agnostic via adapters; only the migration touches both conversation tables).
- **Out of scope:** a settings-UI field for the threshold (v1 reads the settings blob with a default; no new UI); the broader duplicate-contacts-per-number data problem; any change to phone pre-verification.

## Design

### Data

Migration adds one column to **both** conversation tables:

```sql
alter table whatsapp_conversations
  add column if not exists agent_verify_attempts smallint not null default 0;
alter table instagram_conversations
  add column if not exists agent_verify_attempts smallint not null default 0;
```

`agent_verify_attempts` = count of consecutive failed `verify_identity` attempts on this conversation since the last success / re-arm. Forward-only, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj` before the code deploys; `get_advisors` after.

### Threshold config (pure helper, `core.js`)

```js
export const VERIFY_FAIL_HANDOFF_DEFAULT = 2
// 0 / negative disables the auto-handoff. Mirrors resolveHandoffSlaMinutes.
export function resolveVerifyFailHandoff(settings) { … }  // default 2
```

Read from the agent settings blob (same blob as `effort`, `handoff_sla_minutes`). No UI field in v1 — tunable directly in the settings row if ever needed.

### Decision helper (pure, `core.js`)

```js
// True when this many consecutive failures should trigger a handoff.
export function shouldHandoffAfterVerifyFail(attempts, threshold) {
  return threshold > 0 && attempts >= threshold
}
```

### Control flow (`auto-reply.js`)

1. **Load** `agent_verify_attempts` in the existing conversation select (line ~243). Seed a local `verifyFails = conv.agent_verify_attempts ?? 0`.
2. **In the tool loop** (~508–537), for each `verify_identity` tool result:
   - `verified: true` → `verifyFails = 0` (alongside the existing primary-resolve block).
   - `verified: false` → `verifyFails += 1`.
3. **After the loop, before sending the model's text:** if `shouldHandoffAfterVerifyFail(verifyFails, threshold)`, call the existing `handoff(db, adapter, { …common, reason: 'verify_failed', settings })` **instead of** `sendAndLog(parsed.text)`, then reset `agent_verify_attempts = 0`. This sits next to the existing `parsed.action === 'handoff'` branch (line ~578) and reuses its holding-message + manager-page + SLA-escalation behaviour. Return `{ handled: true, action: 'handoff', reason: 'verify_failed' }`.
4. **Persist** the new `verifyFails` to `agent_verify_attempts` when it changed and no handoff fired (i.e. a still-under-threshold failure, or a reset on success).
5. **Reset to 0** also on agent re-arm (the cooldown update at line ~277) so a returning customer starts clean.

The model's own `[[HANDOFF]]` path is unchanged and still wins if the model decides to hand off earlier for another reason.

### Prompt (secondary, non-load-bearing)

Add one line to the "When to hand off" list in `prompt.js` so Mia's *tone* stays coherent as she approaches the limit ("if you've asked for their details a couple of times and still can't match them, hand off"). The server-side counter remains the guarantee; the prompt line just avoids a jarring final "try again" immediately before the handoff.

### Customer & team experience

- **Customer:** the standard operator-editable handoff holding message ("passing you to a UN1T team member now"). The no-reveal rule stands — never "that's not the email we have".
- **Team:** internal handoff reason `verify_failed` → surfaced as "couldn't verify identity (N attempts)" so staff know to identify the person manually. The `handoff-sla.js` sweep re-alerts if nobody picks it up.

## Edge cases

- **Multiple `verify_identity` calls in one turn** (rare): each failure increments; the threshold is evaluated once after the turn's tool blocks are processed.
- **Success after failures:** resets to 0, no handoff.
- **Pre-verified sender:** the prompt tells the model not to call `verify_identity`; if it does and it matches, that resets to 0 — no spurious handoff.
- **Threshold disabled** (`0`/negative): never auto-hands-off; today's behaviour.
- **Handoff already fired / agent inactive:** the turn short-circuits before the loop (existing `agent_active === false` guard), so no double-count.

## Testing

- Pure: `resolveVerifyFailHandoff` (default 2, override, 0/negative disables); `shouldHandoffAfterVerifyFail` (below/at/above threshold, disabled).
- Tool-loop behaviour: two consecutive `verified:false` results → `handoff` fired with reason `verify_failed`, no customer retry text sent; a `verified:true` between failures resets so no handoff; threshold `0` never hands off. Cover WhatsApp and Instagram adapters.
- Migration parity: column exists on both conversation tables (schema assertion in the migration; verified via MCP after apply).

## Files

- `supabase/migrations/NNN_agent_verify_attempts.sql` (new)
- `src/lib/agent/core.js` — `resolveVerifyFailHandoff`, `shouldHandoffAfterVerifyFail`, `VERIFY_FAIL_HANDOFF_DEFAULT`
- `src/lib/agent/auto-reply.js` — load/increment/reset counter, force-handoff branch
- `src/lib/agent/prompt.js` — one handoff-list line
- Tests alongside each; `docs/CHANGELOG.md` entry.
