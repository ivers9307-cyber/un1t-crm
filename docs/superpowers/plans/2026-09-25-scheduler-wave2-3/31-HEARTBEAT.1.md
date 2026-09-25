## PR HEARTBEAT.1 — the shift-reminder arm and the roster-runway arm get heartbeat rows of their own, stamped only when the arm ran clean

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shift-reminder arm or a roster-runway arm that throws or reports a fault on every run makes `/api/cron/health-check` answer 503 and pages. At the moment neither can: each arm rides a parent cron whose heartbeat row is stamped whatever the arm did. The health-check reads only `cron_health.is_stale`, never `last_outcome`.

**Architecture:** This mirrors SWAPHB.1 (#1737, mig 623) exactly. There are two new `cron_heartbeats` rows, `shift-reminders` and `roster-runway`, seeded by migration 633 and born healthy. One small pure module, `src/lib/cron-arm-health.js`, holds the two row names and the two "did this arm run clean" predicates. Each parent route stamps its arm's row with the arm's own counts only when the arm returned a result and the predicate passes. Each stamp has its own `.catch`, so a failing arm stamp cannot cost the parent anything. Each is placed so the other half of the route cannot cost the arm its stamp. The parent rows (`send-push-reminders`, `contract-reminders`) keep their stamps exactly as they are today.

**Tech Stack:** Next.js 16 route handlers, Supabase Postgres (`cron_heartbeats` / `cron_health`, mig 053), Vitest 5, PGlite for the migration replay.

**Ships:** web deploy only. **Migration 633** (reserved in `00-INDEX.md`), **apply BEFORE the merge**. Nothing changes under `mobile/` or `shared/` and `vercel.json` is untouched, so there is **no OTA**.

**Worktree:** branch `heartbeat-1` off a fresh `origin/main`, in its own fresh worktree (`git fetch origin main && git worktree add ~/code/un1t-crm-heartbeat1 -b heartbeat-1 origin/main`). If `node_modules` is missing, run `npm ci` once. For tests use `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

---

### What was found (verified against `origin/main` at `2f0b35ba`)

**Where each arm runs today**

| Arm | Module | Parent cron (schedule, `vercel.json`) | Parent's heartbeat row | What a failing arm does today |
|---|---|---|---|---|
| Shift reminders (SHIFTREMIND.1, #1730) | `runShiftReminders` in `src/lib/shift-reminders.js:447` | `/api/cron/send-push-reminders`, `*/5 * * * *` (`vercel.json:84-85`) | `send-push-reminders`, 300s interval + 600s grace (mig 171). Stamped with **no outcome** at `route.js:402-403`, on every tick that got past the locations read | throws → caught at `route.js:388-395`, `shift_arm_failed: 1` in the response and in the `logInfo` tick line, parent still stamped. Returned faults (`shift_claim_failed`, `shift_send_threw`, `shift_read_capped`) show up only as counters in the response |
| Roster runway (RUNWAY.1, #1734) | `runRosterRunwayAlerts` in `src/lib/roster-runway-notify.js:122` | `/api/cron/contract-reminders`, `0 8 * * *` UTC (`vercel.json:204`), which is 09:00 Dublin in summer and 08:00 in winter | `contract-reminders`, 86400 + 43200 (mig 445:20-22). Stamped at `route.js:156-158` with `{ …, runway, runway_arm_failed }` | throws → caught at `route.js:62-68`, `runway: { error }` + `runway_arm_failed: 1` in the response and in the parent's `last_outcome`, parent still stamped |

**Who reads heartbeats:** `/api/cron/health-check` (`src/app/api/cron/health-check/route.js:41-58`) selects `name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale` from the `cron_health` view and answers 503 when any row `is_stale` (line 83). The view (mig 053:51-60) is an unfiltered SELECT over `cron_heartbeats`, so **a new row is monitored as soon as it exists and no reader holds a list of names**. `un1t-sentinel` reads the health-check response (`src/checks/cron-health.js`). It turns each name in `stale` into a signal, and it has no name registry, so nothing needs registering there. (The #1737 row guessed that it might; checked, it does not.)

**`stampHeartbeat(name, outcome)`** (`src/lib/cron-heartbeat.js:32`) is UPDATE-only (`.update(patch).eq('name', name)`, line 44). It writes `last_outcome` when an outcome is passed (column added by mig 315:35) and never throws. A stamp with no seeded row matches 0 rows and only logs `stamp matched 0 rows`, so **mig 633 must be applied before the code deploys**.

**Table shape** (mig 053:26-32 + 315:35): `name TEXT PK`, `last_ok_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `expected_interval_seconds INT NOT NULL CHECK > 0`, `grace_seconds INT NOT NULL DEFAULT 60 CHECK >= 0`, `notes TEXT`, `last_outcome JSONB`. The row is stale when `now() - last_ok_at > expected_interval_seconds + grace_seconds`.

**Naming:** rows are kebab-case, named after the route or, for an arm, after the arm (`swap-cover-sweep`, mig 623). So the new rows are `shift-reminders` and `roster-runway`.

**What each arm returns** (the "ran" evidence and the fault counters):

- `runShiftReminders` always returns `emptySummary()`'s shape (`shift-reminders.js:395-408`): `quiet_hours, shift_candidates, shift_pushed, shift_emailed, shift_skipped_dup, shift_skipped_no_recipient, shift_send_failed, shift_send_threw, shift_claim_failed, shift_read_capped`. It **throws** when the shift read fails (485) or the ledger read fails (530). It **returns normally** with `quiet_hours: 1` between 22:00 and 07:00, before any read (470-473). It also returns normally with no locations (450) and with nothing due (490, 500, 515).
  - `shift_claim_failed` (548): a ledger insert failed and that reminder was NOT sent.
  - `shift_send_threw` (580): `notifyUsers` threw, which its contract says it never does. The claim is kept and the reminder is lost.
  - `shift_read_capped` (487): the 1,000-row cap was hit, so reminders were missed.
  - `shift_send_failed` (593): nothing was delivered on either channel. The claim is **released** and the **next tick retries**.
- `runRosterRunwayAlerts` returns `{ locations, alerts, quiet_hours, sent, emailed, deduped, failed }` (123). It **throws** when the locations read (127) or the runway read (132) fails, before anything is sent. `failed` adds up `notifyUsersAtRolesOnce`'s Expo failures (158) and a thrown send (161). `push-dedup.js:110-113` releases the claim on a total pipeline failure, so the next daily run retries that week.

**Decisions (the brief's questions):**

1. **A run with nothing to send stamps.** A quiet day, a quiet-hours tick, no locations, nothing due and everything deduped are all healthy runs. Without this the shift row would go stale every night at 22:20, and the runway row would go stale on any day with no unready week.
2. **A throw never stamps. Neither does a resolved non-object** (a mock returning `undefined`, a future refactor that forgets to return): such a run has not shown that it ran. This matches SWAPHB.1's `swapSweepFailed === 0 && swapCover`.
3. **Fault counters that block the stamp.** Only faults in the arm's own machinery block it, not delivery to one device:
   - Shift arm: `shift_claim_failed`, `shift_send_threw` and `shift_read_capped` must all be 0.
   - `shift_send_failed` does **not** block the stamp. That reminder's claim is released and retried on the next tick, and the cause is usually one coach's dead token or a bounced fallback address. That coach's reminder would keep a heartbeat stale for up to ten hours and page ops about one device. The counter still reaches the row's `last_outcome`.
   - Runway arm: the only error outcome is a throw, which the parent records as `runway: { error }`. `failed` rides in `last_outcome` and does not block the stamp: it is a per-recipient Expo count, the claim is released and retried the next day, and with a daily cadence it would page on one flaky push. Both calls are Review note 2.
4. **When the parent's gate skips the arm by design.** Neither parent ever skips its arm on purpose. `send-push-reminders` runs the shift arm on every authorised tick except a failed locations read (a 500 at `route.js:81-84`, before the arm). That tick is correctly a non-run: neither row is stamped, as today. `contract-reminders` runs the runway arm first, unconditionally (`route.js:60-68`). Both arms gate on **quiet hours inside the arm** and return normally, so quiet ticks stamp.
5. **Thresholds follow each arm's real cadence:**
   - **`shift-reminders`: 300s interval, 900s grace.** The row goes stale 20 minutes after the last clean run. Two bad ticks in a row never page: the next good tick lands at +15 min, well inside 20. Four in a row always page, at +20 min. The grace is not the parent's 600 (mig 171) on purpose, for SWAPHB.1's reason: this stamp is conditional, and a 300+600 row would sit exactly on the stale boundary when a good tick lands after two transient throws (a ledger-read blip, say).
   - **`roster-runway`: 86400s interval, 43200s grace.** This is the daily convention of the parent row (mig 445) and of `extend-roster-horizon` (mig 601): a missed day plus half a day. The cron is 08:00 UTC all year, so DST does not move the interval. One failed daily run pages at about 20:00 UTC that day, which is right: its next retry is 24 hours away. A deploy window or a slow run never cries wolf.
6. **The stamp carries the arm's own outcome** (mirrors SWAPHB.1): `shift-reminders.last_outcome` holds the shift counters and `roster-runway.last_outcome` holds the runway counts. This is new for the shift arm. The parent stamps with no outcome, so until now there was nowhere in the database to see the shift arm's counts.
7. **ON CONFLICT DO NOTHING**, as the brief asks and as migs 053/171/445 do, not the `DO UPDATE` re-arm of 601/623. The trade-offs, and the re-arm command this choice needs at apply time, are Review note 1. The migration's self-check refuses a pre-existing row whose cadence is wrong. Without it, DO NOTHING could keep that row silently.

**Rules that bite in this PR:**
- `stampHeartbeat` is UPDATE-only, so apply 633 **before** the merge. The `shift-reminders` row is born healthy with 20 minutes of runway, so apply it only when the PR is green on its final rebase and merge straight after (the runbook is in Task 6).
- Builders are thenables. `stampHeartbeat` is an async function, so the `.catch(...)` the routes already use on it is valid. Keep that shape.
- The route test files mock `@/lib/shift-reminders` and `@/lib/roster-runway-notify` down to one export each. That is why the predicates live in a **separate** module: a predicate exported from `shift-reminders.js` would come through the mock as `undefined` and throw inside the route.

---

### File map

| File | Change |
|---|---|
| `src/lib/cron-arm-health.js` | **new**, pure: `SHIFT_REMINDERS_HEARTBEAT`, `ROSTER_RUNWAY_HEARTBEAT`, `SHIFT_ARM_FAULT_KEYS`, `shiftReminderArmHealthy`, `runwayArmHealthy` |
| `src/lib/cron-arm-health.test.js` | **new**: predicate table, plus drift guards against the REAL arms' zero-work outcomes |
| `supabase/migrations/633_shift_reminders_roster_runway_heartbeats.sql` | **new**: two rows, idempotent, with a self-check |
| `tests/migration-633-arm-heartbeats.test.js` | **new**: PGlite replay of the real mig 053 + 633. Checks the thresholds, the replay no-op and that the self-check aborts the whole file |
| `src/app/api/cron/send-push-reminders/route.js` | keep the shift arm's summary, then stamp `shift-reminders` when it is clean. Header + catch comment updated |
| `src/app/api/cron/send-push-reminders/route.test.js` | locations-error hook, stamp reset, new `describe` for the arm heartbeat |
| `src/app/api/cron/contract-reminders/route.js` | stamp `roster-runway` right after the arm, before the contract half. Header updated |
| `src/app/api/cron/contract-reminders/route.test.js` | stamp reset, one existing assertion updated (contract-half crash), new `describe` |
| `CLAUDE.md` | one sentence on the "Crons & webhooks" heartbeat bullet: an arm gets its own row |
| `docs/CHANGELOG.md` | one row under the header |

---

### Task 1: the pure arm-health module

**Files:**
- Create: `src/lib/cron-arm-health.js`
- Test: `src/lib/cron-arm-health.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/cron-arm-health.test.js`:

```js
// HEARTBEAT.1 — the two arms that ride another cron's schedule, and when one
// of their runs counts as clean enough to stamp the arm's own heartbeat row.
// Pure predicates, plus two drift guards that run the REAL arms down their
// zero-work path, so a renamed counter or a changed "nothing to do" shape
// cannot silently turn every quiet tick into a missed stamp.

import { describe, it, expect, vi } from 'vitest'

// The arms' collaborators, mocked exactly as their own test files do. The
// zero-work paths below return before touching any of them.
vi.mock('./roster-read', () => ({ fetchApiShiftRows: vi.fn() }))
vi.mock('./notify', () => ({ notifyUsers: vi.fn() }))
vi.mock('./push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn() }))
vi.mock('./roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const {
  SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT, SHIFT_ARM_FAULT_KEYS,
  shiftReminderArmHealthy, runwayArmHealthy,
} = await import('./cron-arm-health')
const { runShiftReminders } = await import('./shift-reminders')
const { runRosterRunwayAlerts } = await import('./roster-runway-notify')

const SHIFT_CLEAN = {
  quiet_hours: 0, shift_candidates: 2, shift_pushed: 1, shift_emailed: 0, shift_skipped_dup: 1,
  shift_skipped_no_recipient: 0, shift_send_failed: 0, shift_send_threw: 0, shift_claim_failed: 0, shift_read_capped: 0,
}
const RUNWAY_CLEAN = { locations: 2, alerts: 1, quiet_hours: 0, sent: 2, emailed: 0, deduped: 0, failed: 0 }

describe('heartbeat row names', () => {
  it('are the kebab-case names mig 633 seeds (the migration test cross-checks the SQL)', () => {
    expect(SHIFT_REMINDERS_HEARTBEAT).toBe('shift-reminders')
    expect(ROSTER_RUNWAY_HEARTBEAT).toBe('roster-runway')
  })
})

describe('shiftReminderArmHealthy', () => {
  it('a clean run with work done is healthy', () => {
    expect(shiftReminderArmHealthy(SHIFT_CLEAN)).toBe(true)
  })

  it('a run with nothing to send is healthy: a quiet day, and a quiet-hours tick', () => {
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 })).toBe(true)
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, quiet_hours: 1, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 })).toBe(true)
  })

  it('a counter the summary does not carry reads as 0 (an older or partial summary is not a fault)', () => {
    expect(shiftReminderArmHealthy({ shift_candidates: 2, shift_pushed: 1 })).toBe(true)
  })

  it.each(['shift_claim_failed', 'shift_send_threw', 'shift_read_capped'])('%s > 0 is a fault in the arm itself: not healthy', (key) => {
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, [key]: 1 })).toBe(false)
  })

  it('a failed DELIVERY is not an arm fault: the claim was released and the next tick retries it', () => {
    expect(shiftReminderArmHealthy({ ...SHIFT_CLEAN, shift_send_failed: 3 })).toBe(true)
  })

  it.each([undefined, null, 'ok', 0, [SHIFT_CLEAN]])('a run that returned %j has not shown it ran: not healthy', (v) => {
    expect(shiftReminderArmHealthy(v)).toBe(false)
  })

  it('the fault keys are exactly the three it gates on', () => {
    expect([...SHIFT_ARM_FAULT_KEYS].sort()).toEqual(['shift_claim_failed', 'shift_read_capped', 'shift_send_threw'])
    expect(Object.isFrozen(SHIFT_ARM_FAULT_KEYS)).toBe(true)
  })
})

describe('runwayArmHealthy', () => {
  it('a clean run is healthy, and so is a day with nothing to announce or held back by quiet hours', () => {
    expect(runwayArmHealthy(RUNWAY_CLEAN)).toBe(true)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, alerts: 0, sent: 0 })).toBe(true)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, quiet_hours: 1, sent: 0 })).toBe(true)
    expect(runwayArmHealthy({ locations: 0, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 })).toBe(true)
  })

  it('a delivery failure inside a run that completed is still healthy (it rides in last_outcome; the claim is released for tomorrow)', () => {
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, failed: 1 })).toBe(true)
  })

  it('the parent\'s error outcome ({ error }) is not healthy, whatever else it carries', () => {
    expect(runwayArmHealthy({ error: 'runway read failed: blocks down' })).toBe(false)
    expect(runwayArmHealthy({ ...RUNWAY_CLEAN, error: 'x' })).toBe(false)
  })

  it.each([undefined, null, 'ok', 1, [RUNWAY_CLEAN]])('a run that returned %j has not shown it ran: not healthy', (v) => {
    expect(runwayArmHealthy(v)).toBe(false)
  })
})

// Drift guards: the arms' REAL zero-work outcomes must read as healthy.
describe('the real arms, on their zero-work paths', () => {
  it('runShiftReminders with no locations returns its full summary shape, every fault key 0, and it is healthy', async () => {
    const summary = await runShiftReminders(null, { locations: [] })
    for (const key of SHIFT_ARM_FAULT_KEYS) expect(summary).toHaveProperty(key, 0)
    expect(shiftReminderArmHealthy(summary)).toBe(true)
  })

  it('runShiftReminders in quiet hours (02:00 Dublin) returns quiet_hours: 1 before any read, and it is healthy', async () => {
    const db = { from: () => { throw new Error('quiet hours must not read') } }
    const summary = await runShiftReminders(db, {
      nowMs: Date.UTC(2026, 8, 25, 1, 0), // 02:00 IST
      locations: [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin' }],
    })
    expect(summary.quiet_hours).toBe(1)
    expect(shiftReminderArmHealthy(summary)).toBe(true)
  })

  it('runRosterRunwayAlerts with no locations returns its outcome, and it is healthy', async () => {
    const b = { select: () => b, then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej) }
    const outcome = await runRosterRunwayAlerts({ from: () => b }, { nowMs: Date.UTC(2026, 8, 25, 8, 0) })
    expect(outcome).toEqual({ locations: 0, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 })
    expect(runwayArmHealthy(outcome)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/cron-arm-health.test.js`
Expected: FAIL, `Failed to load url ./cron-arm-health` (module does not exist).

- [ ] **Step 3: Write the module**

Create `src/lib/cron-arm-health.js`:

```js
// HEARTBEAT.1 — heartbeat rows for the cron ARMS that ride another cron's
// schedule, and when an arm's run is clean enough to stamp its own row.
//
// WHY. An arm that shares a parent cron shares its heartbeat row, and that row
// is stamped whatever the arm did. /api/cron/health-check reads only
// cron_health.is_stale (mig 053), never last_outcome, so an arm that throws on
// every run pages nobody: its failure is a field in a response nobody keeps.
// SWAPHB.1 (mig 623) fixed that for the swap cover arm of checklist-sweep; this
// does the same for:
//
//   'shift-reminders' — runShiftReminders (src/lib/shift-reminders.js), the
//                       shift arm of the */5 send-push-reminders cron.
//   'roster-runway'   — runRosterRunwayAlerts (src/lib/roster-runway-notify.js),
//                       the first arm of the daily 08:00 UTC contract-reminders cron.
//
// Both rows are seeded by mig 633 (stampHeartbeat is UPDATE-only).
//
// THE RULE. Stamp only when the arm RETURNED an outcome object (a throw, or a
// resolved non-object, has not shown it ran) and that outcome carries no
// fault in the arm's own machinery. A run with nothing to send is healthy (a
// quiet day, a quiet-hours tick, no locations): otherwise the shift row would
// go stale every night. A failed DELIVERY to one device is not an arm fault:
// both arms release that claim and retry it (next tick / next day), and the
// count rides in the row's last_outcome.

export const SHIFT_REMINDERS_HEARTBEAT = 'shift-reminders'
export const ROSTER_RUNWAY_HEARTBEAT = 'roster-runway'

// runShiftReminders' counters that mean the ARM went wrong, not a device:
//   shift_claim_failed — a ledger claim insert failed; that reminder was NOT sent.
//   shift_send_threw   — notifyUsers threw (documented never to); claim kept, reminder lost.
//   shift_read_capped  — the shift read hit the 1,000-row cap; reminders were missed.
// NOT here: shift_send_failed (nothing delivered, claim released, next tick retries).
export const SHIFT_ARM_FAULT_KEYS = Object.freeze(['shift_claim_failed', 'shift_send_threw', 'shift_read_capped'])

const isOutcome = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const count = (v) => (Number.isFinite(v) ? v : 0)

/** True when a runShiftReminders() summary shows a clean run (see the header). */
export function shiftReminderArmHealthy(summary) {
  if (!isOutcome(summary)) return false
  return SHIFT_ARM_FAULT_KEYS.every((key) => count(summary[key]) === 0)
}

/**
 * True when a runRosterRunwayAlerts() outcome shows a clean run. The arm throws
 * on every failure of its own (a locations or runway read), which the parent
 * cron records as { error }; `failed` is a per-recipient delivery count whose
 * claims are released for the next daily run, so it does not block the stamp.
 */
export function runwayArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  return !Object.prototype.hasOwnProperty.call(outcome, 'error')
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/cron-arm-health.test.js`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cron-arm-health.js src/lib/cron-arm-health.test.js
git commit -m "HEARTBEAT.1 — when a cron arm's run is clean enough to stamp its own heartbeat

Pure module: the 'shift-reminders' and 'roster-runway' row names and two
predicates. A run with nothing to send is healthy; a throw, a non-object, a
ledger/notify/cap fault in the shift arm or an { error } runway outcome is
not. Delivery failures (claims released, retried) ride in last_outcome.
Drift guards run the real arms down their zero-work paths.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: migration 633, replayed on PGlite

**Files:**
- Create: `supabase/migrations/633_shift_reminders_roster_runway_heartbeats.sql`
- Test: `tests/migration-633-arm-heartbeats.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/migration-633-arm-heartbeats.test.js`. (It uses PGlite's multi-statement SQL runner, `db.exec`. That is an in-process SQL call, not `child_process`, the same as `tests/migration-625-…`. If a security hook flags it, that is a false positive.)

```js
// HEARTBEAT.1 — behavioural test for migration 633.
//
// No local Supabase stack, so this boots an in-process Postgres (PGlite), runs
// the REAL mig 053 (cron_heartbeats + the cron_health view the health-check
// reads) and then 633, and proves:
//   * both rows exist under the names the routes stamp (read from the code,
//     so a typo on either side is a red test, not a silent 0-row stamp);
//   * the thresholds page when they should and not before (via cron_health);
//   * replay is a no-op that never overwrites a hand-tuned row;
//   * the self-check aborts the WHOLE file when a same-named row with the
//     wrong cadence already exists (DO NOTHING would otherwise keep it).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT } from '@/lib/cron-arm-health'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_633 = read('633_shift_reminders_roster_runway_heartbeats.sql')

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell and no
// child process), in one implicit transaction, as apply_migration runs a file.
const runSql = (text) => db.exec(text)

const row = async (name) => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0]

/** Put last_ok_at `seconds` in the past and ask the health view. */
const staleAfter = async (name, seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [name, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale
}

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;') // mig 053's policies name them
  await runSql(MIG_053)
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 633 seeds the two arm rows', () => {
  it('under the names the code stamps, with each arm\'s cadence, born healthy', async () => {
    await runSql(MIG_633)
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900 })
    expect(await row(ROSTER_RUNWAY_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 86400, grace_seconds: 43200 })
    const { rows } = await db.query(
      `SELECT name, is_stale FROM public.cron_health WHERE name = ANY($1) ORDER BY name`,
      [[SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT]],
    )
    expect(rows).toEqual([{ name: 'roster-runway', is_stale: false }, { name: 'shift-reminders', is_stale: false }])
    expect((await row(SHIFT_REMINDERS_HEARTBEAT)).notes).toMatch(/send-push-reminders/)
    expect((await row(ROSTER_RUNWAY_HEARTBEAT)).notes).toMatch(/contract-reminders/)
  })

  it('shift-reminders: two missed ticks (15 min) never page; 20 min without a clean run does', async () => {
    await runSql(MIG_633)
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 15 * 60 + 30)).toBe(false)
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 19 * 60)).toBe(false)
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 21 * 60)).toBe(true)
  })

  it('roster-runway: a slow day never pages; a missed daily run pages that evening (36h)', async () => {
    await runSql(MIG_633)
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 25 * 3600)).toBe(false)
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 35 * 3600)).toBe(false)
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 37 * 3600)).toBe(true)
  })

  it('touches no other row', async () => {
    const before = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats ORDER BY name`)).rows
    await runSql(MIG_633)
    const after = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name <> ALL($1) ORDER BY name`,
      [[SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT]])).rows
    expect(after).toEqual(before)
  })
})

describe('replay and the self-check', () => {
  it('replaying is a no-op: a hand-tuned grace and the last stamp survive', async () => {
    await runSql(MIG_633)
    await db.query(`UPDATE public.cron_heartbeats SET grace_seconds = 1200, last_ok_at = now() - interval '5 minutes' WHERE name = $1`, [SHIFT_REMINDERS_HEARTBEAT])
    const tuned = await row(SHIFT_REMINDERS_HEARTBEAT)
    await runSql(MIG_633)
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toEqual(tuned)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE name = ANY($1)`,
      [[SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT]])).rows[0].n).toBe(2)
  })

  it('a pre-existing row with the wrong cadence aborts the WHOLE file: nothing is applied', async () => {
    await db.query(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds) VALUES ($1, 60, 60)`, [SHIFT_REMINDERS_HEARTBEAT])
    await expect(runSql(MIG_633)).rejects.toThrow(/mig 633: cron_heartbeats row shift-reminders .*expected_interval_seconds 300/)
    expect(await row(ROSTER_RUNWAY_HEARTBEAT)).toBeUndefined()
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 60 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/migration-633-arm-heartbeats.test.js`
Expected: FAIL, `ENOENT … 633_shift_reminders_roster_runway_heartbeats.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/633_shift_reminders_roster_runway_heartbeats.sql`:

```sql
-- 633 — HEARTBEAT.1: heartbeat rows of their own for the shift-reminder arm
-- and the roster-runway arm.
--
-- WHY
-- ───
-- Both arms ride another cron's schedule and, until now, its heartbeat row:
--
--   * SHIFTREMIND.1 (#1730): runShiftReminders (src/lib/shift-reminders.js)
--     is the shift arm of the */5 Vercel cron /api/cron/send-push-reminders.
--     A throw is caught, reported as shift_arm_failed: 1 in the response, and
--     'send-push-reminders' is stamped anyway (with no outcome at all).
--   * RUNWAY.1 (#1734): runRosterRunwayAlerts (src/lib/roster-runway-notify.js)
--     is the first arm of the daily 08:00 UTC cron /api/cron/contract-reminders.
--     A throw is caught, written into 'contract-reminders'.last_outcome.runway,
--     and that row is stamped anyway.
--
-- /api/cron/health-check reads only cron_health.is_stale (mig 053), never
-- last_outcome, so either arm failing on EVERY run paged nobody. Same class as
-- the swap cover arm (SWAPHB.1, mig 623) and the 24-day silent enrolment
-- outage (#1685).
--
-- The routes now stamp these rows ONLY when the arm returned an outcome with
-- no fault of its own (src/lib/cron-arm-health.js). A run with nothing to send
-- is healthy and stamps: a quiet day, a quiet-hours tick, no locations.
-- stampHeartbeat() is UPDATE-only, so without these rows the new stamps are
-- logged no-ops:
--
--   APPLY THIS MIGRATION BEFORE THE CODE DEPLOYS.
--
-- The health-check needs no change: cron_health is an unfiltered SELECT over
-- cron_heartbeats, so a row is monitored the moment it exists.
--
-- CADENCE
-- ───────
-- shift-reminders: 300s interval (the parent's */5), 900s grace, so STALE 20
--   minutes after the last clean run. NOT the parent's 600 (mig 171): this
--   stamp is conditional, and after two transient bad ticks the next good one
--   lands at +15 min, exactly on a 300+600 boundary (SWAPHB.1's reasoning).
--   Two bad ticks never page; four in a row always do. The arm's quiet hours
--   (22:00-07:00) return normally and stamp, so the row does not go stale
--   overnight.
-- roster-runway: 86400s interval, 43200s grace: the daily convention of the
--   parent row (mig 445) and extend-roster-horizon (mig 601), "a missed day
--   plus half a day". The cron is 08:00 UTC all year (09:00 Dublin in summer,
--   08:00 in winter), so DST never moves the interval. One failed daily run
--   pages around 20:00 UTC that day; its next retry is 24 hours away.
--
-- BORN HEALTHY, ON CONFLICT DO NOTHING
-- ────────────────────────────────────
-- last_ok_at = now() so neither row can page before its first real stamp. That
-- is 20 minutes for shift-reminders: apply this only when the PR is ready to
-- merge. If the deploy is held up longer, re-arm by hand (do not replay):
--   UPDATE public.cron_heartbeats SET last_ok_at = now() WHERE name = 'shift-reminders';
-- DO NOTHING (like migs 053/171/445, unlike 601/623's DO UPDATE) so a replay
-- can never hide a row that has genuinely gone stale, nor undo a hand-tuned
-- grace. The self-check below refuses the one case DO NOTHING would otherwise
-- hide: a same-named row that already existed with another cadence.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'shift-reminders',
    now(),
    300,
    900,
    'HEARTBEAT.1 — the shift arm (src/lib/shift-reminders.js runShiftReminders, SHIFTREMIND.1) of the */5 Vercel cron /api/cron/send-push-reminders. No route or vercel.json entry of its own. Stamped ONLY when the arm returned a summary with shift_claim_failed, shift_send_threw and shift_read_capped all 0 (src/lib/cron-arm-health.js); a failed delivery (shift_send_failed, claim released, retried next tick) still stamps. Independent of the parent: a failing shift arm still stamps send-push-reminders. Quiet-hours ticks (22:00-07:00 studio time) stamp. STALE = the arm has thrown or reported a fault on every tick for 20 minutes: read this row''s last_outcome and the shift-reminders / cron-push-reminders logError lines. last_outcome carries the arm''s counters { quiet_hours, shift_candidates, shift_pushed, shift_emailed, shift_skipped_dup, shift_skipped_no_recipient, shift_send_failed, shift_send_threw, shift_claim_failed, shift_read_capped }.'
  ),
  (
    'roster-runway',
    now(),
    86400,
    43200,
    'HEARTBEAT.1 — the roster-runway arm (src/lib/roster-runway-notify.js runRosterRunwayAlerts, RUNWAY.1) of the daily 08:00 UTC Vercel cron /api/cron/contract-reminders. No route or vercel.json entry of its own. Stamped right after the arm, before the contract half runs, ONLY when it returned an outcome and did not throw (a locations or runway read failure); a per-recipient delivery failure (outcome.failed, claim released for the next day) still stamps. Independent of the parent: a failing runway arm still stamps contract-reminders, and a crashing contract half does not cost this row its stamp. STALE = no clean run for 36 hours: read contract-reminders.last_outcome.runway (the error text) and the cron-contract-reminders logError lines. last_outcome carries { locations, alerts, quiet_hours, sent, emailed, deduped, failed }.'
  )
ON CONFLICT (name) DO NOTHING;

-- Self-check: both rows exist with the cadence the routes stamp on. A
-- same-named row that predates 633 with another interval would have been kept
-- by DO NOTHING and would page on the wrong clock: refuse it, which aborts the
-- whole file (nothing above is applied).
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN SELECT * FROM (VALUES ('shift-reminders', 300), ('roster-runway', 86400)) AS v(name, interval_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name AND h.expected_interval_seconds = e.interval_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 633: cron_heartbeats row % is missing or does not have expected_interval_seconds % (a row by that name predates 633 with another cadence; fix or remove it, then re-apply)', e.name, e.interval_s;
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/migration-633-arm-heartbeats.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check the self-check**

Temporarily change `('shift-reminders', 300)` in the DO block to `('shift-reminders', 301)` and re-run. Every test in the file should now fail at `runSql(MIG_633)` with `mig 633: … shift-reminders`, which proves the check is live. Revert, then re-run (green).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/633_shift_reminders_roster_runway_heartbeats.sql tests/migration-633-arm-heartbeats.test.js
git commit -m "HEARTBEAT.1 — mig 633: heartbeat rows for the shift-reminder and roster-runway arms

shift-reminders 300+900 (stale 20 min after the last clean run: two bad
ticks never page, four always do); roster-runway 86400+43200 (the daily
convention of migs 445/601). Born healthy, ON CONFLICT DO NOTHING, and a
self-check that aborts the file if a same-named row predates it with another
cadence. PGlite replay of the real mig 053 + 633 pins thresholds, replay and
the abort. APPLY BEFORE THE CODE DEPLOYS (stampHeartbeat is UPDATE-only).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `send-push-reminders` stamps `shift-reminders` when the shift arm ran clean

**Files:**
- Modify: `src/app/api/cron/send-push-reminders/route.js` (imports near line 44; the SHIFTS block at 379-395)
- Test: `src/app/api/cron/send-push-reminders/route.test.js`

- [ ] **Step 1: Write the failing tests**

In `src/app/api/cron/send-push-reminders/route.test.js`:

(a) Replace `makeBuilder` and the `throwOnTables` block (lines 10-23) with a version that can fail the locations read:

```js
let locationsError = null
function makeBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'order', 'range']) b[m] = () => b
  b.then = (resolve, reject) => Promise.resolve(
    table === 'locations'
      ? { data: locationsError ? null : LOCATIONS, error: locationsError }
      : { data: [], error: null },
  ).then(resolve, reject)
  return b
}
let throwOnTables = []
const fakeDb = {
  from: (table) => {
    if (throwOnTables.includes(table)) throw new Error(`${table} is down`)
    return makeBuilder(table)
  },
}
```

(b) Change line 34 to `const { logError, logInfo, logWarn } = await import('@/lib/log')`. Below `req`, add:

```js
// HEARTBEAT.1 — the heartbeat rows this tick stamped, in call order.
const stampedNames = () => stampHeartbeat.mock.calls.map((c) => c[0])
```

(c) In `beforeEach`, after `throwOnTables = []`, add:

```js
  locationsError = null
  stampHeartbeat.mockImplementation(async () => {})
```

(d) Append at the end of the file:

```js
// HEARTBEAT.1 — the shift arm has a heartbeat row of its own ('shift-reminders',
// mig 633). 'send-push-reminders' is stamped whatever the shift arm did and the
// health-check reads only is_stale, so an arm that threw on every tick paged
// nobody. The row is stamped ONLY when the arm returned a summary with no
// fault of its own (src/lib/cron-arm-health.js), with the arm's counters.
const CLEAN = {
  quiet_hours: 0, shift_candidates: 2, shift_pushed: 1, shift_emailed: 0, shift_skipped_dup: 1,
  shift_skipped_no_recipient: 0, shift_send_failed: 0, shift_send_threw: 0, shift_claim_failed: 0, shift_read_capped: 0,
}

describe('GET /api/cron/send-push-reminders — shift-reminders heartbeat', () => {
  // The parent's stamp is unchanged by HEARTBEAT.1: once per tick, no outcome.
  const expectParentStampUnchanged = () =>
    expect(stampHeartbeat.mock.calls.filter((c) => c[0] === 'send-push-reminders')).toEqual([['send-push-reminders']])

  it('a clean arm: shift-reminders is stamped with the arm\'s own counters, then send-push-reminders as before', async () => {
    runShiftReminders.mockResolvedValue(CLEAN)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['shift-reminders', 'send-push-reminders'])
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', CLEAN)
    expectParentStampUnchanged()
  })

  it('a tick with nothing to send stamps: a quiet day is healthy', async () => {
    const idle = { ...CLEAN, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 }
    runShiftReminders.mockResolvedValue(idle)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', idle)
  })

  it('a quiet-hours tick stamps, so the row cannot go stale overnight', async () => {
    const quiet = { ...CLEAN, quiet_hours: 1, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 }
    runShiftReminders.mockResolvedValue(quiet)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', quiet)
  })

  it('a failed delivery (claim released, retried next tick) still stamps, and the count reaches last_outcome', async () => {
    runShiftReminders.mockResolvedValue({ ...CLEAN, shift_send_failed: 1 })
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', expect.objectContaining({ shift_send_failed: 1 }))
  })

  it('the arm THROWS: shift-reminders is NOT stamped; the parent is, unchanged, and the tick is still a 200', async () => {
    runShiftReminders.mockRejectedValue(new Error('shift read failed: column does not exist'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, shift_arm_failed: 1 })
    expect(stampedNames()).toEqual(['send-push-reminders'])
    expectParentStampUnchanged()
  })

  it.each(['shift_claim_failed', 'shift_send_threw', 'shift_read_capped'])('the arm reports %s: shift-reminders NOT stamped, parent unchanged', async (key) => {
    runShiftReminders.mockResolvedValue({ ...CLEAN, [key]: 1 })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['send-push-reminders'])
    expectParentStampUnchanged()
  })

  it('an arm that resolves with nothing has not shown it ran: not stamped', async () => {
    runShiftReminders.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['send-push-reminders'])
  })

  it('a failed locations read is a 500 that stamps NEITHER row (unchanged: the arm never ran)', async () => {
    locationsError = { message: 'locations down' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(runShiftReminders).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a rejecting shift-reminders stamp cannot cost the parent its stamp or its 200', async () => {
    runShiftReminders.mockResolvedValue(CLEAN)
    stampHeartbeat.mockImplementation((name) =>
      name === 'shift-reminders' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['shift-reminders', 'send-push-reminders'])
    expect(logWarn).toHaveBeenCalledWith('cron-push-reminders', 'shift-reminders heartbeat failed', expect.anything())
  })
})
```

- [ ] **Step 2: Run them and watch the new ones fail**

Run: `npx vitest run src/app/api/cron/send-push-reminders/route.test.js`
Expected: the nine original tests PASS. The new "clean", "nothing to send", "quiet-hours", "failed delivery" and "rejecting stamp" tests FAIL (`shift-reminders` is never stamped). The throw, fault-key, `undefined` and 500 tests pass already, because they assert the stamp is absent. That is correct, and Step 5's mutation check is what gives them teeth.

- [ ] **Step 3: Wire the stamp**

In `src/app/api/cron/send-push-reminders/route.js`:

(a) Add after line 44 (`import { runShiftReminders } …`):

```js
import { SHIFT_REMINDERS_HEARTBEAT, shiftReminderArmHealthy } from '@/lib/cron-arm-health'
```

(b) Replace the whole SHIFTS block (lines 379-395) with:

```js
  // -------------------------- SHIFTS --------------------------
  // SHIFTREMIND.1 — one reminder per RUN of a coach's published shifts (shifts
  // no more than 2 hours apart): 2 hours before the run's first start, or
  // 20:00 the evening before when that would be before 07:00 (a start before 09:00).
  // The rule, the ledger use and the failure posture live in
  // src/lib/shift-reminders.js. Isolated like the two blocks above: a shift
  // failure must never cost a task or booking reminder, or the heartbeat.
  let shiftSummary = null
  try {
    shiftSummary = await runShiftReminders(db, { nowMs, locations: locations || [] })
    Object.assign(summary, shiftSummary)
  } catch (err) {
    // VISIBLE, not just logged: the send-push-reminders heartbeat below is
    // stamped either way and the response is ok:true, so without this key an
    // arm that throws on every tick (a select 400, say) would look exactly
    // like a quiet day in the response. Same class as the 24-day silent
    // enrolment outage (#1685).
    summary.shift_arm_failed = 1
    logError('cron-push-reminders', 'shift block threw', { err })
  }

  // HEARTBEAT.1 — the shift arm's OWN heartbeat row ('shift-reminders', mig
  // 633). The health-check reads only is_stale, so the key above pages nobody;
  // this row does. Stamped ONLY when the arm returned a summary with no fault of
  // its own (src/lib/cron-arm-health.js): a quiet-hours tick or a tick with
  // nothing due stamps, a throw / claim failure / notify throw / capped read
  // does not, so an arm broken for 20 minutes goes STALE. Its own catch: this
  // stamp can never cost the parent's stamp below or the response.
  if (summary.shift_arm_failed === 0 && shiftReminderArmHealthy(shiftSummary)) {
    await stampHeartbeat(SHIFT_REMINDERS_HEARTBEAT, shiftSummary).catch((err) =>
      logWarn('cron-push-reminders', 'shift-reminders heartbeat failed', { err }))
  }
```

(c) In the header comment, after lines 25-27 (`- Shifts (published, … src/lib/shift-reminders.js.`), add:

```js
//     The shift arm has its own heartbeat row, 'shift-reminders' (HEARTBEAT.1,
//     mig 633), stamped only when it ran clean; 'send-push-reminders' still
//     means "the tick ran".
```

Leave the parent stamp at lines 402-403 (`stampHeartbeat('send-push-reminders')`) exactly as it is.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/app/api/cron/send-push-reminders/route.test.js src/lib/cron-arm-health.test.js`
Expected: PASS, all of them, including the nine original tests.

- [ ] **Step 5: Mutation-check each guard**

Make each change, run the route test file, see the named tests fail, revert:
1. Replace the condition with `if (true)`. Expected: the throw test fails (it now stamps `shiftSummary = null`), plus the three `it.each` fault tests and the `undefined` test.
2. Replace `shiftReminderArmHealthy(shiftSummary)` with `shiftSummary`. Expected: the three `it.each` fault tests fail.
3. Remove `.catch(...)` from the new stamp. Expected: "a rejecting shift-reminders stamp" fails (the route rejects).

Re-run after reverting: green.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/send-push-reminders/route.js src/app/api/cron/send-push-reminders/route.test.js
git commit -m "HEARTBEAT.1 — a shift-reminder arm that keeps failing now pages: 'shift-reminders' is stamped only on a clean run

The */5 send-push-reminders cron stamped its row whatever the shift arm did,
and the health-check reads only is_stale, so shift_arm_failed: 1 on every
tick paged nobody. The route now stamps 'shift-reminders' (mig 633) with the
arm's own counters when it returned a summary with no claim/notify/cap
fault: quiet-hours and nothing-due ticks stamp, a throw does not. Its own
catch; the send-push-reminders stamp is unchanged (once per tick, no
outcome) and a failed locations read still stamps neither.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `contract-reminders` stamps `roster-runway` right after the runway arm

**Files:**
- Modify: `src/app/api/cron/contract-reminders/route.js` (imports near line 29; after the arm at 60-68; header line 21)
- Test: `src/app/api/cron/contract-reminders/route.test.js`

- [ ] **Step 1: Write the failing tests**

In `src/app/api/cron/contract-reminders/route.test.js`:

(a) Change line 28 to `const { logError, logWarn } = await import('@/lib/log')`. Below `const OUTCOME = …` (line 34), add:

```js
// HEARTBEAT.1 — the heartbeat rows this run stamped, in call order.
const stampedNames = () => stampHeartbeat.mock.calls.map((c) => c[0])
```

(b) In `beforeEach`, after `vi.clearAllMocks()`, add:

```js
  stampHeartbeat.mockImplementation(async () => {})
```

(c) The existing "and vice versa" test (lines 83-90) asserts `expect(stampHeartbeat).not.toHaveBeenCalled()`. Replace those two lines (88-89) with:

```js
    // Unchanged from before RUNWAY.1: a crashed contract run does not stamp
    // 'contract-reminders'. HEARTBEAT.1: the runway arm had already run clean
    // and stamped its own row, so a contract crash never reads as a runway one.
    expect(stampedNames()).toEqual(['roster-runway'])
```

(d) Append at the end of the file:

```js
// HEARTBEAT.1 — the runway arm has a heartbeat row of its own ('roster-runway',
// mig 633). 'contract-reminders' is stamped whatever the arm did and the
// health-check reads only is_stale, so runway_arm_failed: 1 every day paged
// nobody. The row is stamped right after the arm (before the contract half can
// crash) and ONLY when it returned an outcome and did not throw.
describe('GET /api/cron/contract-reminders — roster-runway heartbeat', () => {
  it('a clean arm: roster-runway is stamped with the arm\'s outcome BEFORE the contract half runs, then contract-reminders as before', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    let stampedBeforeContracts = null
    reminderDue.mockImplementation(() => { stampedBeforeContracts ??= stampedNames().slice(); return false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedBeforeContracts).toEqual(['roster-runway'])
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', OUTCOME)
  })

  it('a day with nothing to announce stamps: a quiet day is healthy', async () => {
    const idle = { locations: 3, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 }
    runRosterRunwayAlerts.mockResolvedValue(idle)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', idle)
  })

  it('alerts held back by quiet hours still stamp (the arm ran; the next in-band run sends)', async () => {
    const held = { ...OUTCOME, quiet_hours: 1, sent: 0 }
    runRosterRunwayAlerts.mockResolvedValue(held)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', held)
  })

  it('a delivery failure inside a completed run still stamps (claim released for tomorrow; failed rides in last_outcome)', async () => {
    runRosterRunwayAlerts.mockResolvedValue({ ...OUTCOME, failed: 1 })
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('roster-runway', expect.objectContaining({ failed: 1 }))
  })

  it('the arm THROWS: roster-runway is NOT stamped; contract-reminders is, exactly as before', async () => {
    runRosterRunwayAlerts.mockRejectedValue(new Error('runway read failed: blocks down'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['contract-reminders'])
    expect(stampHeartbeat).toHaveBeenCalledWith('contract-reminders', {
      checked: 0, sent: 0, emailFailed: 0, rowErrors: 0, runway: { error: 'runway read failed: blocks down' }, runway_arm_failed: 1,
    })
  })

  it('an arm that resolves with nothing has not shown it ran: not stamped', async () => {
    runRosterRunwayAlerts.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders'])
  })

  it('an arm that resolves with an { error } outcome is not stamped', async () => {
    runRosterRunwayAlerts.mockResolvedValue({ error: 'something' })
    await GET(req())
    expect(stampedNames()).toEqual(['contract-reminders'])
  })

  it('a rejecting roster-runway stamp cannot cost the contract half its run, its stamp or its 200', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    stampHeartbeat.mockImplementation((name) =>
      name === 'roster-runway' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(reminderDue).toHaveBeenCalledTimes(1)
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
    expect(logWarn).toHaveBeenCalledWith('cron-contract-reminders', 'roster-runway heartbeat failed', expect.anything())
  })
})
```

- [ ] **Step 2: Run them and watch the new ones fail**

Run: `npx vitest run src/app/api/cron/contract-reminders/route.test.js`
Expected: the four untouched original tests PASS. The updated "vice versa" test FAILS (`[]` ≠ `['roster-runway']`). So do "clean arm", "nothing to announce", "quiet hours", "delivery failure" and "rejecting stamp". The throw, `undefined` and `{ error }` tests pass already, for the same reason as in Task 3.

- [ ] **Step 3: Wire the stamp**

In `src/app/api/cron/contract-reminders/route.js`:

(a) Add after line 29 (`import { runRosterRunwayAlerts } …`):

```js
import { ROSTER_RUNWAY_HEARTBEAT, runwayArmHealthy } from '@/lib/cron-arm-health'
```

(b) Replace line 21 (`// RUNWAY.1 — also runs the daily roster-runway push (second arm, top of GET).`) with:

```js
// RUNWAY.1 — also runs the daily roster-runway push (second arm, top of GET).
// HEARTBEAT.1 — that arm stamps its own heartbeat row, 'roster-runway' (mig
// 633), only when it ran clean; 'contract-reminders' is unchanged.
```

(c) Directly after the runway `try/catch` (after line 68, before `// Candidate contracts …`), insert:

```js

  // HEARTBEAT.1 — the runway arm's OWN heartbeat row ('roster-runway', mig
  // 633). runway_arm_failed rides in the contract-reminders row's last_outcome,
  // which the health-check never reads; this row goes STALE instead. Stamped
  // HERE, before the contract half, so a contract crash (which answers nothing
  // and stamps nothing, as always) cannot cost a clean runway run its stamp;
  // its own catch, so the stamp can never cost the contract half anything.
  // Only when the arm returned an outcome and did not throw
  // (src/lib/cron-arm-health.js): a day with nothing to announce stamps.
  if (runwayArmFailed === 0 && runwayArmHealthy(runway)) {
    await stampHeartbeat(ROSTER_RUNWAY_HEARTBEAT, runway).catch((err) =>
      logWarn('cron-contract-reminders', 'roster-runway heartbeat failed', { err }))
  }
```

Leave the parent stamp at lines 156-158 exactly as it is.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/app/api/cron/contract-reminders/route.test.js src/lib/cron-arm-health.test.js`
Expected: PASS, all of them.

- [ ] **Step 5: Mutation-check each guard**

1. Replace the condition with `if (true)`. Expected: the throw, `undefined` and `{ error }` tests fail.
2. Replace `runwayArmHealthy(runway)` with `runway`. Expected: the `{ error }` test fails. (A throw sets `runwayArmFailed = 1` and is still caught by the first half of the condition. The second half is the one that catches a resolved `{ error }`.)
3. Move the new block down to just before the parent stamp (line ~156). Expected: "clean arm … BEFORE the contract half" and the updated "vice versa" test fail.
4. Remove `.catch(...)`. Expected: "a rejecting roster-runway stamp" fails.

Revert each one and re-run (green).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/contract-reminders/route.js src/app/api/cron/contract-reminders/route.test.js
git commit -m "HEARTBEAT.1 — a roster-runway arm that keeps failing now pages: 'roster-runway' is stamped only on a clean run

The daily contract-reminders cron stamped its row whatever the runway arm
did (runway_arm_failed rode in last_outcome, which the health-check never
reads). The route now stamps 'roster-runway' (mig 633) with the arm's
outcome right after the arm, before the contract half, when it returned an
outcome and did not throw; a day with nothing to announce stamps. Own catch.
The contract-reminders stamp is unchanged, including 'no stamp when the
contract half crashes' (that test now also pins the runway stamp).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: one line in CLAUDE.md so the next arm gets its own row

**Files:**
- Modify: `CLAUDE.md` (the first bullet under **Crons & webhooks**)

- [ ] **Step 1: Append one sentence to the end of that bullet** (after `…confirmed by the CRON-HB-AUDIT.1 audit, mig 406).`):

```
 **An ARM that rides another cron's schedule gets its OWN row** (`swap-cover-sweep` mig 623, `shift-reminders` + `roster-runway` mig 633; names + predicates in `src/lib/cron-arm-health.js`): stamped only when the arm returned an outcome with no fault of its own, under its own `.catch`, placed so the other arm cannot crash it out of its stamp — the parent's `last_outcome` pages nobody, since the health-check reads only `is_stale`. A run with nothing to send is healthy and stamps.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "HEARTBEAT.1 — CLAUDE.md: a cron arm gets its own heartbeat row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: gate, apply migration 633, PR, changelog

- [ ] **Step 1: Focused tests**

```bash
npx vitest run src/lib/cron-arm-health.test.js tests/migration-633-arm-heartbeats.test.js \
  src/app/api/cron/send-push-reminders/route.test.js src/app/api/cron/contract-reminders/route.test.js \
  src/lib/shift-reminders.test.js src/lib/roster-runway-notify.test.js src/lib/cron-heartbeat.test.js
```

Expected: all green. The two arm test files are untouched and must stay green: the arms did not change.

- [ ] **Step 2: The full CI mirror (all twelve), once**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected:
- `check:select-columns`: green with no allowlist entry (no new `.select()`).
- `check:guardrails`: green. There is no new supabase write, and `stampHeartbeat` keeps its own `error` check.
- `check:route-guards`, `check:location-scoping`: unchanged. There is no new route, and `cron_heartbeats` is not a tenant table.
- `check:rls-restrictive`: unchanged. 633 is DML only, with no policy.
- `check:ota-paths`, `check:mobile-*`: unchanged. Nothing under `mobile/` or `shared/`.
- Invariant sweep: `grep -L stampHeartbeat src/app/api/cron/*/route.js` still lists only `health-check` and `ad-insights-backfill`.

- [ ] **Step 3: `npm run build`** (the change adds a new lib import to two routes).

- [ ] **Step 4: Push, open the PR** (do NOT merge yet):

```bash
git push -u origin HEAD
gh pr create --base main --title "HEARTBEAT.1 — the shift-reminder and roster-runway arms page when they keep failing: heartbeat rows of their own (mig 633, apply first)" --body-file /private/tmp/claude-501/<scratchpad>/heartbeat1-pr-body.md
```

PR body points (end the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`):
- **Why:** SHIFTREMIND.1's shift arm (on the `*/5` `send-push-reminders` cron) and RUNWAY.1's runway arm (on the daily 08:00 UTC `contract-reminders` cron) report failure only as `shift_arm_failed` / `runway_arm_failed` in a response, or in the parent row's `last_outcome`. Both parent rows are stamped whatever the arm did, and `/api/cron/health-check` reads only `cron_health.is_stale`, so an arm failing on every run paged nobody. This is the same fix as SWAPHB.1 (#1737).
- **Mig 633, APPLY BEFORE MERGING** (`stampHeartbeat` is UPDATE-only). Rows:
  - `shift-reminders` 300 + 900: stale 20 minutes after the last clean run. Two bad ticks never page, four always do.
  - `roster-runway` 86400 + 43200: the daily convention of migs 445/601. One failed run pages that evening.
  - Both are born healthy, `ON CONFLICT DO NOTHING`, with a self-check that aborts the file if a same-named row already exists with another cadence.
- **Stamp rule** (`src/lib/cron-arm-health.js`): stamp only when the arm returned an outcome object with no fault of its own.
  - Shift arm faults: `shift_claim_failed`, `shift_send_threw`, `shift_read_capped`.
  - Runway arm: a throw, recorded as `{ error }`.
  - Quiet-hours runs, nothing-due runs and no-locations runs stamp. A per-device delivery failure stamps too: its claim is released and retried, and the count rides in `last_outcome`.
- **Isolation:** each arm stamp has its own `.catch`. The runway stamp runs before the contract half, so a contract crash cannot cost it. Parent stamps are unchanged: `send-push-reminders` still stamps once per tick with no outcome, and a failed locations read still stamps neither row. `contract-reminders` payload is the same, and it still does not stamp when the contract half crashes.
- **New visibility:** `shift-reminders.last_outcome` now carries the shift arm's counters. Nothing in the database carried them before, because the parent stamps with no outcome.
- **Health-check and Sentinel need no change:** `cron_health` is an unfiltered view, and Sentinel turns whatever names the health-check marks stale into signals, with no registry (checked in `un1t-sentinel/src/checks/cron-health.js`).
- Nothing under `mobile/` or `shared/`, and no `vercel.json` change, so **no OTA**.

- [ ] **Step 5: Apply migration 633** (once the PR is green on its final rebase and ready to merge; merge authority per `00-INDEX.md`)

1. Confirm the project: Supabase MCP `list_projects` → `iyvtbjjxdggiadzwwvdj` (un1t-crm, NOT sentinel `tpttqakxmyxrwnqjepfm`).
2. **Pre-checks** (`execute_sql`, read-only):

```sql
-- Neither new name exists yet (expect 0 rows); the parents' cadence as documented.
SELECT name, last_ok_at, expected_interval_seconds, grace_seconds
  FROM public.cron_heartbeats
 WHERE name IN ('shift-reminders', 'roster-runway', 'send-push-reminders', 'contract-reminders')
 ORDER BY name;
-- expect: contract-reminders 86400/43200, send-push-reminders 300/600, and NO shift-reminders / roster-runway row.

-- Baseline stale list, so a pre-existing stale row is not blamed on 633.
SELECT name, stale_seconds, max_allowed_seconds FROM public.cron_health WHERE is_stale ORDER BY name;

-- Are the arms healthy right now? (The runway arm's last result is on the parent row.)
SELECT last_ok_at, last_outcome->'runway' AS runway, last_outcome->'runway_arm_failed' AS runway_arm_failed
  FROM public.cron_heartbeats WHERE name = 'contract-reminders';
```

   If `runway_arm_failed` is 1, the new row will go stale ~36h after it is born. That would be a true alarm, but say so in the PR before merging.

3. **Rollback record**: write `/private/tmp/claude-501/<scratchpad>/mig633-rollback.sql`:

```sql
-- mig 633 rollback: remove the two arm rows. After this the routes' arm stamps
-- match 0 rows and only log 'stamp matched 0 rows' (never fail the cron).
DELETE FROM public.cron_heartbeats WHERE name IN ('shift-reminders', 'roster-runway');
```

4. **Apply** with `apply_migration`, name `633_shift_reminders_roster_runway_heartbeats`, and the file's full SQL.
5. **Post-checks**:

```sql
SELECT name, expected_interval_seconds, grace_seconds, stale_seconds, max_allowed_seconds, is_stale
  FROM public.cron_health WHERE name IN ('shift-reminders', 'roster-runway') ORDER BY name;
-- expect: roster-runway 86400/43200/129600, shift-reminders 300/900/1200, both is_stale = false, stale_seconds ~0.
```

6. `get_advisors` (type `security`): expect nothing new. 633 is DML only on a table whose RLS is unchanged.
7. **Merge immediately.** The `shift-reminders` row has 20 minutes before it can page. If the deploy is not live within ~15 minutes, re-arm it by hand. Do not replay the file, because DO NOTHING would leave the row as it is:

```sql
UPDATE public.cron_heartbeats SET last_ok_at = now() WHERE name = 'shift-reminders';
```

8. **After the deploy** (wait at least 10 minutes):

```sql
SELECT name, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = 'shift-reminders';
-- expect: last_ok_at within the last 5 minutes; last_outcome = the shift counters
-- (quiet_hours: 1 between 22:00 and 07:00 Dublin).
```

   `roster-runway`'s first real stamp is the next 08:00 UTC run. Check it then: `last_outcome` should hold `{ locations, alerts, … }` and `last_ok_at` should be about 08:00 UTC.

- [ ] **Step 6: Changelog row**

Add ONE new row directly under the `| # / PR | Item | Notes |` / `|---|------|-------|` header of `docs/CHANGELOG.md`, keyed by the PR number `gh` printed. Never edit a pushed row (`merge=union` duplicates it).

```
| #<PR> | HEARTBEAT.1 — the shift-reminder and roster-runway arms page when they keep failing: heartbeat rows of their own | 2026-09-25. **Mig 633, apply BEFORE merging** (`stampHeartbeat` is UPDATE-only); born healthy, `ON CONFLICT DO NOTHING`, self-check aborts the file if a same-named row predates it with another cadence; if the deploy lags past ~15 min re-arm `shift-reminders` by hand (`UPDATE … SET last_ok_at = now()`), do not replay. Nothing under `mobile/` or `shared/`, no `vercel.json` change, so **no OTA**. Same fix as SWAPHB.1 (#1737) for the two other arms that ride another cron: SHIFTREMIND.1's shift arm (`*/5` `send-push-reminders`) and RUNWAY.1's runway arm (daily 08:00 UTC `contract-reminders`) reported failure only as `shift_arm_failed` / `runway_arm_failed` in a response or the parent's `last_outcome`, while the parent row was stamped regardless and the health-check reads only `is_stale`. Rows: `shift-reminders` 300+900 (stale 20 min after the last clean run; two bad ticks never page, four always do; not the parent's 600 because a conditional stamp after two transient throws lands exactly on a 300+600 boundary), `roster-runway` 86400+43200 (migs 445/601's daily convention; one failed run pages that evening). Rule in `src/lib/cron-arm-health.js`: stamp only when the arm RETURNED an outcome object with no fault of its own (shift: `shift_claim_failed`/`shift_send_threw`/`shift_read_capped` all 0; runway: no throw / `{ error }`). Quiet-hours, nothing-due and no-location runs stamp; a per-device delivery failure stamps (claim released and retried; the count rides in `last_outcome`). Each arm stamp has its own `.catch`; the runway stamp runs before the contract half so a contract crash cannot cost it. Parent stamps unchanged (`send-push-reminders` once per tick, no outcome; `contract-reminders` same payload, still unstamped when the contract half crashes). New: `shift-reminders.last_outcome` carries the shift counters (the parent never stored them). Health-check and Sentinel need no change (unfiltered `cron_health`; Sentinel has no name registry, checked). Tests: predicate table + drift guards on the real arms' zero-work outcomes; PGlite replay of the real mig 053 + 633 (thresholds via `cron_health`, replay no-op, whole-file abort); route wiring both ways, every guard mutation-checked. CLAUDE.md: an arm gets its own row. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "HEARTBEAT.1 — changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### PR gate (summary)

1. Focused tests (Task 6 Step 1) green.
2. The twelve-command CI mirror (Task 6 Step 2) green.
3. `npm run build` green.
4. Independent review approved.
5. CI green on the final rebase (`docs/CHANGELOG.md` is the only expected conflict; AVAIL.1 is the batch-3 neighbour and owns mig 630).
6. Mig 633 applied with its pre/post checks (Task 6 Step 5), **then** merge.

---

### Review notes / open questions

1. **`ON CONFLICT DO NOTHING` vs the `DO UPDATE` re-arm of 601/623.** The brief asked for DO NOTHING, and migs 053/171/445 use it. SWAPHB.1 (623) and ROSTER-FIX.5 (601) instead re-arm `last_ok_at` and rewrite the thresholds on replay, so "re-run the file" doubled as the fix for a delayed deploy.
   - With DO NOTHING, a replay never hides a genuinely stale row and never undoes a hand-tuned grace.
   - The cost is a hand `UPDATE … SET last_ok_at = now()` if the deploy lags (Task 6 Step 5.7). The margin is tight for `shift-reminders`: 20 minutes of born-healthy.
   - The self-check closes the one hole DO NOTHING opens (a same-named row with another cadence). If Richard prefers 623's shape, it is a three-line swap, and the replay test would change to "re-arms and rewrites".
2. **Two calls on what counts as the arm failing:**
   - The shift arm's `shift_send_failed` does NOT block the stamp: one coach's dead token or bounced fallback email would otherwise keep the row stale for hours and page ops about one device.
   - The runway arm's `failed` does NOT block the stamp either: it is a per-recipient Expo count whose claims are released for tomorrow.
   - Consequence: a total Expo outage alone does not stale these rows, although it shows in `last_outcome`. If a total outage should page from here, gate on "`failed > 0` and nothing delivered this run" (`shift_pushed + shift_emailed === 0`, `sent + emailed === 0`). That is one clause each in `src/lib/cron-arm-health.js`, plus the tests.
3. **Thresholds, the numbers to argue with:**
   - `shift-reminders`: 900s grace pages about 20 minutes after the last clean run. The swap arm's 1800 is for a `*/15` cron, and its page time scales the same way (3-4 ticks).
   - `roster-runway`: 43200 means one failed daily run pages that evening (about 20:00 UTC). A shorter grace would page within hours of an 08:00 failure, but a slow deploy window could then cry wolf.
4. **Out of scope, seen while reading (follow-ups, not in this PR):**
   - `resolveRoleRecipientIds` (`src/lib/push.js:364-381`) discards its read error, so a failed `profile_locations` read reads as "nobody to notify". The runway arm then records `sent: 0, failed: 0`, a clean-looking run, and this heartbeat stamps. That is the discarded-error class, and it affects every role fan-out push, not just runway. It belongs in its own PR: judge the error and throw, which the runway arm already turns into `{ error }`, so this heartbeat would then catch it.
   - `src/lib/cron-heartbeat.js`'s docstring still says rows are "seeded via mig 053 for the three current crons".
5. **Double page when a parent cron stops entirely** (e.g. removed from `vercel.json`): the parent row and the arm row both go stale. This is accepted. Sentinel fingerprints per name (`cron.stale.<name>`), so it shows as two signals, and the arm's signal says which feature is dark.
6. **No Sentinel registration is owed.** The #1737 changelog row said "possibly owed". Checked: `un1t-sentinel/src/checks/cron-health.js` builds its signals from the health-check's `stale` name list, and nothing in that repo lists heartbeat names.
