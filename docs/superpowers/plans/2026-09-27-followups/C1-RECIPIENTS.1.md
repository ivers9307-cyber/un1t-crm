## PR RECIPIENTS.1: a failed "who are the managers" read is never "nobody to tell"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every reader of "who holds these roles at this studio" can tell a failed read from an empty answer. A failed read is logged with `logError`, claims no send-once key, and is reported in the result (`recipients_failed`). Callers that can retry do (next tick, or the next daily run). The cron arms that have their own heartbeat count it as an arm fault. `resolveRoleRecipientIds`, which turns a failed read into `[]`, is left with zero callers, ready to delete after one deploy.

**Why:** Row C1 of `00-INDEX.md` (Batch C, silent failures). `resolveRoleRecipientIds` (`src/lib/push.js:365-367`) returns `(await readRoleRecipientIds(...)).ids`, and `readRoleRecipientIds` (`:378-397`) answers `{ ids: [], error }` on a failed `profile_locations` read. The wrapper drops the error, so every caller sees "nobody holds the role here" and carries on as if that were true. REPLACE.1b review 1 hit this exact shape (a "taken" notice stamped itself done on the empty list) and added `readRoleRecipientIds` for that one path (`src/lib/shift-offer-server.js:174`). This PR moves every other caller onto it. The CLAUDE.md rule governs the whole design: **"Removing a silent failure must NEVER create a louder one"**. So a failed read must lead to a retry or an unstamped state. It must never cost a notice that would otherwise have gone, and it must never kill a job.

**Architecture:** Nothing throws. Four layers:
1. `push.js` gains a pure `roleRecipientIdsFromLinks(links, roles)` (the rule, extracted unchanged from `readRoleRecipientIds`).
2. The three role fan-out wrappers switch to `readRoleRecipientIds`: `sendPushToRolesAtLocation` (`push.js:408`), `sendPushToRolesAtLocationOnce` and `notifyUsersAtRolesOnce` (`push-dedup.js:150, 159`). On a failed read each one logs once with `logError`, sends nothing, claims nothing, and returns its usual zero counts plus `recipients_failed: 1`. That gives 28 fire-and-forget call sites a structured log without touching them.
3. The callers that decide something from the list are changed one by one:
   - the equipment sweep and the equipment reminder;
   - the Hyrox reminder;
   - the swap-cover sweep and the open-pool broadcast;
   - the roster-runway arm and its heartbeat predicate.
4. A guard test pins that nothing outside `push.js` names `resolveRoleRecipientIds`. The dead `notifyUsersAtRoles` (zero callers) is deleted.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase PostgREST via the service-role client, Vitest (node).

**Size / ships:** M. **Web only. No migration. No OTA.** `git grep` finds no caller in `shared/` or `mobile/`. The only mention there is a comment naming `sendPushToRolesAtLocation` in `mobile/lib/notification-nav.js:2`, which is unchanged. No new route and no new permission key, so `check:route-guards`, `check:mobile-parity` and `src/lib/openapi.js` are untouched. No `.select()` string changes.

**Depends on:** nothing unmerged. Written against `origin/main` at `28d02e59` (#1779 DUBLINDAY.1); every path and line below was checked against that tree. Wave 3 pairs this PR with C2 CLASSSYNCHB.1, which is migration-only and touches none of these files. **Conflict hotspots:**
- `src/lib/push.js` (only this PR in the program);
- `src/lib/swap-cover-server.js` and `src/lib/cron-arm-health.js`. C5 REPLACENITS.1 (Wave 5) touches the send-push-reminders cron, which is not a file here. If a later row lands first in `cron-arm-health.js`, rebase: the runway predicate is a separate function.

---

### What was found (verified against `origin/main` `28d02e59`, and prod read-only on 27 Sep 2026)

**The helper pair** (`src/lib/push.js`):
- `resolveRoleRecipientIds(db, locationId, roles)` (:365-367) returns ids only, and `[]` on a failed read (the docstring at :362-363 says so).
- `readRoleRecipientIds(db, locationId, roles)` (:378-397):
  - no location or no roles → `{ ids: [], error: null }` (:379);
  - otherwise one `profile_locations` read with `profiles!inner(id, role, active)`, `.eq('location_id', …)` (:380-383); on error → `{ ids: [], error }` (:384);
  - the rule (:393-395): active profile, and (per-location role in `roles`, or global role `master`).

**Every direct caller of `resolveRoleRecipientIds`** (`git grep -n "resolveRoleRecipientIds" origin/main -- src shared mobile scripts tests`; non-test hits only):

| # | Caller | What a failed read does TODAY | After this PR |
|---|---|---|---|
| 1 | `src/lib/push.js:410` `sendPushToRolesAtLocation` | `ids = []` → returns zero counts. Indistinguishable from "nobody holds the role". Not logged. | `logError('push', …)`, returns zeros + `recipients_failed: 1`. Its call sites are listed below. |
| 2 | `src/lib/push-dedup.js:151` `sendPushToRolesAtLocationOnce` | `sendOnce(…, [])` → `EMPTY` (`:84`). No claim, not logged. | `logError('push-dedup', …)`, returns `EMPTY` + `recipients_failed: 1`. Nothing is claimed, so a later call with the same key still sends. |
| 3 | `src/lib/push-dedup.js:160` `notifyUsersAtRolesOnce` | the same as 2 | the same as 2 |
| 4 | `src/lib/notify.js:201` `notifyUsersAtRoles` | `notifyUsers([])` → zeros | **Deleted.** Zero callers anywhere (`git grep "notifyUsersAtRoles[^O]"` finds only its definition and a docstring in `push-dedup.js:156`). |
| 5 | `src/app/api/cron/equipment-inspection-sweep/route.js:68` (daily 19:00 UTC, dedup key `equip-overdue:<loc>:<today>`) | `ids = []` → no push, no claim. The audit row is still written and the result says `pushed: false`, **the same as a studio with no owner**. The heartbeat stamps. Nothing retries that day. | `readRoleRecipientIds`; on error `logError`, no push, the result row carries `recipients_failed: true`, and the audit row is still written (it records the overdue count, which is true). The heartbeat still stamps (D8). Tomorrow's 19:00 run chases again (the asset is still overdue; the key is per day). |
| 6 | `src/lib/hyrox/reminder-runner.js:63` (cron every 5 min; claim = `hyrox_class_reminders` unique `(location_id, class_starts_at)`) | **The claim is taken FIRST (:38-43)**, then the on-shift RPC (:58-61), then the fallback roles read. A failed read → `[]` → `continue` with the claim kept (:66). **The reminder is lost for good.** Every later tick finds the class claimed. | Recipients are worked out BEFORE the claim (D7). A failed fallback read → `logError`, `stats.recipients_failed++`, nothing claimed. The next tick (5 min later, still inside the 30-minute lead) tries again. |
| 7 | `src/lib/swap-cover-server.js:89` `notifyOpenPool` (the `managerIds` passed to the pure rule) | `managerIds = []`. **Harmless**: `openPoolRecipients` also drops a manager by its link row (`isManagerLink`, `src/lib/swap-cover.js:88-93`; pinned by `swap-cover-server.test.js:210-214`). The read is redundant. | The second read is gone: `managerIds` comes from the members read already in hand, through the SAME rule (`roleRecipientIdsFromLinks`) (D6). |
| 8 | `src/lib/swap-cover-server.js:283` sweep nudge (T-48h / T-12h to approvers; arm of `checklist-sweep`, own heartbeat `swap-cover-sweep`) | `approvers = []` → `result = null` → `stats.skipped++` (:285-287). **Counted as "nothing to do"**: not an error, so the arm stamps. The stage is a RANGE (`COVER_NUDGE_STAGES`, `swap-cover.js`), and no key was claimed, so the next tick does retry. But a read that keeps failing never shows. | `readRoleRecipientIds`; on error `logError` + `stats.errors++` (an arm fault, `checklist-sweep/route.js:110`), nothing claimed, and the next tick retries (D5). |
| 9 | roster-runway arm, via `notifyUsersAtRolesOnce` (`src/lib/roster-runway-notify.js:154`) | `r` = EMPTY → `sent/failed/deduped` += 0. **Reads as a clean run**: `runwayArmHealthy` (`src/lib/cron-arm-health.js:75-78`) passes, and `roster-runway` stamps. No key is claimed, so the next DAILY run retries while the week is still unready. | `outcome.recipients_failed += r.recipients_failed \|\| 0`, and `runwayArmHealthy` treats `recipients_failed > 0` as a fault (D4). Retry is unchanged (the next daily run; the key is unclaimed). |

Already on `readRoleRecipientIds`: `src/lib/shift-offer-server.js:174` (REPLACE.1b). Not callers, they re-read with their own query and keep the error: `src/lib/availability-notify.js` (comment :7-9), `src/lib/qualification-digest.js` (comment :9-10). Only comments name the helper in `src/lib/swap-cover.js:88, 120` and `src/lib/roster-runway-notify.js:28, 45`. Task 8 rewrites those comments so the guard test can hold.

**Transitive callers: the ones that go through the three wrappers.** Checked with `git grep -n "sendPushToRolesAtLocation\|sendPushToRolesAtLocationOnce\|notifyUsersAtRolesOnce" origin/main -- src shared mobile`. All of them act first (flip a status, stamp a row, commit the request), then push best-effort, one-shot, and none of them retries a failed Expo send either. For all of them a failed recipients read today is a silent lost notice. After this PR it is a `logError` from the wrapper (D9). Code changes only where a caller records something false:

| Caller | Shape | Change |
|---|---|---|
| `src/app/api/cron/equipment-inspection-reminder/route.js:60` (weekly inspection day, 06:00 UTC) | Records `pushed: true` and audits `equipment.inspection_reminder_sent` whatever happened (:42-50) | **Changed** (D8): on `recipients_failed` the row says `pushed: false, recipients_failed: true` and no "reminder_sent" audit is written. The same-day 19:00 overdue sweep is the recovery. |
| `src/app/api/cron/checklist-sweep/route.js:234` compliance push | After `markIncomplete` flipped the row (:197); one-shot | wrapper log only |
| `src/app/api/cron/refresh-whatsapp-health/route.js:41` `tryPush` | Counts `alerted++` on any non-throw | wrapper log only (a count in a cron response; see Follow-ups) |
| `src/app/api/cron/run-whatsapp-broadcasts/route.js:132`, `src/lib/whatsapp.js:1467`, `src/app/api/webhooks/whatsapp/route.js:580, 860, 878, 898, 916` | Webhook/broadcast side-alerts | wrapper log only |
| `src/app/api/issues/route.js:240`, `src/app/api/equipment/inspections/[id]/submit/route.js:249` | Request path, after the write | wrapper log only |
| `src/lib/agent/approvals-sla.js:123, 141` | After the `expired` claim / "stamp first so a push hiccup can't re-alert" (`sla_escalated_at`) | wrapper log only |
| `src/lib/agent/handoff-sla.js:337` | After stamping `handoff_escalated_at` ("Stamp FIRST") | wrapper log only |
| `src/lib/agent/auto-reply.js:1255, 1334, 1399`, `src/lib/agent/instagram.js:577`, `src/lib/agent/review.js:242`, `src/lib/ops-alerts.js:52` (injectable default) | Staff side-alerts | wrapper log only |
| `src/app/api/contacts/route.js:101` (`lead_new`), `src/app/api/expenses/[id]/submit/route.js:63` | `sendPushToRolesAtLocationOnce`, request path | wrapper log only; key unclaimed, so a replay can still send |
| `src/app/api/schedule/swaps/route.js:283` (`swap_open`, un-awaited with `.catch`), `src/app/api/schedule/swaps/[id]/route.js:377` (`swap_awaiting`), `src/app/api/staff/[id]/permanent/route.js:330`, `src/lib/agent/approval-notify.js:21` | `notifyUsersAtRolesOnce`, request path | wrapper log only. For `swap_open`, the sweep's T-48h/T-12h nudges (caller 8) reach the same managers later. |

**Why not make `resolveRoleRecipientIds` throw instead** (D1): see the decision.

**QUALS.1's `sendOnce` change** (`push-dedup.js:117-120`): a THROWING send now reports `failed: <claimed>` and not EMPTY, because callers read EMPTY as "settled, no device" and never retry. `recipients_failed` follows the same principle one step earlier. A failed recipients read must not look like EMPTY either. It stays a separate counter, not `failed`, because nothing was claimed and nothing was attempted. The arms treat `failed` (a delivery) as not a fault and `recipients_failed` (their own read) as a fault (D3).

**The arm predicates** (`src/lib/cron-arm-health.js`):
- `runwayArmHealthy` (:75-78) is "an object with no `error` key"; `recipients_failed` is added (D4).
- The swap arm has no predicate function: `checklist-sweep/route.js:110` sets `swapSweepFailed = 1` when `swapCover.errors > 0`, and :120 stamps `swap-cover-sweep` only when it is 0. So `errors++` is the fault channel (D5).
- `offerSweepArmHealthy` (:140-143) already covers the offer path (REPLACE.1b retries a failed audience read without a fault, by design). No change.

**Measured on prod, 27 Sep (read-only, counts only):**
- `cron_heartbeats`:
  - `roster-runway` 86,400 s + 43,200 s grace, last stamped 08:00 today;
  - `swap-cover-sweep` 900 + 1,800;
  - `hyrox-class-reminder` 300 + 600;
  - `equipment-inspection-sweep` and `equipment-inspection-reminder` 86,400 + 7,200 each.
- Hyrox: **1 active block, 18 reminders sent, the latest at 09:00 UTC today.** This path is live.
- Equipment: 1 studio enabled.
- Open swaps: 0.
- Runway claim rows (`push_event_sends` `roster_runway:%`): 15.
- How often the `profile_locations` read has failed cannot be counted: the failure was silent. That is the defect.

---

### Decisions (each pinned by a test)

**D1. Migrate the callers; do not make `resolveRoleRecipientIds` throw.** A throw would be the "louder failure" CLAUDE.md forbids:
- The wrappers are documented never to throw (`push-dedup.js:80`, `notify.js:30`), and 28 call sites rely on that. Some are un-awaited with `.catch` (`swaps/route.js:283`), so a throw would just be a different silent loss. Some sit inside webhook handlers (`webhooks/whatsapp/route.js:580…`), where a throw can 500 the webhook and make Meta redeliver the whole event. Some sit inside cron loops whose per-row `catch` counts the row `skipped` (`approvals-sla.js`, `handoff-sla.js`).
- An explicit `{ ids, error }` makes each deciding caller choose retry, fault or log, which is what the row asks for.

*Pinned:* the guard test (no caller left), and every wrapper test asserting it resolves, never rejects, on a failed read.

**D2. The wrappers own the log, and say what happened in their result.** Each role wrapper, on a failed read:
- logs once with `logError` (module `push` or `push-dedup`; meta `locationId`, `roles`, `err`, plus `event_key` or `type`);
- claims nothing and sends nothing;
- returns its normal zero counts plus `recipients_failed: 1`. The key is **absent** on success, so no existing `toEqual` on a success result changes, and callers sum it with `r.recipients_failed || 0`.

"Nobody holds the role" stays exactly as today: zeros, no key, no log. *Pinned:* `push-roles.test.js` "a failed read sends nothing, says so, logs once" / "nobody holds the role: plain zeros, no log"; `push-dedup.test.js` "a failed recipients read claims nothing, sends nothing, and says so" (both variants), "the same key still sends on the next call".

**D3. `recipients_failed` is not `failed`.** `failed` means a send was attempted and failed; its claim is released, and the arms do not count it as a fault. `recipients_failed` means the arm's own read failed: nobody was even attempted. The arms that have their own heartbeat count it as a fault. *Pinned:* `cron-arm-health.test.js` "a failed recipients read is a fault; a failed delivery is not".

**D4. Roster runway: an arm fault, retried by the next daily run.**
- `runRosterRunwayAlerts` sums `recipients_failed` into its outcome (always present, 0 on a clean run, like its other counters).
- `runwayArmHealthy` returns false when it is > 0.
- No key was claimed, so the next daily run still sends while the week is unready. Amber and red keys are per severity, so a missed amber day is recovered the next day, at worst as the red.
- Heartbeat arithmetic: last stamp day D-1 08:00, and the row goes stale at +36 h = **day D 20:00**, so ONE failed day pages that evening. That matches today's behaviour for this arm's other own-read failures (a failed `locations` or runway read throws and withholds the stamp, `contract-reminders/route.js:72-89`).

*Pinned:* `roster-runway-notify.test.js` "a failed recipients read is counted apart from delivery"; `roster-runway-notify.recipients.test.js` "claims nothing, tells nobody, is counted, and the next day's run still sends" (REAL push-dedup + REAL `readRoleRecipientIds`).

**D5. Swap-cover sweep nudge: an arm fault, retried next tick.**
- On a failed approver read: `logError`, `stats.errors++`, `continue`. That skips only this swap: no claim, no send.
- `errors > 0` withholds the `swap-cover-sweep` stamp for this tick (`checklist-sweep/route.js:110, 120`), so the row goes stale only after 900 + 1,800 s of consecutive failures (about 3 ticks).
- The stage is a range, so the next tick nudges.
- The closing of started swaps (`expireSwap`) is not touched: a failed approver read never stops a swap being closed.

*Pinned:* `swap-cover-server.test.js` "a failed approver read nudges nobody, claims nothing, is an arm fault; the next tick nudges".

**D6. The open-pool broadcast stops reading the managers twice.** `notifyOpenPool` already reads `profile_locations` for the studio with the role columns (`MEMBER_SELECT`, `swap-cover-server.js:27`). It now computes `managerIds = roleRecipientIdsFromLinks(members, MANAGER_ROLES)` from that same read: the resolver's own rule, so the sets cannot drift (the property the old comment wanted). It loses one query and its failure mode, and `isManagerLink` stays as the belt. The pure rule's unit (`openPoolRecipients`) is unchanged. *Pinned:* "managers come from the members read itself: no second read, a manager and a master are never pool recipients".

**D7. Hyrox: recipients before the claim.**
- The runner works out who to remind (the on-shift RPC, else the approver roles) BEFORE it claims the class.
- A failed roles read → `logError`, `stats.recipients_failed++`, no claim. The next 5-minute tick retries, up to ~6 times inside the 30-minute lead.
- **Behaviour change, deliberate:** "nobody on shift and nobody in the approver roles" also claims nothing now. A coach rostered in the last half hour still gets the reminder. Today the class was claimed with nobody told, and that was final.
- A failed on-shift RPC (its error is discarded today, `:58`) keeps its current degrade: remind the approver roles instead. It is now logged with `logWarn`.
- Re-reading for an already-reminded class costs one RPC per tick for at most ~6 ticks per class. Negligible: 18 reminders ever.
- The heartbeat is unchanged (D8).

*Pinned:* the new `src/lib/hyrox/reminder-runner.test.js` (there was none).

**D8. Whole-cron heartbeats are not withheld for a recipients failure.** The equipment sweep and the Hyrox reminder stamp their single cron row after a per-location/per-block loop that already isolates failures without withholding the stamp (a location that throws is logged and the cron still stamps, `equipment-inspection-sweep/route.js:91-99`). A recipients failure joins that rule, so a one-location blip does not page the whole cron. Its signals are:
- the `logError`, which Sentinel weights above warns (`src/lib/log.js:128-135`);
- `recipients_failed` in the response body.

The per-arm heartbeats (D4, D5) are where "count as an arm fault" applies. *Pinned:* equipment-sweep "… and still stamps"; equipment-reminder "… not recorded as a sent reminder".

**D9. One-shot best-effort callers get the log, not a retry.** The 28 transitive call sites in the table above each act first and then push once, and none retries a failed Expo send either. For each, a failed recipients read is now a structured `logError` instead of silence. Making them retry would need a ledger or lease per caller (the CLAUDE.md send-once rule: stamp after the send, or lease). That is a per-feature design, out of scope. *Pinned:* D2's wrapper tests (the log is the wrapper's, so every caller gets it).

**D10. `notifyUsersAtRoles` is deleted.** Zero callers in `src`, `shared`, `mobile`, `scripts`, `tests`. Migrating dead code would add a test for nothing. *Pinned:* `npm run build` and the full suite (an import of it anywhere would fail both).

**D11. `resolveRoleRecipientIds` stays for exactly one deploy, marked `@deprecated`, with zero callers.** The guard test `tests/role-recipients-callers.test.js` fails if any file other than `src/lib/push.js` / `src/lib/push.test.js` names it. **The deletion goes into D1 DEADCODE.1** (Wave 6, after this deploy): delete the function and its one "old contract" test, and shrink the guard's allowlist to the test file itself. *Pinned:* the guard test.

---

### Files

| File | Change |
|---|---|
| `src/lib/push.js` | `+ roleRecipientIdsFromLinks` (pure); `readRoleRecipientIds` uses it; `sendPushToRolesAtLocation` on `readRoleRecipientIds` (+ `logError`, `recipients_failed`); `resolveRoleRecipientIds` `@deprecated`; `import { logError } from './log'` |
| `src/lib/push-roles.test.js` | **new**: the pure rule and `sendPushToRolesAtLocation` (the existing `push.test.js` fake db has no `.eq()` on `profile_locations`) |
| `src/lib/push.test.js` | the PUSH-ROLES.1 describe calls `readRoleRecipientIds(...)`; the one "old contract" test stays until D1 DEADCODE.1 |
| `src/lib/push-dedup.js` | both role variants on `readRoleRecipientIds` via one helper; `logError` import; header note |
| `src/lib/push-dedup.test.js` | mocks `readRoleRecipientIds` + `logError`; three role tests re-pointed; three new |
| `src/lib/notify.js` | delete `notifyUsersAtRoles` and the `resolveRoleRecipientIds` import |
| `src/app/api/cron/equipment-inspection-sweep/route.js` (+ `route.test.js`) | `readRoleRecipientIds`; `recipients_failed` row |
| `src/app/api/cron/equipment-inspection-reminder/route.js` (+ `route.test.js`) | honour `recipients_failed` (no "sent" row, no audit) |
| `src/lib/hyrox/reminder-runner.js` | recipients before the claim; `readRoleRecipientIds`; RPC error logged |
| `src/lib/hyrox/reminder-runner.test.js` | **new** |
| `src/lib/swap-cover-server.js` (+ `.test.js`) | `notifyOpenPool` derives managers from its members read; sweep nudge on `readRoleRecipientIds` with `errors++` |
| `src/lib/roster-runway-notify.js` (+ `.test.js`, `.recipients.test.js`) | `recipients_failed` in the outcome |
| `src/lib/cron-arm-health.js` (+ `.test.js`) | `runwayArmHealthy` faults on `recipients_failed` |
| `src/app/api/schedule/swaps/route.get.test.js` | its `@/lib/push` mock names `readRoleRecipientIds` (line 27) |
| `src/lib/swap-cover.js`, `src/lib/availability-notify.js`, `src/lib/qualification-digest.js` | comments only (Task 8) |
| `tests/role-recipients-callers.test.js` | **new** guard |
| `docs/CHANGELOG.md` | one row |

---

**Setup:** a fresh worktree off `origin/main` (standing rule; never a shared one, never `git stash`):

```bash
cd ~/code/un1t-crm && git fetch origin main && git worktree add ../un1t-crm-recipients1 -b recipients-1 origin/main && cd ../un1t-crm-recipients1 && npm ci
```

### Task 0: Pre-flight

- [ ] **Step 1: The caller list has not moved.**

```bash
git grep -n "resolveRoleRecipientIds" -- src shared mobile scripts tests | grep -v "\.test\.js:"
```

Expected: exactly these non-test hits:
- `src/lib/push.js` (:363, :365, :370);
- `src/app/api/cron/equipment-inspection-sweep/route.js` (:21, :68);
- `src/lib/hyrox/reminder-runner.js` (:10, :63);
- `src/lib/notify.js` (:34, :201);
- `src/lib/push-dedup.js` (:37, :151, :160);
- `src/lib/swap-cover-server.js` (:11, :89, :283);
- comments in `availability-notify.js:7`, `qualification-digest.js:9`, `roster-runway-notify.js:28, 45`, `swap-cover.js:88, 120`.

**If there is a NEW caller, stop and add it to this plan** (same treatment: retry, fault, or log) before building.

- [ ] **Step 2: No name clash** (`tests/shared-pair-sync.test.js` fails on an export present in both `shared/` and `src/lib/`):

```bash
git grep -nE "export (const|function|async function) roleRecipientIdsFromLinks\b" -- shared src mobile/lib
git grep -n "notifyUsersAtRoles[^O]" -- src shared mobile scripts tests
```

Expected: first command no output. The second: only `src/lib/notify.js:196` and the `src/lib/push-dedup.js:156` docstring. If anything calls `notifyUsersAtRoles`, migrate it the way Task 2 does instead of deleting it.

### Task 1: `push.js` — the pure rule, and `sendPushToRolesAtLocation` stops hiding a failed read

**Files:** Create `src/lib/push-roles.test.js`. Modify `src/lib/push.js:41-43, 353-415`, `src/lib/push.test.js:107, 521-553`.

- [ ] **Step 1: Write the failing test** — `src/lib/push-roles.test.js`:

```js
// C1 RECIPIENTS.1 — "who holds these roles here" must tell a failed read
// from an empty answer. push.test.js's fake db serves profile_locations with
// `.in()` only (sendPush's permission read), so the fan-out's `.eq()` read is
// tested here with its own fake.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ linksResult: { data: [], error: null } }))

vi.mock('./supabase.js', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table !== 'profile_locations') throw new Error(`unexpected table ${table}`)
      return { select: () => ({ eq: async () => h.linksResult }) }
    },
  }),
}))
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { logError } = await import('./log.js')
const { roleRecipientIdsFromLinks, sendPushToRolesAtLocation } = await import('./push.js')

const link = (profile_id, role, { profileRole = role, active = true } = {}) => ({
  profile_id, role, profiles: { id: profile_id, role: profileRole, active },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.linksResult = { data: [], error: null }
  global.fetch = vi.fn()
})

describe('roleRecipientIdsFromLinks — the rule, pure (PUSH-ROLES.1)', () => {
  const links = [
    link('richard', 'staff', { profileRole: 'master' }),
    link('garrett', 'owner'),
    link('james', 'staff'),
    link('gone', 'owner', { active: false }),
    link('demoted', 'staff', { profileRole: 'owner' }),
    { profile_id: 'orphan', role: 'owner', profiles: null },
  ]

  it('per-location role, active only, and every active master whatever their role here', () => {
    expect(roleRecipientIdsFromLinks(links, ['owner', 'manager'])).toEqual(['richard', 'garrett'])
  })

  it('no roles, or no links, is nobody', () => {
    expect(roleRecipientIdsFromLinks(links, [])).toEqual([])
    expect(roleRecipientIdsFromLinks(null, ['owner'])).toEqual([])
  })
})

describe('sendPushToRolesAtLocation — a failed read is not "nobody"', () => {
  it('a failed read sends nothing, says so in the result, and logs once', async () => {
    h.linksResult = { data: null, error: { message: 'down' } }
    const r = await sendPushToRolesAtLocation('loc1', ['owner'], { title: 't', body: 'b', data: { type: 'x' } })
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('push', expect.stringContaining('recipients read failed'),
      expect.objectContaining({ locationId: 'loc1', roles: ['owner'], type: 'x', err: 'down' }))
  })

  it('nobody holds the role: plain zeros, no recipients_failed, no log', async () => {
    h.linksResult = { data: [link('james', 'staff')], error: null }
    const r = await sendPushToRolesAtLocation('loc1', ['owner'], { title: 't', body: 'b' })
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to see it fail.**

```bash
npx vitest run src/lib/push-roles.test.js
```

Expected: FAIL. `roleRecipientIdsFromLinks is not a function`, and the failed-read test gets `{ sent: 0, skipped: 0, invalidated: 0, failed: 0 }` with no `recipients_failed` and no `logError` call.

- [ ] **Step 3: Implement** in `src/lib/push.js`.

After the imports at :41-43 add:

```js
import { logError } from './log'
```

Replace :353-397 (the two docstrings and both functions) with:

```js
/**
 * The role rule, pure. PUSH-ROLES.1 — judge the PER-LOCATION role (roles are
 * per-location, mig 051), not the global profiles.role: filtering on the
 * global role both over-notified (global owner holding a staff row here) and,
 * worse, silently excluded every `master` from owner/manager fan-outs —
 * masters hold every decision right, so they are always included. Live miss:
 * Richard (global role master, owner at Stillorgan) never received the
 * new-time-off-request push, 2026-07-27.
 *
 * Exported so a caller that has ALREADY read the studio's profile_locations
 * rows (with `role` and `profiles(role, active)`) applies the same rule
 * without a second read (swap-cover-server.js notifyOpenPool).
 *
 * @param {object[]|null} links  profile_locations rows: { profile_id, role, profiles: { role, active } }
 * @param {string[]} roles
 * @returns {string[]} profile ids, in row order
 */
export function roleRecipientIdsFromLinks(links, roles) {
  if (!roles?.length) return []
  return (links || [])
    .filter(l => l?.profiles?.active && (roles.includes(l.role) || l.profiles.role === 'master'))
    .map(l => l.profile_id)
}

/**
 * @deprecated C1 RECIPIENTS.1 — no callers left; use readRoleRecipientIds,
 * which keeps the read error. This returns [] on a FAILED read, which reads
 * as "nobody to tell". Kept for one deploy; deleted by D1 DEADCODE.1.
 * tests/role-recipients-callers.test.js fails if anything calls it.
 *
 * @returns {Promise<string[]>}
 */
export async function resolveRoleRecipientIds(db, locationId, roles) {
  return (await readRoleRecipientIds(db, locationId, roles)).ids
}

/**
 * The active profile ids holding one of `roles` at `locationId`, WITH the
 * read error. REPLACE.1b review 1: the "taken" notice of a claimed shift
 * offer stamped itself done on the empty list a failed read returned, so the
 * managers' only signal was lost. C1 RECIPIENTS.1 moved every caller here.
 * A caller that stamps, claims or reports after sending must treat `error`
 * as "try again" (or as a fault), never as "nobody to tell".
 *
 * @param {object} db          service-role supabase client
 * @param {string} locationId
 * @param {string[]} roles     e.g. ['owner', 'manager']
 * @returns {Promise<{ ids: string[], error: object|null }>}
 */
export async function readRoleRecipientIds(db, locationId, roles) {
  if (!locationId || !roles?.length) return { ids: [], error: null }
  const { data: links, error } = await db
    .from('profile_locations')
    .select('profile_id, role, profiles!inner(id, role, active)')
    .eq('location_id', locationId)
  if (error) return { ids: [], error }
  return { ids: roleRecipientIdsFromLinks(links, roles), error: null }
}
```

Replace `sendPushToRolesAtLocation` (:399-415) with:

```js
/**
 * Convenience: send a notification to every user with a given role at a
 * given location. Useful for fan-out events like "new time-off request
 * needs approval" → notify all managers at the requester's location.
 *
 * Never throws. C1 RECIPIENTS.1: a FAILED recipients read is logged here,
 * once, with logError, and returned as `recipients_failed: 1` beside the zero
 * counts, so it can never pass for "nobody holds the role" (plain zeros, no
 * key). Callers are one-shot best-effort alerts; the log is their signal.
 *
 * @param {string} locationId
 * @param {string[]} roles     e.g. ['owner', 'manager']
 * @param {object} payload     Same shape as sendPush()
 */
export async function sendPushToRolesAtLocation(locationId, roles, payload) {
  const db = createServerClient()
  const { ids, error } = await readRoleRecipientIds(db, locationId, roles)
  if (error) {
    logError('push', 'role recipients read failed; nobody was told', {
      locationId, roles, type: payload?.data?.type ?? null, category: payload?.category ?? null, err: error.message,
    })
    return { sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 }
  }
  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0, failed: 0 }
  // PUSH-LOC.1 — this fan-out is location-scoped by definition, so the
  // per-category opt-out is judged at THIS location, not any other
  // assignment the recipient happens to hold.
  return sendPush(ids, payload, { locationId })
}
```

- [ ] **Step 4: Re-point the old role describe in `src/lib/push.test.js`** (:521-553). Rename the describe to `readRoleRecipientIds — per-location role + master inclusion (PUSH-ROLES.1)` and change its two calls:

```js
    const { ids } = await readRoleRecipientIds(db, 'loc1', ['owner', 'manager'])
```

in both `it`s (:540 and :548; the assertions on `ids` are unchanged). Leave the `readRoleRecipientIds` describe (:555-575), including its "resolveRoleRecipientIds keeps its old contract" test, until D1 DEADCODE.1. The import at :107 stays as it is.

- [ ] **Step 5: Run and see it pass.**

```bash
npx vitest run src/lib/push-roles.test.js src/lib/push.test.js
```

Expected: PASS, 0 failed.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/push.js src/lib/push-roles.test.js src/lib/push.test.js
git commit -m "RECIPIENTS.1: sendPushToRolesAtLocation reports a failed recipients read instead of 'nobody'

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `push-dedup.js` — the deduped role fan-outs claim nothing on a failed read; delete `notifyUsersAtRoles`

**Files:** Modify `src/lib/push-dedup.js:28-39, 145-162`, `src/lib/push-dedup.test.js:9-22, 187-210`, `src/lib/notify.js:34, 182-203`.

- [ ] **Step 1: Re-point the mocks and write the failing tests** in `src/lib/push-dedup.test.js`.

Replace the two mocks at :9-18 and the import at :20-22:

```js
vi.mock('./push.js', () => ({
  sendPush: vi.fn(),
  readRoleRecipientIds: vi.fn(),
}))
vi.mock('./notify.js', () => ({
  notifyUsers: vi.fn(),
}))
vi.mock('./log.js', () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

import { sendPush, readRoleRecipientIds } from './push.js'
import { notifyUsers } from './notify.js'
import { logWarn, logError } from './log.js'
```

Replace the whole `describe('role fan-out variants — ids resolved BEFORE claiming', …)` block (:187-210) with:

```js
describe('role fan-out variants — ids resolved BEFORE claiming', () => {
  const found = (ids) => readRoleRecipientIds.mockResolvedValue({ ids, error: null })
  const readFails = () => readRoleRecipientIds.mockResolvedValue({ ids: [], error: { message: 'down' } })

  it('sendPushToRolesAtLocationOnce claims per resolved recipient', async () => {
    found(['m1', 'm2'])
    existingClaims.add('k|m1')
    const res = await sendPushToRolesAtLocationOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })
    expect(readRoleRecipientIds).toHaveBeenCalledWith(fakeDb, 'loc1', ['owner'])
    expect(sendPush).toHaveBeenCalledWith(['m2'], { title: 't' })
    expect(res.deduped).toBe(1)
    expect(res.recipients_failed).toBeUndefined()
  })

  it('notifyUsersAtRolesOnce resolves then claims the same way', async () => {
    found(['m1'])
    await notifyUsersAtRolesOnce(fakeDb, 'k', 'loc1', ['owner', 'manager'], { title: 't' })
    expect(notifyUsers).toHaveBeenCalledWith(['m1'], { title: 't' })
  })

  it('nobody holds the role → no claim, no send, no recipients_failed, no log', async () => {
    found([])
    const res = await sendPushToRolesAtLocationOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })
    expect(sendPush).not.toHaveBeenCalled()
    expect(upsertedRows).toEqual([])
    expect(res).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 0 })
    expect(logError).not.toHaveBeenCalled()
  })

  // C1 RECIPIENTS.1 — a failed read was EMPTY, the same as "nobody holds the
  // role", so the roster-runway arm reported a clean run and stamped.
  it.each([
    ['sendPushToRolesAtLocationOnce', () => sendPushToRolesAtLocationOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })],
    ['notifyUsersAtRolesOnce', () => notifyUsersAtRolesOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })],
  ])('%s: a failed recipients read claims nothing, sends nothing, and says so', async (_name, call) => {
    readFails()
    const res = await call()
    expect(res).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 0, recipients_failed: 1 })
    expect(upsertedRows).toEqual([])
    expect(sendPush).not.toHaveBeenCalled()
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('push-dedup', expect.stringContaining('recipients read failed'),
      expect.objectContaining({ event_key: 'k', locationId: 'loc1', roles: ['owner'], err: 'down' }))
  })

  it('after a failed read the same key still sends on the next call: nothing was claimed', async () => {
    readFails()
    await notifyUsersAtRolesOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })
    found(['m1'])
    const res = await notifyUsersAtRolesOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers).toHaveBeenCalledWith(['m1'], { title: 't' })
    expect(res).toMatchObject({ sent: 1, deduped: 0 })
    expect(res.recipients_failed).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to see it fail.**

```bash
npx vitest run src/lib/push-dedup.test.js
```

Expected: FAIL. `push-dedup.js` still imports `resolveRoleRecipientIds`, which the mock no longer defines ("No \"resolveRoleRecipientIds\" export is defined on the mock").

- [ ] **Step 3: Implement** in `src/lib/push-dedup.js`.

Add to the header comment, after the "Failure posture" paragraph (after :32):

```js
//
// C1 RECIPIENTS.1 — the ROLE variants read "who holds these roles here"
// first. A FAILED read is not "nobody": it is logged once with logError,
// nothing is claimed and nothing is sent, and the result carries
// `recipients_failed: 1` beside the EMPTY counts. Because nothing was
// claimed, the next call with the same key (a retry, tomorrow's cron run)
// still sends. Never throws, like everything here.
```

Replace the imports at :37-39:

```js
import { sendPush, readRoleRecipientIds } from './push'
import { notifyUsers } from './notify'
import { logWarn, logError } from './log'
```

Replace :145-162 (both role variants and their docstrings) with:

```js
/**
 * Resolve the role set to profile ids, keeping a failed read apart from
 * "nobody holds the role". `failure` is the result the caller returns as-is.
 */
async function roleRecipients(db, eventKey, locationId, roles) {
  const { ids, error } = await readRoleRecipientIds(db, locationId, roles)
  if (!error) return { ids, failure: null }
  logError('push-dedup', 'role recipients read failed; nothing claimed, nobody told on this call', {
    event_key: eventKey, locationId, roles, err: error.message,
  })
  return { ids: [], failure: { ...EMPTY, recipients_failed: 1 } }
}

/**
 * sendPushToRolesAtLocation(), deduped. The role set is resolved to
 * profile ids FIRST so each recipient gets their own claim row — a
 * manager added between webhook replays still gets exactly one push.
 * A failed read returns `recipients_failed: 1` and claims nothing.
 */
export async function sendPushToRolesAtLocationOnce(db, eventKey, locationId, roles, payload) {
  const { ids, failure } = await roleRecipients(db, eventKey, locationId, roles)
  if (failure) return failure
  return sendOnce(db, eventKey, ids, payload, sendPush, 'sendPush')
}

/**
 * The role fan-out through notifyUsers (push + registry-gated email
 * fallback), deduped. Same id-resolution story, and the same failed-read
 * result, as sendPushToRolesAtLocationOnce.
 */
export async function notifyUsersAtRolesOnce(db, eventKey, locationId, roles, payload) {
  const { ids, failure } = await roleRecipients(db, eventKey, locationId, roles)
  if (failure) return failure
  return sendOnce(db, eventKey, ids, payload, notifyUsers, 'notifyUsers')
}
```

- [ ] **Step 4: Delete `notifyUsersAtRoles` from `src/lib/notify.js`** (D10). Remove the whole docstring and function at :182-203 (from `/**\n * Sister of notifyUsers for the fan-out shape` to the closing `}` of `notifyUsersAtRoles`). Change the import at :34 to:

```js
import { sendPush, resolvePushAllowedIds } from './push'
```

Keep the `createServerClient` import (`:33`): `notifyUsers` still uses it (`:83`).

- [ ] **Step 5: Run and see it pass.**

```bash
npx vitest run src/lib/push-dedup.test.js src/lib/push.test.js
```

Expected: PASS. (There is no `src/lib/notify.test.js` on main; `notifyUsers` is exercised through `push-dedup` and the roster-runway recipients suite.)

- [ ] **Step 6: Commit.**

```bash
git add src/lib/push-dedup.js src/lib/push-dedup.test.js src/lib/notify.js
git commit -m "RECIPIENTS.1: deduped role fan-outs claim nothing on a failed recipients read; drop dead notifyUsersAtRoles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: the equipment crons — a failed read is never a sent reminder

**Files:** Modify `src/app/api/cron/equipment-inspection-sweep/route.js:21, 26, 64-90` + `route.test.js`; `src/app/api/cron/equipment-inspection-reminder/route.js:60-84` (the send, audit and result inside the per-location loop) + `route.test.js`.

- [ ] **Step 1: Re-point the sweep test's mocks and write the failing test** in `src/app/api/cron/equipment-inspection-sweep/route.test.js`.
  - Mock changes: at :36-38 the push mock becomes `readRoleRecipientIds: vi.fn()`; at :44 the log mock becomes `({ logWarn: vi.fn(), logError: vi.fn() })`; at :48 the import becomes `import { readRoleRecipientIds } from '@/lib/push'`; and add `import { logError } from '@/lib/log'` below it.
  - Re-pointed calls: every `resolveRoleRecipientIds.mockResolvedValue(X)` (:70, :89, :106, :121, :133, :147) becomes `readRoleRecipientIds.mockResolvedValue({ ids: X, error: null })`, and the two `expect(resolveRoleRecipientIds)` (:99, :108) become `expect(readRoleRecipientIds)`.
  - Then add inside the describe, before the heartbeat test:

```js
  // C1 RECIPIENTS.1 — a failed owner/master read looked exactly like a studio
  // with nobody to chase: pushed:false, no log, nothing said.
  it('a failed owner/master read chases nobody, claims no key, says so, and still stamps', async () => {
    listEnabledSettings.mockResolvedValue([SETTINGS_A])
    listActiveEquipment.mockResolvedValue(OVERDUE_ASSETS)
    readRoleRecipientIds.mockResolvedValue({ ids: [], error: { message: 'down' } })
    const res = await GET(req())
    const body = await res.json()
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(body.data.locations).toEqual([
      { locationId: 'loc-a', overdue: 1, pushed: false, recipients_failed: true },
    ])
    expect(logError).toHaveBeenCalledWith('equipment-cron', expect.stringContaining('read failed'),
      expect.objectContaining({ locationId: 'loc-a', err: 'down' }))
    // A whole-cron row: one studio's blip does not page the cron (D8).
    expect(stampHeartbeat).toHaveBeenCalledWith('equipment-inspection-sweep')
  })
```

- [ ] **Step 2: Write the failing reminder test** in `src/app/api/cron/equipment-inspection-reminder/route.test.js`. Add `import { logAuditEvent } from '@/lib/audit'` beside the other imports (after :47), and inside the describe, before the heartbeat test:

```js
  // C1 RECIPIENTS.1 — the reminder recorded pushed:true and audited
  // "reminder_sent" whatever happened. The 19:00 overdue sweep is the same
  // day's recovery (it chases every outstanding asset, any weekday).
  it('a failed owner/master read is not recorded as a sent reminder', async () => {
    listEnabledSettings.mockResolvedValue([TUESDAY_SETTINGS])
    listActiveEquipment.mockResolvedValue(ASSETS)
    listSubmittedSince.mockResolvedValue([])
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 })
    const body = await (await GET(req())).json()
    expect(body.data.locations).toEqual([
      expect.objectContaining({ locationId: 'loc-tue', pushed: false, recipients_failed: true }),
    ])
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('equipment-inspection-reminder')
  })
```

- [ ] **Step 3: Run both to see them fail.**

```bash
npx vitest run src/app/api/cron/equipment-inspection-sweep/route.test.js src/app/api/cron/equipment-inspection-reminder/route.test.js
```

Expected:
- the sweep file fails to import (`resolveRoleRecipientIds` is not defined on the mock), or its new test fails on the missing `recipients_failed`;
- the reminder's new test fails: `pushed: true`, and `logAuditEvent` was called.

- [ ] **Step 4: Implement the sweep** (`src/app/api/cron/equipment-inspection-sweep/route.js`).
  - Import at :21: `import { readRoleRecipientIds } from '@/lib/push'`.
  - Import at :26: `import { logWarn, logError } from '@/lib/log'`.
  - Replace :64-90 (from the `// sendPushToRolesAtLocation has no dedup` comment through the `results.push(...)`) with:

```js
      // sendPushToRolesAtLocation has no dedup; sendPushOnce dedups but
      // takes user ids, not roles — resolve the recipients first, then
      // dedup on (location, day) so a Vercel retry on the same day is a
      // no-op while tomorrow's run still fires.
      // C1 RECIPIENTS.1 — a FAILED read is not "nobody to chase": logged,
      // nothing claimed (so the key stays free), and said in the result.
      // Tomorrow's run chases again: the asset is still overdue and the key
      // is per day. The audit row still records the overdue count (true).
      const recipients = await readRoleRecipientIds(db, settings.location_id, ROLES)
      if (recipients.error) {
        logError('equipment-cron', 'owner/master read failed; nobody was chased today', {
          locationId: settings.location_id, overdue: outstanding.length, err: recipients.error.message,
        })
      }
      const ids = recipients.error ? [] : recipients.ids
      if (ids.length) {
        await sendPushOnce(db, `equip-overdue:${settings.location_id}:${today}`, ids, {
          title: 'Equipment inspections not done',
          body: buildOverdueBody(outstanding),
          data: { type: 'equipment_inspection_overdue' },
          // BARE — push.js prepends `notify_` itself, so this gates on
          // notify_inspection_overdue (registered in MOBILE_PERMISSIONS).
          // The prefixed form resolved notify_notify_…, which is
          // unregistered and reaches no one but master (PUSHCAT.1).
          category: 'inspection_overdue',
        })
      }

      await logAuditEvent({
        category: 'business',
        action: 'equipment.inspection_overdue',
        actor: null,
        target: { resource: `location/${settings.location_id}` },
        locationId: settings.location_id,
        details: { overdue_count: outstanding.length, today },
      })
      results.push({
        locationId: settings.location_id,
        overdue: outstanding.length,
        pushed: ids.length > 0,
        ...(recipients.error ? { recipients_failed: true } : {}),
      })
```

Also update the header line :12-13 ("Push delivery is best-effort; sendPushOnce returns counts and never throws.") by appending: `A failed owner/master read is logged and reported per location (recipients_failed), never read as "nobody to chase".`

- [ ] **Step 5: Implement the reminder** (`src/app/api/cron/equipment-inspection-reminder/route.js`). Replace the loop body's send-and-record section (from `await sendPushToRolesAtLocation(settings.location_id, ROLES, {` to the `results.push({ locationId: settings.location_id, due: outstanding.length, pushed: true })` line) with:

```js
      const r = await sendPushToRolesAtLocation(settings.location_id, ROLES, {
        title: 'Equipment inspections due',
        body: buildReminderBody(outstanding),
        data: { type: 'equipment_inspection' },
        // BARE — push.js prepends `notify_` itself, so this gates on
        // notify_inspection_due (registered in MOBILE_PERMISSIONS). The
        // prefixed form resolved notify_notify_…, which is unregistered
        // and reaches no one but master (PUSHCAT.1).
        category: 'inspection_due',
      })

      // C1 RECIPIENTS.1 — the owner/master read failed (push.js logged it):
      // nobody was told, so this is not a sent reminder and is not audited
      // as one. The 19:00 overdue sweep chases the same assets today.
      if (r?.recipients_failed) {
        results.push({ locationId: settings.location_id, due: outstanding.length, pushed: false, recipients_failed: true })
        continue
      }

      await logAuditEvent({
        category: 'business',
        action: 'equipment.inspection_reminder_sent',
        actor: null,
        target: { resource: `location/${settings.location_id}` },
        locationId: settings.location_id,
        details: { due_count: outstanding.length, today },
      })
      results.push({ locationId: settings.location_id, due: outstanding.length, pushed: true })
```

(`continue` is inside the per-location `try` inside the `for`, so it moves to the next location, as the `outstanding.length === 0` branch above it already does.)

- [ ] **Step 6: Run and see them pass.**

```bash
npx vitest run src/app/api/cron/equipment-inspection-sweep/route.test.js src/app/api/cron/equipment-inspection-reminder/route.test.js
```

Expected: PASS, 0 failed.

- [ ] **Step 7: Commit.**

```bash
git add src/app/api/cron/equipment-inspection-sweep src/app/api/cron/equipment-inspection-reminder
git commit -m "RECIPIENTS.1: equipment crons never record a failed owner read as a sent or unneeded chase

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: the Hyrox reminder — recipients before the claim

**Files:** Create `src/lib/hyrox/reminder-runner.test.js`. Modify `src/lib/hyrox/reminder-runner.js` (whole file, 91 lines).

- [ ] **Step 1: Write the failing test** — `src/lib/hyrox/reminder-runner.test.js`:

```js
// HYROX-MOBILE (Batch D) + C1 RECIPIENTS.1 — who is reminded, and that a
// failed "who" read claims nothing so the next 5-minute tick tries again.
// Before C1 the class was CLAIMED first; a failed approver read then came back
// as [] and the reminder was lost for good.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), readRoleRecipientIds: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { sendPush, readRoleRecipientIds } = await import('@/lib/push')
const { logWarn, logError } = await import('@/lib/log')
const { runHyroxClassReminder } = await import('./reminder-runner')

// 08:40 UTC; the class starts 09:00 UTC, inside the 30-minute lead.
const NOW = Date.UTC(2026, 8, 28, 8, 40)
const OCC = { name: 'HYROX Engine', starts_at: '2026-09-28T09:00:00.000Z', ends_at: '2026-09-28T10:00:00.000Z' }
// session_weekdays [] → no session row is looked up (slotFor → null).
const BLOCK = { id: 'blk-1', location_id: 'loc-1', starts_on: '2026-09-07', weeks: 8, session_weekdays: [] }

const thenable = (result) => ({ then: (res, rej) => Promise.resolve(result).then(res, rej) })
function chain(result) {
  const b = { then: (res, rej) => Promise.resolve(result).then(res, rej) }
  for (const m of ['select', 'eq', 'is', 'gte', 'lte', 'order']) b[m] = () => b
  b.maybeSingle = () => thenable({ data: null, error: null })
  return b
}

// `claimed` is the hyrox_class_reminders unique index, kept across runs so a
// test can follow one class over two ticks.
function makeDb({ onShift = [], onShiftError = null, claimed = new Set() } = {}) {
  const calls = { upserts: [], updates: [], rpc: [] }
  return {
    calls,
    claimed,
    from(table) {
      if (table === 'hyrox_blocks') return chain({ data: [BLOCK], error: null })
      if (table === 'class_occurrences') return chain({ data: [OCC], error: null })
      if (table === 'hyrox_sessions') return chain({ data: null, error: null })
      if (table === 'hyrox_class_reminders') {
        return {
          upsert: (row) => ({
            select: () => {
              calls.upserts.push(row)
              const key = `${row.location_id}|${row.class_starts_at}`
              if (claimed.has(key)) return thenable({ data: [], error: null })
              claimed.add(key)
              return thenable({ data: [{ id: `rem-${claimed.size}` }], error: null })
            },
          }),
          update: (patch) => ({ eq: (_c, id) => { calls.updates.push({ id, patch }); return thenable({ error: null }) } }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc(name, args) {
      calls.rpc.push({ name, args })
      return thenable({ data: onShiftError ? null : onShift, error: onShiftError })
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
  readRoleRecipientIds.mockResolvedValue({ ids: ['m1'], error: null })
})

describe('runHyroxClassReminder', () => {
  it('reminds the coaches on shift, once, and never reads the approver roles', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }] })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.rpc[0]).toEqual({ name: 'hyrox_coaches_on_shift', args: { p_location: 'loc-1', p_start: OCC.starts_at, p_end: OCC.ends_at } })
    expect(readRoleRecipientIds).not.toHaveBeenCalled()
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][0]).toEqual(['c1'])
    expect(sendPush.mock.calls[0][2]).toEqual({ locationId: 'loc-1', requireMobileKey: 'hyrox' })
    expect(db.calls.updates).toEqual([{ id: 'rem-1', patch: { session_id: null, recipient_count: 1 } }])
    expect(stats).toEqual({ classes: 1, reminded: 1, recipients: 1, recipients_failed: 0 })
  })

  it('nobody on shift: the approver roles at that studio are reminded', async () => {
    const db = makeDb()
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(readRoleRecipientIds).toHaveBeenCalledWith(db, 'loc-1', ['owner', 'manager', 'head_coach'])
    expect(sendPush.mock.calls[0][0]).toEqual(['m1'])
  })

  it('a failed approver read claims NOTHING and sends nothing; the next tick sends', async () => {
    readRoleRecipientIds.mockResolvedValueOnce({ ids: [], error: { message: 'down' } })
    const db = makeDb()
    const first = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.upserts).toEqual([])
    expect(sendPush).not.toHaveBeenCalled()
    expect(first).toEqual({ classes: 1, reminded: 0, recipients: 0, recipients_failed: 1 })
    expect(logError).toHaveBeenCalledWith('hyrox-reminder', expect.stringContaining('read failed'),
      expect.objectContaining({ locationId: 'loc-1', class_starts_at: OCC.starts_at, err: 'down' }))

    // Five minutes later, still 15 minutes before the class.
    const second = await runHyroxClassReminder(db, { nowMs: NOW + 5 * 60_000 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][0]).toEqual(['m1'])
    expect(second).toMatchObject({ reminded: 1, recipients_failed: 0 })
  })

  it('nobody at all: nothing is claimed, so a coach rostered before the class is still reminded', async () => {
    readRoleRecipientIds.mockResolvedValue({ ids: [], error: null })
    const db = makeDb()
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(db.calls.upserts).toEqual([])
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('a failed on-shift read falls back to the approver roles, and says so', async () => {
    const db = makeDb({ onShiftError: { message: 'rpc down' } })
    await runHyroxClassReminder(db, { nowMs: NOW })
    expect(sendPush.mock.calls[0][0]).toEqual(['m1'])
    expect(logWarn).toHaveBeenCalledWith('hyrox-reminder', expect.stringContaining('on-shift'),
      expect.objectContaining({ locationId: 'loc-1', err: 'rpc down' }))
  })

  it('a class already reminded is never sent twice', async () => {
    const db = makeDb({ onShift: [{ profile_id: 'c1' }], claimed: new Set([`loc-1|${OCC.starts_at}`]) })
    const stats = await runHyroxClassReminder(db, { nowMs: NOW })
    expect(sendPush).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ classes: 1, reminded: 0 })
  })
})
```

- [ ] **Step 2: Run it to see it fail.**

```bash
npx vitest run src/lib/hyrox/reminder-runner.test.js
```

Expected: FAIL. The runner imports `resolveRoleRecipientIds` (not on the mock). The throw is swallowed by the per-block `catch`, so the stats come back without `recipients_failed`, and on the failed-read test `db.calls.upserts` has one row (the claim came first).

- [ ] **Step 3: Implement** — replace `src/lib/hyrox/reminder-runner.js` with:

```js
// HYROX-MOBILE (Batch D) — remind the coach(es) covering a HYROX class to review
// the workout, ~30 min before it starts. Runs on the every-5-min cron; the
// hyrox_class_reminders unique (location, class_starts_at) makes it send ONCE per
// class, not every tick. Primary recipients are whoever's rostered on at the
// class time (hyrox_coaches_on_shift, TZ-safe in SQL); if the roster has a gap,
// fall back to the location's Hyrox-approver roles so a reminder never goes to
// nobody. sendPush gates on the master push switch + the `hyrox` mobile feature.
//
// C1 RECIPIENTS.1 — WHO is worked out BEFORE the class is claimed. The claim
// used to come first, so a failed approver read (which came back as [])
// claimed the class with nobody told, and every later tick skipped it: the
// reminder was lost for good. Now a failed read claims nothing and the next
// tick (5 minutes later, still inside the 30-minute lead) tries again; so
// does "nobody to tell", in case a coach is rostered in the meantime.
import { normalizeClassName } from '@/lib/hr-analytics'
import { weekNoFor, slotFor } from './mapping'
import { sendPush, readRoleRecipientIds } from '@/lib/push'
import { logWarn, logError } from '@/lib/log'

const LEAD_MS = 30 * 60_000        // remind 30 min before the class
const FALLBACK_ROLES = ['owner', 'manager', 'head_coach']

// Who's on shift at the class time; else the Hyrox-approver roles.
// { ids, error }: error is set ONLY when the fallback roles read failed. A
// failed on-shift read degrades to the fallback, as it always has, logged.
async function classRecipients(db, locationId, occ) {
  const endIso = occ.ends_at || new Date(new Date(occ.starts_at).getTime() + 60 * 60_000).toISOString()
  const { data: onShift, error: shiftErr } = await db.rpc('hyrox_coaches_on_shift', {
    p_location: locationId, p_start: occ.starts_at, p_end: endIso,
  })
  if (shiftErr) {
    logWarn('hyrox-reminder', 'on-shift read failed; reminding the approver roles instead', {
      locationId, class_starts_at: occ.starts_at, err: shiftErr.message,
    })
  }
  const ids = (shiftErr ? [] : (onShift || [])).map((r) => r.profile_id).filter(Boolean)
  if (ids.length) return { ids, error: null }

  const fallback = await readRoleRecipientIds(db, locationId, FALLBACK_ROLES)
  if (fallback.error) return { ids: [], error: fallback.error.message }
  return { ids: [...fallback.ids], error: null }
}

export async function runHyroxClassReminder(db, { nowMs = Date.now() } = {}) {
  const stats = { classes: 0, reminded: 0, recipients: 0, recipients_failed: 0 }
  const { data: blocks } = await db
    .from('hyrox_blocks').select('id, location_id, starts_on, weeks, session_weekdays').eq('status', 'active')

  for (const block of blocks || []) {
    try {
      const { data: occs } = await db.from('class_occurrences')
        .select('name, starts_at, ends_at')
        .eq('location_id', block.location_id)
        .is('cancelled_at', null)
        .gte('starts_at', new Date(nowMs).toISOString())
        .lte('starts_at', new Date(nowMs + LEAD_MS).toISOString())
        .order('starts_at', { ascending: true })

      for (const occ of occs || []) {
        if (!normalizeClassName(occ.name).includes('hyrox')) continue
        stats.classes++

        const recipients = await classRecipients(db, block.location_id, occ)
        if (recipients.error) {
          stats.recipients_failed++
          logError('hyrox-reminder', 'approver read failed; nothing claimed, the next tick retries', {
            locationId: block.location_id, class_starts_at: occ.starts_at, err: recipients.error,
          })
          continue
        }
        const recipientIds = recipients.ids
        if (!recipientIds.length) continue

        // Claim this occurrence race-safely — ON CONFLICT DO NOTHING. Only the
        // insert that actually wrote a row proceeds to send; a second tick (or a
        // concurrent run) gets no rows back and skips.
        const { data: claimed } = await db.from('hyrox_class_reminders')
          .upsert({ location_id: block.location_id, class_starts_at: occ.starts_at },
                  { onConflict: 'location_id,class_starts_at', ignoreDuplicates: true })
          .select('id')
        if (!claimed || !claimed.length) continue
        const reminderId = claimed[0].id

        // The session this class maps to (for the deep-link + focus). Any status
        // — the coach reviews a draft too.
        const wk = weekNoFor(block.starts_on, occ.starts_at, block.weeks)
        const slot = slotFor(block.session_weekdays || [], occ.starts_at)
        let session = null
        if (wk != null && slot != null) {
          const { data: s } = await db.from('hyrox_sessions')
            .select('id, focus').eq('block_id', block.id).eq('week_no', wk).eq('slot', slot).maybeSingle()
          session = s || null
        }

        const timeStr = new Date(occ.starts_at).toLocaleTimeString('en-IE', {
          timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
        })
        await sendPush(recipientIds, {
          title: 'Hyrox class coming up',
          body: session?.focus
            ? `Review "${session.focus}" for your ${timeStr} class.`
            : `Review the workout for your ${timeStr} Hyrox class.`,
          data: session?.id ? { screen: 'hyrox', sessionId: session.id } : { screen: 'hyrox' },
        }, { locationId: block.location_id, requireMobileKey: 'hyrox' })

        // Best-effort bookkeeping — never fails the send.
        await db.from('hyrox_class_reminders')
          .update({ session_id: session?.id || null, recipient_count: recipientIds.length })
          .eq('id', reminderId)
        stats.reminded++
        stats.recipients += recipientIds.length
      }
    } catch (err) {
      logWarn('hyrox-reminder', `location ${block.location_id} failed`, { err: err?.message })
    }
  }
  return stats
}
```

What changed against main:
- the recipient block moved above the claim, into `classRecipients`;
- `resolveRoleRecipientIds` became `readRoleRecipientIds`;
- the RPC error is now read and logged;
- the new `recipients_failed` counter;
- `logError` import.

The claim, the session lookup, the send and the bookkeeping are byte-for-byte main's.

- [ ] **Step 4: Run the guardrail lint on the file.** The bookkeeping `.update()` (main `:80-82`) is carried over unchanged ("best-effort bookkeeping", out of scope), and the moved code must add no new finding:

```bash
npx eslint --config eslint.guardrails.config.mjs src/lib/hyrox/reminder-runner.js
```

Expected: exit 0 (`check:guardrails` is green on main and this file is inside its glob).

- [ ] **Step 5: Run and see it pass** (under both host timezones: the class time string is formatted in Dublin).

```bash
npx vitest run src/lib/hyrox/reminder-runner.test.js
TZ=America/Los_Angeles npx vitest run src/lib/hyrox/reminder-runner.test.js
```

Expected: PASS both.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/hyrox/reminder-runner.js src/lib/hyrox/reminder-runner.test.js
git commit -m "RECIPIENTS.1: Hyrox reminder works out recipients before claiming the class; a failed read retries next tick

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: the swap cover loop — one read for the pool, a fault for the sweep

**Files:** Modify `src/lib/swap-cover-server.js:11, 56-65, 84-102, 276-289` and `src/lib/swap-cover-server.test.js:7-9, 16, 84, 98, 210-214, 235, 322, 390, 397`.

- [ ] **Step 1: Re-point the test mocks and write the failing tests** in `src/lib/swap-cover-server.test.js`.

Replace the push mock (:7-9) and its import (:16):

```js
vi.mock('./push', async (importOriginal) => {
  const real = await importOriginal()
  return {
    readRoleRecipientIds: vi.fn(),
    // REAL: the pool derives managers from its members read with this rule.
    roleRecipientIdsFromLinks: real.roleRecipientIdsFromLinks,
  }
})
```

```js
const { readRoleRecipientIds } = await import('./push')
```

Mechanical re-points:
- `:84` → `readRoleRecipientIds.mockResolvedValue({ ids: ['mgr'], error: null })`;
- `:235` and `:322` → `readRoleRecipientIds`;
- `:390` → `readRoleRecipientIds.mockResolvedValue({ ids: ['mgr', 'req', 'mgr2'], error: null })`;
- `:397` → `readRoleRecipientIds.mockResolvedValue({ ids: ['req'], error: null })`.

In the first `notifyOpenPool` test, replace the two lines at :97-98:

```js
    // The same resolver and role set notifyUsersAtRolesOnce uses for swap_open.
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(db, LOC, MANAGER_ROLES)
```

with:

```js
    // C1 RECIPIENTS.1 — managers come from THIS read, by the resolver's own
    // rule (roleRecipientIdsFromLinks): no second read to fail.
    expect(db.queries.filter((q) => q.table === 'profile_locations')).toHaveLength(1)
    expect(readRoleRecipientIds).not.toHaveBeenCalled()
```

Replace the test at :210-214 ("the manager resolver coming back empty …") with:

```js
    it('managers come from the members read itself: a manager, and a master whatever their role here, are never pool recipients', async () => {
      const members = [...MEMBERS, link('boss', { profiles: { id: 'boss', role: 'master', active: true } })]
      await notifyOpenPool(mockDb(healthy({ profile_locations: { data: members, error: null } })), ARGS)
      expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['a', 'b'])
      expect(readRoleRecipientIds).not.toHaveBeenCalled()
    })
```

Add to `describe('runSwapCoverSweep', …)`, after the "re-pushes the studio's approvers at T-48h" test:

```js
  // C1 RECIPIENTS.1 — a failed approver read came back as [] and was counted
  // `skipped`, so a read that kept failing never showed on the arm's row.
  it('a failed approver read nudges nobody, claims nothing, is an arm fault; the next tick nudges', async () => {
    readRoleRecipientIds.mockResolvedValueOnce({ ids: [], error: { message: 'down' } })
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
    const first = await runSwapCoverSweep(db, { nowMs: START - 48 * H })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(first).toMatchObject({ open: 1, nudged: 0, skipped: 0, errors: 1 })
    expect(logError).toHaveBeenCalledWith('swap-cover', expect.stringContaining('approvers could not be read'),
      expect.objectContaining({ swapId: 's1', stage: 't48', err: 'down' }))

    // 15 minutes later, still inside the T-48h range: the same stage fires.
    const second = await runSwapCoverSweep(db, { nowMs: START - 48 * H + 15 * 60 * 1000 })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce.mock.calls[0][1]).toBe('swap_cover_nudge:s1:pending:t48')
    expect(second).toMatchObject({ nudged: 1, errors: 0 })
  })
```

Facts the test stands on (checked): `coverSweepAction` returns `{ action: 'nudge', stage: stage.key }` (`src/lib/swap-cover.js:332`) with keys `'t12'`/`'t48'` (`COVER_NUDGE_STAGES`); the existing T-48h test expects `'swap_cover_nudge:s1:pending:t48'` (`:326`). The "heard inside this stage's range" early return (`swap-cover.js:331`) reads the swap's own timestamps, which the failed tick does not change, so the second tick still nudges.

- [ ] **Step 2: Run it to see it fail.**

```bash
npx vitest run src/lib/swap-cover-server.test.js
```

Expected: FAIL. `swap-cover-server.js` imports `resolveRoleRecipientIds`, which is not on the mock.

- [ ] **Step 3: Implement** in `src/lib/swap-cover-server.js`.

Import (:11):

```js
import { readRoleRecipientIds, roleRecipientIdsFromLinks } from './push'
```

In the `notifyOpenPool` docstring, replace the line "requester, minus managers (told by swap_open, resolved with the same helper / so the sets cannot drift)" (:60-62) with:

```js
 * requester, minus managers (told by swap_open; worked out from the members
 * read below by the resolver's own rule, roleRecipientIdsFromLinks, so the
 * sets cannot drift and there is no second read to fail), minus approved
 * whole-day leave covering the date, minus an overlapping live shift at any
 * studio in the same organisation. Bulk reads, never one pair per coach.
```

(keeping the rest of the docstring as it is).

Replace :87-102 (from `const [membersRes, managerIds] = await Promise.all([` to the closing `}` of `const rule = {…}`) with:

```js
  const membersRes = await db.from('profile_locations').select(MEMBER_SELECT).eq('location_id', locationId)
  if (membersRes.error) {
    logError('swap-cover', 'open-pool members read failed; nobody was notified (managers still were)', { swapId, err: membersRes.error.message })
    return { notified: 0, degraded: true }
  }

  const members = membersRes.data || []
  const rule = {
    locationId,
    members,
    // C1 RECIPIENTS.1 — swap_open's managers, from THIS read (MEMBER_SELECT
    // carries role + profiles(role, active)). A second resolver read used to
    // sit here; its failure came back as [], and only isManagerLink kept
    // managers out of the pool. That belt stays in openPoolRecipients.
    managerIds: roleRecipientIdsFromLinks(members, MANAGER_ROLES),
    requesterId: requester?.id,
    block,
  }
```

In the sweep, replace :279-288 (from the `// The same recipients swap_open reached` comment to the `continue` that ends the nudge branch) with:

```js
        // The same recipients swap_open reached (the same resolver,
        // MANAGER_ROLES at the swap's own studio), minus the requester: a
        // manager who posted their own swap is not chased to review it.
        // At-most-once per (swap, status, stage, recipient) via the ledger.
        // C1 RECIPIENTS.1 — a FAILED read is an arm fault, not "nobody": no
        // claim is taken, the stage is a RANGE, so the next tick nudges; and
        // errors>0 withholds this tick's swap-cover-sweep stamp, so a read
        // that keeps failing turns the row stale (900 s + 1,800 s).
        const { ids, error: approverErr } = await readRoleRecipientIds(db, swap.location_id, MANAGER_ROLES)
        if (approverErr) {
          logError('swap-cover', 'sweep nudge: the approvers could not be read; nobody was nudged, the next tick retries', {
            swapId: swap.id, stage: decision.stage, err: approverErr.message,
          })
          stats.errors++
          continue
        }
        const approvers = ids.filter((id) => id && id !== swap.requester_id)
        const result = approvers.length ? await notifyUsersOnce(db, key, approvers, payload) : null
        if (delivered(result)) stats.nudged++
        else stats.skipped++
        continue
```

(`const { key, payload } = coverNudgePayload(swap, decision.stage)` on the line above stays where it is.)

Also update the file comment at :23-26: after "(that helper discards it)" add ` — and the pool's managers come from these same rows (C1 RECIPIENTS.1)`.

- [ ] **Step 4: Run and see it pass.**

```bash
npx vitest run src/lib/swap-cover-server.test.js src/lib/swap-cover.test.js src/app/api/cron/checklist-sweep/route.test.js
```

Expected: PASS, 0 failed.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/swap-cover-server.js src/lib/swap-cover-server.test.js
git commit -m "RECIPIENTS.1: open pool derives managers from its members read; sweep nudge counts a failed approver read as an arm fault

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: roster runway — the count, and the arm's heartbeat predicate

**Files:** Modify `src/lib/roster-runway-notify.js:113-123, 153-158`, `src/lib/cron-arm-health.js:69-78`; tests `src/lib/roster-runway-notify.test.js:206, 217` (+ new), `src/lib/roster-runway-notify.recipients.test.js:5-6, 12, 22-31, 62-70` (+ new), `src/lib/cron-arm-health.test.js:179` (+ new).

- [ ] **Step 1: Write the failing tests.**

`src/lib/roster-runway-notify.test.js`: add `recipients_failed: 0` to the two `toEqual` outcomes at :206 and :217, e.g.

```js
    expect(outcome).toEqual({ locations: 2, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0, recipients_failed: 0 })
```

and add to the `runRosterRunwayAlerts` describe, before the "a failed read throws" test:

```js
  // C1 RECIPIENTS.1 — a failed recipients read used to come back as EMPTY and
  // the run read as clean.
  it('a failed recipients read is counted apart from delivery', async () => {
    notifyUsersAtRolesOnce.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 0, recipients_failed: 1 })
    const outcome = await runRosterRunwayAlerts(makeDb([NORTH]), { nowMs: CRON_TICK })
    expect(outcome).toEqual({ locations: 1, alerts: 1, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0, recipients_failed: 1 })
  })
```

`src/lib/cron-arm-health.test.js`: at :179 add `recipients_failed: 0` to the drift-guard's expected outcome, and add to `describe('runwayArmHealthy', …)` (after :95):

```js
  it('a failed recipients read is a fault: nobody was told, and the week waits for tomorrow (C1 RECIPIENTS.1)', () => {
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, recipients_failed: 1 })).toBe(false)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, recipients_failed: 0 })).toBe(true)
    // An outcome from before the counter existed is judged as it was.
    expect(runwayArmHealthy(RUNWAY_CLEAN)).toBe(true)
  })
```

`src/lib/roster-runway-notify.recipients.test.js`:
- :12 → `const state = { locations: [], links: [], linksError: null, claims: new Set(), tokens: [], profiles: [] }`
- in `fakeDb`'s `profile_locations` branch (:22-31), first line inside `eq:` after the column check:

```js
            if (state.linksError) return thenable({ data: null, error: state.linksError })
```

- the `./push` mock (:62-70): replace `resolveRoleRecipientIds: real.resolveRoleRecipientIds,` with `readRoleRecipientIds: real.readRoleRecipientIds,` (comment: `// REAL: who holds a publishing role AT this location is what is under test.`)
- header comment :5: `the REAL resolveRoleRecipientIds` → `the REAL readRoleRecipientIds`
- in `beforeEach`, after `state.claims = new Set()`: `state.linksError = null`
- after the `const { runRosterRunwayAlerts } = …` import line: `const { runwayArmHealthy } = await import('./cron-arm-health')`
- new describe at the end of the file:

```js
// C1 RECIPIENTS.1 — end to end through the REAL push-dedup and the REAL
// readRoleRecipientIds: a failed profile_locations read claims no key, tells
// nobody, withholds the arm's stamp, and the next daily run still sends.
describe('roster runway push — a failed recipients read', () => {
  it('claims nothing, tells nobody, is a fault, and the next day\'s run still sends', async () => {
    state.linksError = { message: 'profile_locations down' }
    const day9 = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(day9).toMatchObject({ alerts: 1, sent: 0, emailed: 0, failed: 0, recipients_failed: 1 })
    expect(sendPush).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(state.claims.size).toBe(0)
    expect(runwayArmHealthy(day9)).toBe(false)

    state.linksError = null
    const day8 = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 + 24 * 3600 * 1000 })
    expect(day8).toMatchObject({ recipients_failed: 0 })
    expect([...sendPush.mock.calls[0][0]].sort()).toEqual([...PUBLISHERS].sort())
    expect(runwayArmHealthy(day8)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see them fail.**

```bash
npx vitest run src/lib/roster-runway-notify.test.js src/lib/roster-runway-notify.recipients.test.js src/lib/cron-arm-health.test.js
```

Expected: FAIL. The outcomes lack `recipients_failed`, `runwayArmHealthy({ …, recipients_failed: 1 })` is true, and the recipients test's day-9 run passes `recipients_failed` nowhere.

- [ ] **Step 3: Implement.**

`src/lib/roster-runway-notify.js`. Docstring :113-121: change `@returns` to

```js
 * @returns {Promise<{ locations: number, alerts: number, quiet_hours: number, sent: number, emailed: number, deduped: number, failed: number, recipients_failed: number }>}
 *   throws when the locations or runway read fails, BEFORE anything is sent
 *   (the cron records it). `recipients_failed` (C1 RECIPIENTS.1) counts
 *   weeks whose "who can publish here" read failed: nobody was told, no key
 *   was claimed, so the next daily run tries again; the arm's heartbeat
 *   treats it as a fault (cron-arm-health.js runwayArmHealthy).
```

:123 →

```js
  const outcome = { locations: 0, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0, recipients_failed: 0 }
```

After :158 (`outcome.failed += r.failed || 0`) add:

```js
        outcome.recipients_failed += r.recipients_failed || 0
```

Comment :28: `resolveRoleRecipientIds (src/lib/push.js) reads the` → `readRoleRecipientIds (src/lib/push.js, via notifyUsersAtRolesOnce) reads the`. Comment :45: `resolveRoleRecipientIds always includes the` → `readRoleRecipientIds always includes the`.

`src/lib/cron-arm-health.js`, replace :69-78:

```js
/**
 * True when a runRosterRunwayAlerts() outcome shows a clean run. The arm throws
 * on every failure of its own (a locations or runway read), which the parent
 * cron records as { error }; `failed` is a per-recipient delivery count whose
 * claims are released for the next daily run, so it does not block the stamp.
 * C1 RECIPIENTS.1: `recipients_failed` DOES block it: the arm's own "who can
 * publish here" read failed, so nobody was told. Nothing was claimed and the
 * next daily run retries, but a stamp would call the run clean. With the
 * row's 86,400 s + 43,200 s, one bad day turns it stale that evening.
 */
export function runwayArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  if (Object.prototype.hasOwnProperty.call(outcome, 'error')) return false
  return count(outcome.recipients_failed) === 0
}
```

- [ ] **Step 4: Run and see them pass.**

```bash
npx vitest run src/lib/roster-runway-notify.test.js src/lib/roster-runway-notify.recipients.test.js src/lib/cron-arm-health.test.js src/app/api/cron/contract-reminders/route.test.js
```

Expected: PASS, 0 failed. The contract-reminders route test mocks the arm with an outcome that has no `recipients_failed`, which counts as 0, so it is still stamped.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/roster-runway-notify.js src/lib/roster-runway-notify.test.js src/lib/roster-runway-notify.recipients.test.js src/lib/cron-arm-health.js src/lib/cron-arm-health.test.js
git commit -m "RECIPIENTS.1: roster-runway arm counts a failed recipients read and does not stamp a clean run on it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: the guard — nothing calls `resolveRoleRecipientIds`

**Files:** Create `tests/role-recipients-callers.test.js`. Modify `src/app/api/schedule/swaps/route.get.test.js:27`.

- [ ] **Step 1: Write the guard test** — `tests/role-recipients-callers.test.js`:

```js
// C1 RECIPIENTS.1 — resolveRoleRecipientIds turned a FAILED "who holds these
// roles here" read into [], which every caller read as "nobody to tell". Every
// caller moved to readRoleRecipientIds ({ ids, error }). The old helper stays
// in src/lib/push.js for ONE deploy (@deprecated), and D1 DEADCODE.1 deletes
// it with its one contract test; then shrink ALLOWED to this file alone.
//
// A source scan, so a FLOOR not proof: it cannot see a caller that builds the
// name at runtime. The behavioural proof is in push-roles.test.js,
// push-dedup.test.js and each migrated caller's own suite.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN = ['src', 'shared', 'mobile', 'scripts', 'tests']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'build'])
const SOURCE = /\.(js|jsx|mjs)$/
const ALLOWED = new Set([
  'src/lib/push.js', // the @deprecated definition, until D1 DEADCODE.1
  'src/lib/push.test.js', // its old-contract test, deleted with it
  'tests/role-recipients-callers.test.js',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE.test(name)) out.push(full)
  }
  return out
}

describe('resolveRoleRecipientIds has no callers (C1 RECIPIENTS.1)', () => {
  it('nothing outside its own definition and test names it', () => {
    const offenders = SCAN
      .flatMap((d) => walk(join(ROOT, d)))
      .map((full) => relative(ROOT, full).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\bresolveRoleRecipientIds\b/.test(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see what it catches.**

```bash
npx vitest run tests/role-recipients-callers.test.js
```

Expected: FAIL, listing the files that still name it:
- `src/app/api/schedule/swaps/route.get.test.js`;
- the comments in `src/lib/availability-notify.js`, `src/lib/qualification-digest.js` and `src/lib/swap-cover.js`.

Tasks 1-6 already cleared the others. If anything else is listed, it is a caller this plan missed. **Stop and treat it like Tasks 3-6**, don't just rename it.

- [ ] **Step 3: `src/app/api/schedule/swaps/route.get.test.js:27`** → `vi.mock('@/lib/push', () => ({ readRoleRecipientIds: vi.fn() }))` (the GET route never fans out; the mock only keeps the module from loading).

The three comments are Task 8.

### Task 8: comments that name the old helper

**Files:** Modify `src/lib/swap-cover.js:88-90, 120`, `src/lib/availability-notify.js:7-9`, `src/lib/qualification-digest.js:9-10`. Comments only.

- [ ] **Step 1: Rewrite them.**

`src/lib/swap-cover.js:88-90`:

```js
// The rule readRoleRecipientIds (src/lib/push.js, roleRecipientIdsFromLinks)
// applies, re-stated on the link row itself: a belt to the server half, which
// derives managerIds from the same rows. An empty manager list must never turn
// every manager into a pool recipient.
```

`src/lib/swap-cover.js:120`:

```js
 * @param {string[]} args.managerIds      swap_open recipients (roleRecipientIdsFromLinks over `members`)
```

`src/lib/availability-notify.js:7-9`:

```js
// never the coach. Read here with its own query (the roles and the studios
// differ from readRoleRecipientIds' single-studio read), keeping the error:
// "the read failed" must never be stamped as "nobody to tell".
```

`src/lib/qualification-digest.js:9-10`:

```js
// readRoleRecipientIds rule, src/lib/push.js, re-read here so a failed
// read throws instead of looking like "nobody to tell"). Their list covers
```

(Keep the surrounding lines as they are; read each file's neighbouring lines and make the sentence flow.)

- [ ] **Step 2: Run the guard and the touched suites.**

```bash
npx vitest run tests/role-recipients-callers.test.js src/app/api/schedule/swaps/route.get.test.js src/lib/swap-cover.test.js src/lib/availability-notify.test.js src/lib/qualification-digest.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add tests/role-recipients-callers.test.js src/app/api/schedule/swaps/route.get.test.js src/lib/swap-cover.js src/lib/availability-notify.js src/lib/qualification-digest.js
git commit -m "RECIPIENTS.1: guard that nothing calls resolveRoleRecipientIds; comments point at readRoleRecipientIds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase, then re-run the focused suites under both host timezones:

```bash
git fetch origin main && git rebase origin/main
npx vitest run src/lib/push-roles.test.js src/lib/push.test.js src/lib/push-dedup.test.js src/lib/hyrox/reminder-runner.test.js src/lib/swap-cover-server.test.js src/lib/roster-runway-notify.test.js src/lib/roster-runway-notify.recipients.test.js src/lib/cron-arm-health.test.js src/app/api/cron/equipment-inspection-sweep/route.test.js src/app/api/cron/equipment-inspection-reminder/route.test.js src/app/api/cron/checklist-sweep/route.test.js src/app/api/cron/contract-reminders/route.test.js tests/role-recipients-callers.test.js
TZ=America/Los_Angeles npx vitest run src/lib/hyrox/reminder-runner.test.js src/lib/swap-cover-server.test.js src/lib/roster-runway-notify.recipients.test.js
```

Expected: all green. After the rebase, re-run Task 0 Step 1: a caller added on main since planning must be migrated before merge.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
set -o pipefail
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`. In particular:
- `npm test`: any suite that mocks `@/lib/push` / `./push` with a factory and runs the REAL `push-dedup` through a role fan-out would now fail with "No \"readRoleRecipientIds\" export is defined on the mock". Planning found none (every such suite also mocks `push-dedup`, or never reaches a role path); if one appears, add `readRoleRecipientIds` to its mock the way Task 6 did.
- `check:guardrails`: every new read destructures `error`; no bare writes added.
- `check:select-columns`: no `.select()` string changed. `notifyOpenPool` lost a read; the remaining `MEMBER_SELECT` is unchanged.
- `check:ota-paths`: nothing under `mobile/` or `shared/`, so no publish.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. This also proves no import of the deleted `notifyUsersAtRoles` remains.

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - **D1**: no throw anywhere; every wrapper still resolves.
  - **D2/D3**: `recipients_failed` is absent on success, and is never folded into `failed`.
  - **D4**: the one-bad-day-pages-that-evening arithmetic for `roster-runway`.
  - **D5**: `errors++` withholds only the swap arm's stamp, and `expireSwap` is untouched.
  - **D6**: `roleRecipientIdsFromLinks(members, MANAGER_ROLES)` is exactly the old second read's answer, because MEMBER_SELECT carries the same columns.
  - **D7**: the Hyrox reorder. The claim, the session read, the send and the bookkeeping are unchanged; only the recipient block moved above the claim. Also the deliberate "nobody → no claim" change.
  - **D8**: why the whole-cron heartbeats still stamp.
  - The transitive-caller table: confirm none of them now does something LOUDER (no throw, no early return before an existing state write, no new 500).

- [ ] **Preview check** (GET-only, prod data; local dev has no database). Nothing here is visible on a page, and a failed `profile_locations` read cannot be forced from a preview. The check is that nothing moved on the happy path. On the Vercel preview, as Richard (master):
  - open `/schedule` → Swaps: the list loads (the GET route's module graph imports push);
  - open `/api/cron/health-check` with the cron secret (a GET that changes nothing): `roster-runway`, `swap-cover-sweep`, `hyrox-class-reminder`, `equipment-inspection-sweep` are not stale.

  After merge, the next scheduled runs are the real check:
  - the 08:00 UTC `contract-reminders` run stamps `roster-runway` with `recipients_failed: 0` in `last_outcome`;
  - the next `checklist-sweep` tick stamps `swap-cover-sweep`;
  - the next Hyrox class gets its reminder (`hyrox_class_reminders` gains a row with `recipient_count` set).

  Read them via Supabase MCP (`select name, last_ok_at, last_outcome from cron_heartbeats where name in (…)`).

---

### PR

**Title:** `RECIPIENTS.1 — a failed "who are the managers" read is never "nobody to tell"`

**Body must say, in this order:**
1. **Web only. No migration. No OTA** (nothing under `mobile/` or `shared/`).
2. **The defect:** `resolveRoleRecipientIds` returned `[]` on a failed `profile_locations` read, so every role fan-out read a failure as "nobody holds the role". Worst case, live: the **Hyrox class reminder** claimed the class before reading who to tell, so a failed read lost that class's reminder for good (1 active block, 18 reminders so far). The **roster-runway** arm and the **swap-cover** sweep reported clean runs and stamped their heartbeats. The **equipment reminder** audited "reminder_sent" to nobody.
3. **What changed, per caller** (the table from this plan, condensed): retry next tick (Hyrox, swap sweep), next daily run (runway, equipment sweep), same-day 19:00 sweep (equipment reminder), arm fault (runway, swap sweep), logged (every one-shot alert via the three wrappers).
4. **Nothing got louder:** no function throws that did not before; no state write is skipped that happened before (except the equipment reminder's false "reminder_sent" audit row); the only new heartbeat effects are on the two per-arm rows, and only when their own read failed.
5. **Behaviour changes on the happy path:**
   - the Hyrox reminder no longer claims a class it had nobody to tell about, so a coach rostered in the last half hour is still reminded;
   - the open-pool broadcast makes one `profile_locations` read instead of two;
   - `notifyUsersAtRoles` (zero callers) is deleted.
6. `resolveRoleRecipientIds` stays one deploy (`@deprecated`, zero callers, guard-tested); **D1 DEADCODE.1 deletes it.**
7. Preview-check result.
8. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row (`merge=union`).

```
| #<PR> | RECIPIENTS.1 — a failed "who are the managers" read is never "nobody to tell" | 2026-09-2x. Follow-ups C1. **Web only; no mig, no OTA.** `resolveRoleRecipientIds` (push.js) returned [] on a failed profile_locations read, so every role fan-out read the failure as "nobody holds the role". Every caller moved to `readRoleRecipientIds` ({ ids, error }): the three wrappers (`sendPushToRolesAtLocation`, `sendPushToRolesAtLocationOnce`, `notifyUsersAtRolesOnce`) logError once, claim nothing, send nothing, return zeros + `recipients_failed: 1` (absent on success; never folded into `failed`), never throw — so the 28 one-shot alert call sites get a structured log unchanged. Deciding callers: Hyrox reminder works out recipients BEFORE claiming the class (it claimed first, so a failed read lost the reminder for good; "nobody" no longer claims either), retried next 5-min tick; swap-cover sweep nudge = `errors++` (swap-cover-sweep not stamped), retried next tick; open-pool derives managers from its own members read via the new pure `roleRecipientIdsFromLinks` (one read, not two); roster-runway counts `recipients_failed` and `runwayArmHealthy` faults on it (86400+43200: one bad day stales that evening), retried next daily run (key unclaimed); equipment sweep reports it per location (whole-cron stamp kept); equipment reminder no longer audits "reminder_sent" to nobody (19:00 sweep recovers). Dead `notifyUsersAtRoles` deleted. `resolveRoleRecipientIds` kept @deprecated one deploy, guard `tests/role-recipients-callers.test.js`; D1 DEADCODE.1 deletes it. |
```

---

### Open questions for the owner (Richard)

1. **Should a one-bad-day runway read page you that evening?** With the `roster-runway` row at 24 h + 12 h grace, a single failed `profile_locations` read at the 08:00 run turns the row stale at 20:00 and the health-check pages. This matches what already happens when that arm's other reads fail (they throw). If you'd rather only a SECOND consecutive bad day paged, the row's grace would go to 36 h+ in a migration (C2-style). Not needed to ship this.
2. **The one-shot staff alerts** (WhatsApp health, Mia handoff/approval SLA escalations, checklist compliance, new issue, new lead…) still lose their message on a failed recipients read. Now it is logged, but nothing retries it, just as nothing retries a failed Expo send for them today. Making any of them retry means a ledger or lease per feature. Worth doing for any specific one? The SLA escalations (`handoff-sla`, `approvals-sla`) are the likeliest candidates: they stamp first by design ("so a push hiccup can't re-alert every tick").

### Follow-ups found while planning (not in this PR)

- **D1 DEADCODE.1:** add "delete `resolveRoleRecipientIds` and the `push.test.js` old-contract test; shrink `ALLOWED` in `tests/role-recipients-callers.test.js` to the test file itself". This PR's deploy is the one-deploy grace.
- `resolveLocationMemberIds` (`src/lib/push.js:423-429`) has the same shape: `const { data: links } = …`, error discarded, `[]` on failure. Its one caller is `sendPushToInboxStaffAtLocation` (the "Mia is handling a chat" ping). Same fix pattern; a small separate PR, or fold into C5 if its review wants.
- `refresh-whatsapp-health/route.js:15-23` `tryPush` returns true (so `alerted++`) for any non-throwing result, including `recipients_failed`. It is a response counter only; a one-line `return !r?.recipients_failed` in a later hygiene PR.
- `hyrox/reminder-runner.js` still discards the error of its `hyrox_blocks`, `class_occurrences` and claim-upsert reads (each fails safe: no send and no claim, so the next tick retries), and its bookkeeping `.update()` is bare. Out of scope here; note for the discarded-error lint campaign.

---

### Self-review (done while writing)

- **Spec coverage** (row C1 + the brief):
  - every direct caller: table rows 1-9, Tasks 1-6, with the brief's list confirmed. The roster-runway "arm" is a caller through `notifyUsersAtRolesOnce`, not directly;
  - `notify.js:201`: deleted (D10), not migrated, because it has zero callers;
  - per-caller failure trace, today and after: the two tables;
  - heartbeat predicates: D4, D5, D8, and `cron-arm-health.js`;
  - QUALS.1's `sendOnce` change: "What was found" + D3;
  - "keep one deploy then delete": D11 + the guard;
  - "change it to throw instead?": D1;
  - OTA: none (checked `shared/`, `mobile/`);
  - each caller's "failed read never stamps / never reports clean" test: push-roles, push-dedup (×2 + retry), equipment sweep, equipment reminder, Hyrox (fail, then retry), swap sweep (fault, then retry), runway (unit + end-to-end + predicate).
- **Placeholders:** none. `<PR>` and the `x` in the CHANGELOG date are filled at PR time. Test files named in commands were checked to exist on main (`notify.test.js` does not, and is not named).
- **Names:** used identically across tasks:
  - `roleRecipientIdsFromLinks(links, roles)`: Task 1 definition, Task 5 use and mock, Task 8 comments;
  - `readRoleRecipientIds(db, locationId, roles) → { ids, error }`;
  - `recipients_failed` (number 1 from the wrappers, a number in the runway outcome and Hyrox stats, boolean `true` in the two equipment result rows, which are per-location records, not counters);
  - `runwayArmHealthy`;
  - `classRecipients` (Hyrox, file-private).
- **Line anchors** were verified against `origin/main` `28d02e59`. If main moves, find each by the quoted text.
