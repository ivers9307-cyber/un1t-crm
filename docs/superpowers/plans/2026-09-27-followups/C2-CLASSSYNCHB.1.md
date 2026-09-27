## PR CLASSSYNCHB.1 — four heartbeat rows back on their real cron cadence (class sync every 15 min, ad sync every 4 h, two drains every 2 min)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dead `sync-class-occurrences` cron pages within 35 minutes, not after 26 hours. The same fix goes to the three other `cron_heartbeats` rows whose cadence drifted from `vercel.json` the same way.

**Architecture:** This is a migration-only PR. Migration 644 upserts four `cron_heartbeats` rows with `ON CONFLICT DO UPDATE`. It rewrites `expected_interval_seconds`, `grace_seconds` and `notes`, and **leaves `last_ok_at` alone**, so a row that is genuinely late stays late. A post-state self-check aborts the whole file if any row does not end up on the intended numbers. Two tests pin it:
- a PGlite replay that rebuilds the live drift from the real migrations, then applies 644;
- a `vercel.json` pin test, which fails the next PR that changes one of these four schedules without re-sizing its row.

No route, lib, `mobile/` or `shared/` file changes.

**Tech Stack:** Supabase Postgres (`cron_heartbeats` / `cron_health`, mig 053), Vitest, PGlite (`@electric-sql/pglite` ^0.3.16, already a devDependency).

**Ships:** **migration 644**. 643 is reserved for B2 CONTRACTVIS.1. **Re-check at build time** that 644 is still free: run `git ls-tree --name-only origin/main supabase/migrations/ | sort -V | tail -5`, and check that no other open follow-up plan in this folder claims it. Rename if it is taken. The migration has no code dependency: every row it touches is already stamped by a deployed route, so it can go on **any time**. Per the standing rules, apply it once the PR is green, then merge. It is a web deploy with nothing under `mobile/` or `shared/`, so **no OTA**.

**Worktree:** branch `classsynchb-1` off a fresh `origin/main`, in its own fresh worktree:

```bash
git -C ~/code/un1t-crm-wave23plan fetch origin main
git -C ~/code/un1t-crm-wave23plan worktree add ~/code/un1t-crm-classsynchb -b classsynchb-1 origin/main
cd ~/code/un1t-crm-classsynchb && npm ci
```

For tests use `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the gate (8GB machine).

---

### What was found (checked against `origin/main` at `28d02e59` and the live DB, 27 Sep 2026 ~21:40 UTC)

**Why `sync-class-occurrences` is 86,400 + 7,200.** Every `sync-class-occurrences` mention in `supabase/migrations` (from `git grep`):

| When | Commit / mig | `vercel.json` schedule | Heartbeat row |
|---|---|---|---|
| 17 Jun | #573, mig 284 (`284_class_climate.sql:87-90`) | `*/15 * * * *` | seeded 900 + 900 |
| 17 Jun | #576, mig 285 (`285_class_occurrences_sync_hourly.sql:7-10`) | `0 * * * *` | UPDATE → 3600 + 1800 |
| 17 Jun | #577, mig 286 (`286_class_occurrences_sync_daily.sql:8-11`), "applied to prod" | `0 4 * * *` | UPDATE → **86400 + 7200** |
| 2 Jul | `1345e7a3` HR-WAVE1 P0-8 ("Restore */15 sync cadence": cancelled classes stayed in the spine and the AC fired for them) | back to `*/15 * * * *` | **no migration: the row stayed at 86400 + 7200** |
| 17 Jul | mig 406 header (`406_seed_missing_cron_heartbeats_audit.sql:20`) | | lists "`*/15` → 900 + 900 (… sync-class-occurrences mig 284)" as a *convention*. That audit read the migration text, not the live row, so it missed 286. |

So a `vercel.json` schedule change reverted the cadence and nobody re-sized the row. Nothing else holds the interval: `git grep expected_interval_seconds` over `src tests scripts shared mobile` finds only:
- the health-check (through the `cron_health` view);
- `src/app/api/accounting/health/route.js:77-89`, which reads the bank-rec rows only;
- `src/lib/tenant-heartbeat.js:33-45`, which copies a parent row's cadence, but only for `glofox-sync` and `glofox-data-quality`;
- the migration tests.

The live row is the only source.

**How the class-sync route stamps** (`src/app/api/cron/sync-class-occurrences/route.js`):
- `:25-29`: a failed `locations` read returns 500 with **no stamp**.
- `:37-47`: each Glofox-connected location is synced. A failed sync (`out.ok === false`: Glofox fetch non-2xx, or the upsert failed, in `src/lib/class-occurrences.js:227-229, 256-262`) only bumps `stats.errors` and calls `logWarn`.
- `:49-50`: `stampHeartbeat('sync-class-occurrences')` runs **unconditionally** after the loop, with no outcome.

So the row is stamped on quiet ticks, on no-op ticks, and on **Glofox-down ticks**. It goes stale only when the cron is not invoked, the locations read fails, or something throws (for example `glofoxCredentialsForLocation`, or a `maxDuration = 60` timeout). **A Glofox outage overnight cannot page from this row**, so the brief's "900 + 2700 in case it stamps only on success" is not needed. The flip side is that this row means "the tick ran", not "the spine is fresh" (Open question 3).

**The live table against `vercel.json`** (all 83 rows read live, compared with all 79 `vercel.json` entries):

| Row | `vercel.json` (line) | Live interval + grace | How it drifted | Effect today | In 644? |
|---|---|---|---|---|---|
| `sync-class-occurrences` | `*/15 * * * *` (:140-141) | 86400 + 7200 | above | dead sync unnoticed for **26 h**; the spine holds 48 h | **yes → 900 + 1200** |
| `ad-insights-sync` | `0 */4 * * *` (:186) | 86400 + 21600 | mig 360 (3 Jul) seeded "Daily Meta ads insight sync" for `0 5 * * *`. `10770775` "ADS-REPORT — sync every 4h" (4 Jul) changed only `vercel.json` | dead sync unnoticed for **30 h** | **yes → 14400 + 18000** |
| `process-class-bookings` | `*/2 * * * *` (:183) | 60 + 120 | mig 335 seeded it for `* * * * *`. #894 `d82954ca` (11 Jul, "cut … fluid-compute cost") moved it to `*/2` with no migration | stale after 180 s, so **one missed tick (240 s gap) pages** | **yes → 120 + 240** |
| `process-contact-imports` | `*/2 * * * *` (:28-29) | 60 + 120 | mig 097 (60 + 30, "Vercel cron * * * * *"), grace raised to 120 by mig 119 "to absorb Vercel cron tick jitter". Same #894 move | same: **one missed tick pages**, and the notes say "every minute" | **yes → 120 + 240** |
| `run-campaigns` | `*/2 * * * *` | 60 + 300 | #894, no migration | the interval label is wrong, but the 6-minute window is the same as 120 + 240 | no (Open question 4) |
| `send-host-campaigns` | `*/2 * * * *` | 300 + 60 | seeded like that (mig 401) | label only; 6-minute window | no (OQ 4) |
| `process-receipt-hunts` | `*/5 * * * *` | 600 + 1200 | seeded like that (mig 370), its notes say "Every 5 min" | lax: 30 min to stale | no (OQ 4) |
| `wallet-monthly-reset` | `10 5 * * *` (daily) | 2678400 + 259200 | deliberate (mig 420: a daily cron that gates itself and acts at month boundaries) | dead cron unnoticed for 34 days, but missed days heal themselves | no (OQ 4) |
| `receipt-coverage-weekly` | **two** entries, `0 7 * * 5` and `0 8 * * 5` | 604800 + 86400 | duplicate schedule | **stale live** since 4 Sep (known, bank rec deprioritised) | no (OQ 5) |

Every other row matches its schedule. Some have tight graces where one missed tick already pages: `run-strava-exports` 120 + 90, `race-timing-events` 900 + 240, `run-whatsapp-broadcasts` 900 + 300, and the `*/5` rows at 300 + 180. Those graces are a choice made when the row was seeded, not drift (Open question 4). **Stale live right now:** `instagram-feed-sync` (last stamp 26 Sep 12:00 UTC, 33.7 h against an 8 h allowance) and `receipt-coverage-weekly`. Both were stale before this PR and neither is a cadence mismatch (Open question 5).

**Decisions pinned by tests:**

1. **One rule for every folded row: a single missed invocation never pages, and two in a row do.** The gap between two stamps is the interval plus Vercel's invocation jitter plus the run time. Stamps land 5–40 s after the minute live: `sync-class-occurrences` at `21:30:25`, `process-class-bookings` at `21:38:33`. Mig 119 raised a grace "to absorb Vercel cron tick jitter" for exactly this reason. So the grace must clear one missed tick with room to spare:
   - `sync-class-occurrences` **900 + 1200** (stale at 35 min). One missed tick gives a gap of about 1800 s plus up to 60 s of `maxDuration`, which is under 2100. Two missed ticks (2700 s) page.
   - **Why not the index's 900 + 900:** one missed tick lands exactly on 1800, and the stamp comes at the *end* of a run of up to 60 s, so a single Vercel skip would page. Mig 633 rejected 300 + 600 for the same "sits exactly on the boundary" reason. The spine holds 48 h, so 30 against 35 minutes costs nothing.
   - `ad-insights-sync` **14400 + 18000** (stale at 9 h). One missed run is 28800 s plus up to 300 s of `maxDuration`. Two missed runs (43200 s) page.
   - `process-class-bookings`, `process-contact-imports` **120 + 240** (stale at 6 min). This is exactly the `*/2` drain convention of `process-invoice-analysis` (mig 377). One missed tick (about 240–300 s) never pages. Two usually do, and three always do.
2. **`ON CONFLICT DO UPDATE` of interval, grace and notes only. `last_ok_at` is never touched.** The rows already exist and are stamped by deployed code. Re-arming (the 601/623/639-642 shape) would hide a row that is genuinely late at apply time. Without it, a late row pages at once, which is true. The pre-check (Task 5) makes sure no row is late before applying, so a correct apply pages nothing. `last_outcome` is left alone too. A missing row (a fresh database) is inserted born healthy (`last_ok_at` takes its `DEFAULT now()`).
3. **A post-state self-check aborts the whole file.** Each of the four rows must end up on exactly `(interval, grace)`, or nothing is applied (mig 640/642 shape).
4. **The `vercel.json` schedules are pinned to the migration.** The new test fails when one of the four schedules changes without a new heartbeat migration. The same test checks that 644's SQL still carries the numbers the pin names. This is the recurrence guard: the class has now happened three times (P0-8, ADS-REPORT 4 Jul, #894).

**Rules that bite in this PR:**
- Migrations are forward-only. Apply via Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj`, never the sentinel project `tpttqakxmyxrwnqjepfm`, and run `get_advisors` (security) afterwards.
- `stampHeartbeat` is UPDATE-only (`src/lib/cron-heartbeat.js:32-44`). All four rows exist live, so there is no ordering constraint with code.
- **Never EDIT a pushed CHANGELOG row** (`merge=union` duplicates it).

---

### File map

| File | Change |
|---|---|
| `supabase/migrations/644_cron_heartbeat_cadence.sql` | **new**: four-row upsert (interval, grace, notes; never `last_ok_at`), post-state self-check |
| `tests/migration-644-cron-heartbeat-cadence.test.js` | **new**: PGlite. Real migs 053, 119, 285, 286, 360, plus the exact seed statements of 097/284/335, rebuild the live drift. Then 644: thresholds through `cron_health`, no re-arm, a late row stays late, replay, fresh-database seed, whole-file abort |
| `tests/cron-heartbeat-schedule-pins.test.js` | **new**: the four `vercel.json` schedules equal what 644 sized, and 644's SQL carries those numbers |
| `CLAUDE.md` | one sentence on the "Crons & webhooks" heartbeat bullet (line 66): a schedule change re-sizes the row in the same PR |
| `docs/CHANGELOG.md` | one row under the header |

---

### Task 1: the PGlite replay test (red)

**Files:**
- Create: `tests/migration-644-cron-heartbeat-cadence.test.js`

- [ ] **Step 1: Write the failing test**

(This uses PGlite's multi-statement SQL runner, the `exec` method on the PGlite instance. That is an in-process SQL call, not `child_process`, the same as `tests/migration-639-…`. If a security hook flags it, that is a false positive.)

```js
// CLASSSYNCHB.1 — behavioural test for migration 644.
//
// Four cron_heartbeats rows drifted from their vercel.json schedule because a
// schedule changed with no heartbeat migration:
//   sync-class-occurrences  */15 but 86400+7200 (migs 285/286 widened it for an
//                           hourly then daily schedule; HR-WAVE1 P0-8 restored */15)
//   ad-insights-sync        0 */4 but 86400+21600 (mig 360 seeded it daily)
//   process-class-bookings  */2 but 60+120   (#894 slowed it from every minute)
//   process-contact-imports */2 but 60+120   (same)
//
// Boots PGlite, runs the REAL mig 053, rebuilds that live drift from the real
// migrations where they are pure heartbeat DML (119, 285, 286, 360) and from
// the exact seed statement where the file also carries unrelated DDL (097,
// 284, 335), then runs 644 and proves:
//   * each row ends on its intended cadence (one missed tick never pages, two do);
//   * last_ok_at and last_outcome are NEVER touched: a late row stays late;
//   * replay is a no-op; a missing row is seeded born healthy;
//   * the self-check reads the post-state and aborts the WHOLE file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_119 = read('119_cron_heartbeat_fixes.sql')
const MIG_285 = read('285_class_occurrences_sync_hourly.sql')
const MIG_286 = read('286_class_occurrences_sync_daily.sql')
const MIG_360 = read('360_ads_cron_heartbeats.sql')
const MIG_644 = read('644_cron_heartbeat_cadence.sql')

const INTENDED = {
  'ad-insights-sync': { expected_interval_seconds: 14400, grace_seconds: 18000 },
  'process-class-bookings': { expected_interval_seconds: 120, grace_seconds: 240 },
  'process-contact-imports': { expected_interval_seconds: 120, grace_seconds: 240 },
  'sync-class-occurrences': { expected_interval_seconds: 900, grace_seconds: 1200 },
}
const NAMES = Object.keys(INTENDED)

let db
// PGlite's multi-statement SQL runner (in-process, no shell), one implicit
// transaction per call, as apply_migration runs a file.
const runSql = (text) => db.exec(text)

const row = async (name) => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0]

const cadence = async (name) => {
  const r = await row(name)
  return r && { expected_interval_seconds: r.expected_interval_seconds, grace_seconds: r.grace_seconds }
}

/** Put last_ok_at `seconds` in the past and ask the health view. */
const staleAfter = async (name, seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [name, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale
}

/** The live drift of 27 Sep 2026, rebuilt from the migrations that made it. */
async function seedLiveDrift() {
  // mig 097:65-72's seed for process-contact-imports (the file also drops pg_cron)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
                VALUES ('process-contact-imports', 60, 30, 'Vercel cron * * * * * UTC')`)
  await runSql(MIG_119) // its grace 30 → 120
  // mig 284:88-90's seed (the file also creates class_occurrences / automation_fire_log)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
                VALUES ('sync-class-occurrences', 900, 900, NOW()) ON CONFLICT (name) DO NOTHING`)
  await runSql(MIG_285) // → 3600 + 1800
  await runSql(MIG_286) // → 86400 + 7200
  await runSql(MIG_360) // ad-insights-sync 86400 + 21600
  // mig 335:61-63's seed (the file also creates class_booking_requests)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
                VALUES ('process-class-bookings', 60, 120, now()) ON CONFLICT (name) DO NOTHING`)
}

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;') // mig 053's policies name them
  await runSql(MIG_053)
  await runSql('ALTER TABLE public.cron_heartbeats ADD COLUMN last_outcome JSONB;') // mig 315
}, 60_000)

afterEach(async () => { await db?.close() })

describe('the drift 644 repairs', () => {
  it('replaying the migrations reproduces the live rows of 27 Sep', async () => {
    await seedLiveDrift()
    expect(await cadence('sync-class-occurrences')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 7200 })
    expect(await cadence('ad-insights-sync')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 21600 })
    expect(await cadence('process-class-bookings')).toEqual({ expected_interval_seconds: 60, grace_seconds: 120 })
    expect(await cadence('process-contact-imports')).toEqual({ expected_interval_seconds: 60, grace_seconds: 120 })
  })
})

describe('mig 644 puts each row on its real cadence', () => {
  it.each(NAMES)('%s ends on its intended interval + grace, with notes naming the schedule and mig 644', async (name) => {
    await seedLiveDrift()
    await runSql(MIG_644)
    expect(await cadence(name)).toEqual(INTENDED[name])
    expect((await row(name)).notes).toMatch(/CLASSSYNCHB\.1 \(mig 644\)/)
    expect((await row(name)).notes).toMatch(/Vercel cron /)
  })

  it('sync-class-occurrences (*/15): one missed tick never pages, two in a row do (35 min)', async () => {
    await seedLiveDrift(); await runSql(MIG_644)
    expect(await staleAfter('sync-class-occurrences', 31 * 60)).toBe(false)  // one miss + 60 s run
    expect(await staleAfter('sync-class-occurrences', 34 * 60)).toBe(false)
    expect(await staleAfter('sync-class-occurrences', 36 * 60)).toBe(true)
    expect(await staleAfter('sync-class-occurrences', 45 * 60)).toBe(true)   // two misses
  })

  it('ad-insights-sync (0 */4): one missed run never pages, two in a row do (9 h)', async () => {
    await seedLiveDrift(); await runSql(MIG_644)
    expect(await staleAfter('ad-insights-sync', 8 * 3600 + 300)).toBe(false) // one miss + maxDuration
    expect(await staleAfter('ad-insights-sync', 8 * 3600 + 59 * 60)).toBe(false)
    expect(await staleAfter('ad-insights-sync', 9 * 3600 + 60)).toBe(true)
  })

  it.each(['process-class-bookings', 'process-contact-imports'])('%s (*/2): one missed tick never pages; stale after 6 min', async (name) => {
    await seedLiveDrift(); await runSql(MIG_644)
    expect(await staleAfter(name, 200)).toBe(false)  // was already stale under 60 + 120
    expect(await staleAfter(name, 300)).toBe(false)  // one miss + 60 s jitter
    expect(await staleAfter(name, 361)).toBe(true)
  })

  it('touches no other row', async () => {
    await seedLiveDrift()
    const others = `SELECT name, last_ok_at, expected_interval_seconds, grace_seconds, notes FROM public.cron_heartbeats WHERE name <> ALL($1) ORDER BY name`
    const before = (await db.query(others, [NAMES])).rows
    expect(before.length).toBeGreaterThan(3) // 053's, 119's and 360's other seeds are there
    await runSql(MIG_644)
    expect((await db.query(others, [NAMES])).rows).toEqual(before)
  })
})

describe('never re-arms: last_ok_at and last_outcome are left alone', () => {
  it('keeps each row\'s last stamp and outcome byte-for-byte', async () => {
    await seedLiveDrift()
    await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - interval '10 minutes', last_outcome = '{"n":1}'::jsonb WHERE name = ANY($1)`, [NAMES])
    const before = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await row(n)])))
    await runSql(MIG_644)
    for (const n of NAMES) {
      const after = await row(n)
      expect(after.last_ok_at).toEqual(before[n].last_ok_at)
      expect(after.last_outcome).toEqual({ n: 1 })
    }
  })

  it('a class sync that is really dead (2 h since its last stamp) is STALE the moment 644 lands, and was hidden before', async () => {
    await seedLiveDrift()
    expect(await staleAfter('sync-class-occurrences', 2 * 3600)).toBe(false) // 86400 + 7200 hides it
    await runSql(MIG_644)
    expect((await db.query(`SELECT is_stale FROM public.cron_health WHERE name = 'sync-class-occurrences'`)).rows[0].is_stale).toBe(true)
  })
})

describe('replay and a fresh database', () => {
  it('replaying 644 is a no-op', async () => {
    await seedLiveDrift()
    await runSql(MIG_644)
    const snap = async () => (await db.query(`SELECT * FROM public.cron_heartbeats ORDER BY name`)).rows
    const once = await snap()
    await runSql(MIG_644)
    expect(await snap()).toEqual(once)
  })

  it('a row that does not exist yet is seeded born healthy (last_ok_at defaults to now())', async () => {
    await runSql(MIG_644)
    for (const n of NAMES) expect(await cadence(n)).toEqual(INTENDED[n])
    const { rows } = await db.query(`SELECT name FROM public.cron_health WHERE name = ANY($1) AND is_stale`, [NAMES])
    expect(rows).toEqual([])
  })
})

describe('the self-check reads the post-state', () => {
  it('a row that does not END UP on the intended cadence aborts the WHOLE file', async () => {
    await seedLiveDrift()
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'process-contact-imports' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_644)).rejects.toThrow(/mig 644: cron_heartbeats row process-contact-imports .*120.*240/)
    // nothing applied: every row still carries its drift
    expect(await cadence('sync-class-occurrences')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 7200 })
    expect(await cadence('ad-insights-sync')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 21600 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/migration-644-cron-heartbeat-cadence.test.js`
Expected: FAIL at import, `ENOENT … 644_cron_heartbeat_cadence.sql`. (Temporarily commenting out the `MIG_644` read should turn the first `describe` green. That shows the replay reproduces the live drift before any fix. Restore it.)

---

### Task 2: migration 644 (green)

**Files:**
- Create: `supabase/migrations/644_cron_heartbeat_cadence.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 644 — CLASSSYNCHB.1: four cron_heartbeats rows back on their real cron
-- cadence.
--
--   APPLY ANY TIME. No code depends on it: all four rows already exist and are
--   stamped by deployed routes. Run the pre-check first (plan C2 Task 5): no
--   row may already be older than its NEW window, or it pages the moment this
--   lands (which would be true, but check it first).
--
-- WHY
-- ───
-- Each row was sized for a vercel.json schedule that later changed with no
-- heartbeat migration, so the health-check judged it on the wrong clock:
--
--   sync-class-occurrences  vercel.json */15 * * * *, row 86400 + 7200.
--     Mig 284 seeded 900 + 900; migs 285/286 widened it for an hourly then a
--     daily schedule; HR-WAVE1 P0-8 (2 Jul, commit 1345e7a3) restored */15
--     (classes cancelled after the 04:00 run kept firing the studio AC) and
--     left the row daily. A dead class sync went unnoticed for 26 hours
--     while the spine holds only 48 hours ahead. Mig 406's header lists this
--     row as 900 + 900: it read migration text, not the live row.
--   ad-insights-sync        vercel.json 0 */4 * * *, row 86400 + 21600.
--     Mig 360 seeded it for the first daily schedule; commit 10770775 (4 Jul)
--     moved the cron to every 4 hours. A dead sync went unnoticed for 30 h.
--   process-class-bookings  vercel.json */2 * * * *, row 60 + 120.
--   process-contact-imports vercel.json */2 * * * *, row 60 + 120.
--     Seeded for every minute (migs 335; 097 + 119); #894 (11 Jul, cost
--     cut) moved both to */2. Stale after 180 s against a 120 s cadence, so
--     ONE missed tick paged.
--
-- CADENCE — one rule: a single missed invocation never pages, two in a row do
-- ───────────────────────────────────────────────────────────────────────────
-- The gap between two stamps is the interval plus Vercel's invocation jitter
-- plus the run time (each route stamps at the END of its run), so the grace
-- clears one missed tick with room to spare (mig 119's jitter lesson; mig
-- 633's "never sit exactly on the boundary"):
--   sync-class-occurrences  900 + 1200   stale at 35 min (one miss ~1800 s +
--                           <=60 s maxDuration; two misses 2700 s)
--   ad-insights-sync        14400 + 18000 stale at 9 h (one miss 28800 s +
--                           <=300 s maxDuration; two misses 43200 s)
--   process-class-bookings  120 + 240    stale at 6 min: the */2 drain
--   process-contact-imports 120 + 240    convention (process-invoice-analysis, mig 377)
--
-- What each row's STALE means is unchanged: all four routes stamp on every run
-- that did not crash, including runs whose external call failed
-- (sync-class-occurrences stamps on a Glofox-down tick; ad-insights-sync when
-- an account's sync failed). So a Glofox outage does not page from here; a
-- cron that stopped running, or crashes, does.
--
-- ON CONFLICT DO UPDATE OF THE SCHEDULE ONLY — NEVER last_ok_at
-- ─────────────────────────────────────────────────────────────
-- Unlike 601/623/633-642 this does NOT re-arm last_ok_at: these rows are
-- stamped by live code, and re-arming would hide one that is genuinely late
-- at apply time. last_outcome is left alone too. A missing row (a fresh
-- database) is inserted and takes last_ok_at's DEFAULT now(). Replay is a
-- no-op. Tune a grace in a new migration, not by hand.
--
-- The self-check at the bottom reads the POST-state: every row must END UP on
-- exactly this schedule, or the whole file aborts (nothing is applied).
--
-- tests/cron-heartbeat-schedule-pins.test.js fails the next PR that changes
-- one of these four vercel.json schedules without a new heartbeat migration.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here) — the
-- live values read on 27 Sep 2026:
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 86400, grace_seconds = 7200,  notes = NULL WHERE name = 'sync-class-occurrences';
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 86400, grace_seconds = 21600, notes = 'Daily Meta ads insight sync' WHERE name = 'ad-insights-sync';
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 60,    grace_seconds = 120,   notes = NULL WHERE name = 'process-class-bookings';
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 60,    grace_seconds = 120,   notes = 'Vercel cron * * * * * UTC [grace bumped 30→120s in mig 119 to absorb Vercel cron tick jitter]' WHERE name = 'process-contact-imports';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'sync-class-occurrences',
    900,
    1200,
    'CLASS-CLIMATE.1 (mig 284), re-sized by CLASSSYNCHB.1 (mig 644). Refreshes the class_occurrences spine (the next 48 h) from Glofox for every Glofox-connected location, and reconciles cancellations. Vercel cron */15 * * * * (restored by HR-WAVE1 P0-8 on 2 Jul after migs 285/286 had widened this row for an hourly then daily schedule). Stamped at the end of every tick that read the locations list, INCLUDING ticks where a location''s Glofox fetch or upsert failed (stats.errors + a cron-sync-class-occurrences logWarn): STALE means the cron is not running or is crashing, not that Glofox is down. 900 + 1200: one missed tick never pages, two in a row do (35 min).'
  ),
  (
    'ad-insights-sync',
    14400,
    18000,
    'ADS-REPORT.1 (mig 360), re-sized by CLASSSYNCHB.1 (mig 644). Meta ad insights sync (yesterday + today, Dublin). Vercel cron 0 */4 * * * since 4 Jul (mig 360 seeded this row for the first, daily schedule). Stamped at the end of every run, whether or not an account''s sync failed (ad_accounts.last_sync_error holds that). 14400 + 18000: one missed run never pages, two in a row do (9 h).'
  ),
  (
    'process-class-bookings',
    120,
    240,
    'START booking drain (mig 335), re-sized by CLASSSYNCHB.1 (mig 644). Drains class_booking_requests (the /start class-booking queue) into Glofox. Vercel cron */2 * * * * since #894 (11 Jul; seeded for every minute). Stamped on every run that did not throw. 120 + 240, the */2 drain convention (process-invoice-analysis, mig 377): one missed tick never pages; stale after 6 min.'
  ),
  (
    'process-contact-imports',
    120,
    240,
    'Contact import drain (mig 097, grace mig 119), re-sized by CLASSSYNCHB.1 (mig 644). Processes the oldest pending contact_imports job (the QStash worker races it by design). Vercel cron */2 * * * * since #894 (11 Jul; seeded for every minute). Stamped on every run except a job missing its payload (a 500). 120 + 240, the */2 drain convention (process-invoice-analysis, mig 377): one missed tick never pages; stale after 6 min.'
  )
ON CONFLICT (name) DO UPDATE
  SET expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check (POST-state): every row exists on exactly the intended schedule.
-- Anything else aborts the whole file, so nothing above is applied.
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('sync-class-occurrences', 900, 1200),
    ('ad-insights-sync', 14400, 18000),
    ('process-class-bookings', 120, 240),
    ('process-contact-imports', 120, 240)
  ) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 644: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds % (the VALUES above and this check disagree, or something outside the INSERT rewrote the row); nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 2: Run the test and watch it pass**

Run: `npx vitest run tests/migration-644-cron-heartbeat-cadence.test.js`
Expected: PASS, 15 tests. The `it.each` rows count once each.

- [ ] **Step 3: Mutation-check the guards** (make each change, re-run, see the named tests fail, revert)
1. Change `1200` to `900` in the `sync-class-occurrences` VALUES row *and* in the DO block. Expected: "one missed tick never pages … 35 min" and the `it.each` cadence row fail.
2. Add `last_ok_at = now(),` to the `DO UPDATE SET`. Expected: "keeps each row's last stamp" and "really dead … STALE the moment 644 lands" fail.
3. Change `('process-contact-imports', 120, 240)` in the DO block to `(…, 120, 241)`. Expected: every test that runs 644 fails with `mig 644: … process-contact-imports`.

Re-run after reverting: green.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/644_cron_heartbeat_cadence.sql tests/migration-644-cron-heartbeat-cadence.test.js
git commit -m "CLASSSYNCHB.1 — mig 644: four heartbeat rows back on their real cron cadence

sync-class-occurrences runs */15 but its row was daily (86400+7200) since
migs 285/286 and HR-WAVE1 P0-8 restored */15 without re-sizing it: a dead
class sync paged after 26 h while the spine holds 48 h. Same drift for
ad-insights-sync (0 */4 vs daily, 30 h) and the two */2 drains
process-class-bookings / process-contact-imports (sized for every minute,
so one missed tick paged). New values follow one rule, one missed tick never
pages and two do: 900+1200, 14400+18000, 120+240, 120+240. DO UPDATE of
interval/grace/notes only; last_ok_at is never re-armed, so a late row stays
late. Post-state self-check aborts the whole file. PGlite replay rebuilds
the live drift from the real migrations and pins thresholds, no-re-arm,
replay, fresh-DB seed and the abort.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: pin the four `vercel.json` schedules to migration 644

**Files:**
- Create: `tests/cron-heartbeat-schedule-pins.test.js`

- [ ] **Step 1: Write the test**

```js
// CLASSSYNCHB.1 — a heartbeat row is only right while its cron keeps the
// schedule it was sized for. Three times a vercel.json schedule changed with
// no heartbeat migration (HR-WAVE1 P0-8 restored sync-class-occurrences to
// */15 with its row still daily; ADS-REPORT moved ad-insights-sync to every
// 4 h; #894 slowed two drains to */2), and each time the health-check judged
// the cron on the wrong clock for months. Mig 644 re-sized those four rows;
// this pins their schedules so the NEXT change fails here, in the PR that
// makes it, instead of in production.
//
// If this fails because you changed one of these schedules on purpose: ship a
// NEW migration re-sizing that cron_heartbeats row (read the live row first,
// not the migration text), then update the pin below to name it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))
const MIG_644 = readFileSync(path.join(root, 'supabase/migrations/644_cron_heartbeat_cadence.sql'), 'utf8')

const schedulesOf = (route) => vercel.crons.filter((c) => c.path === `/api/cron/${route}`).map((c) => c.schedule)

const PINNED = [
  { route: 'sync-class-occurrences', schedule: '*/15 * * * *', interval: 900, grace: 1200 },
  { route: 'ad-insights-sync', schedule: '0 */4 * * *', interval: 14400, grace: 18000 },
  { route: 'process-class-bookings', schedule: '*/2 * * * *', interval: 120, grace: 240 },
  { route: 'process-contact-imports', schedule: '*/2 * * * *', interval: 120, grace: 240 },
]

describe('cron schedules that mig 644 sized a heartbeat row for', () => {
  it.each(PINNED)('$route still runs on "$schedule" (row $interval + $grace)', ({ route, schedule }) => {
    expect(
      schedulesOf(route),
      `vercel.json changed the ${route} schedule. Ship a NEW migration re-sizing its cron_heartbeats row in this PR, then update this pin.`,
    ).toEqual([schedule])
  })

  it.each(PINNED)('mig 644 seeds $route as $interval + $grace (the pin and the SQL agree)', ({ route, interval, grace }) => {
    expect(MIG_644).toMatch(new RegExp(`'${route}',\\s*${interval},\\s*${grace},`))
    expect(MIG_644).toMatch(new RegExp(`\\('${route}', ${interval}, ${grace}\\)`)) // the self-check row
  })
})
```

- [ ] **Step 2: Run it** — `npx vitest run tests/cron-heartbeat-schedule-pins.test.js`. Expected: PASS, 8 tests.

- [ ] **Step 3: Mutation-check it**, then revert each change:
1. In `vercel.json`, change the `sync-class-occurrences` schedule to `"0 4 * * *"`. The first `it.each` row fails, with the message naming the new migration it needs.
2. In the migration's VALUES, change the `ad-insights-sync` interval `14400` to `21600`. The second `it.each` row fails for `ad-insights-sync` (and so does Task 1's test).

Re-run after reverting: green.

- [ ] **Step 4: Commit**

```bash
git add tests/cron-heartbeat-schedule-pins.test.js
git commit -m "CLASSSYNCHB.1 — pin the four cron schedules mig 644 sized a heartbeat row for

A vercel.json schedule change with no heartbeat migration is how all four
rows drifted (P0-8, ADS-REPORT, #894). The next such change now fails in
the PR that makes it, and the pin cross-checks mig 644's numbers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: one sentence in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md:66` (the **Crons & webhooks** heartbeat bullet)

- [ ] **Step 1: Append to the end of that bullet**, after `…a row seeded early goes stale after interval + grace if the deploy is slower.`:

```
 **Changing a cron's `vercel.json` schedule re-sizes its row in the SAME PR** (a new migration; judge the live row, not the migration text): three schedule changes shipped without one and left `sync-class-occurrences` on a daily clock for a `*/15` cron for three months (CLASSSYNCHB.1, mig 644). Size the grace so ONE missed tick never pages: the gap between stamps is interval + Vercel jitter + run time.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "CLASSSYNCHB.1 — CLAUDE.md: a cron schedule change re-sizes its heartbeat row in the same PR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: gate, apply migration 644, PR, changelog

- [ ] **Step 1: Focused tests**

```bash
npx vitest run tests/migration-644-cron-heartbeat-cadence.test.js tests/cron-heartbeat-schedule-pins.test.js \
  tests/migration-633-arm-heartbeats.test.js tests/migration-639-shift-time-change-heartbeat.test.js \
  tests/migration-640-replace-notice-heartbeat.test.js tests/migration-642-shift-offer-sweep-heartbeat.test.js
```

Expected: all green. The four older migration tests are untouched: they seed their own rows, and none of them names these four.

- [ ] **Step 2: The full CI mirror (all twelve), once**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected, all unchanged:
- no route, no `.select()`, no write;
- 644 is DML only, with no policy, so `check:rls-restrictive` has nothing new to replay;
- nothing under `mobile/` or `shared/`.

`npm run build` is not needed: there is no import, route or page change. Run it anyway if the reviewer asks. CI's "Next build" job runs it regardless.

- [ ] **Step 3: Independent review**, then push and open the PR (do NOT merge yet):

```bash
git push -u origin HEAD
gh pr create --base main --title "CLASSSYNCHB.1 — heartbeat rows back on their real cron cadence: class sync 15 min, ad sync 4 h, two drains 2 min (mig 644)" --body-file /private/tmp/claude-501/<scratchpad>/classsynchb1-pr-body.md
```

PR body:

```markdown
## Why

`sync-class-occurrences` runs every 15 minutes, but its heartbeat row said **daily** (86,400 s + 7,200 s grace, read live on 27 Sep). A dead class sync paged after **26 hours**, while the spine holds only 48 hours ahead and the class-climate automation fires the studio AC from it.

How it drifted: mig 284 seeded 900 + 900. Migs 285/286 widened the row when the cron went hourly and then daily (17 Jun). HR-WAVE1 P0-8 (2 Jul) restored `*/15`, because classes cancelled after the 04:00 run kept the AC firing, and did not re-size the row. Mig 406's audit then listed the row as 900 + 900 from the migration text.

A full comparison of the 83 live rows against the 79 `vercel.json` entries found the same drift in three more rows:

| Row | Schedule | Was | Now | Effect of the old row |
|---|---|---|---|---|
| `sync-class-occurrences` | `*/15` | 86400 + 7200 | **900 + 1200** | dead sync unnoticed for 26 h |
| `ad-insights-sync` | `0 */4` (since 4 Jul) | 86400 + 21600 | **14400 + 18000** | dead sync unnoticed for 30 h |
| `process-class-bookings` | `*/2` (since #894) | 60 + 120 | **120 + 240** | one missed tick paged |
| `process-contact-imports` | `*/2` (since #894) | 60 + 120 | **120 + 240** | one missed tick paged |

## The rule

One missed invocation never pages, and two in a row do. The gap between stamps is interval + Vercel jitter + run time. The routes stamp at the end of a run, and stamps land 5–40 s after the minute live. So the index's 900 + 900 for the class sync would put a single skipped tick exactly on the boundary. The drains use the `*/2` convention of `process-invoice-analysis` (mig 377).

Unchanged: what STALE means for each row. All four routes stamp on every run that did not crash, including a Glofox-down tick. So a Glofox outage does not page from here, and a cron that stopped running or crashes does.

## Migration 644, applied before merge (pre/post checks in the plan)

- `ON CONFLICT DO UPDATE` of interval, grace and notes only. **`last_ok_at` is never re-armed**, so a row that is really late stays late, and `last_outcome` is untouched.
- A missing row is seeded born healthy.
- A post-state self-check aborts the whole file.
- Rollback values are in the migration header.

## Tests

- **PGlite replay.** The real migs 053/119/285/286/360, plus 097/284/335's exact seeds, rebuild the live drift. Then 644 runs, and the test pins the thresholds via `cron_health`, no re-arm, a late row going stale at once, replay no-op, fresh-DB seed and the whole-file abort.
- **`tests/cron-heartbeat-schedule-pins.test.js`.** It fails the next PR that changes one of these four `vercel.json` schedules without a new heartbeat migration.
- Every guard was mutation-checked.

CLAUDE.md gets one sentence: a schedule change re-sizes the row in the same PR.

No route, lib, `mobile/`, `shared/` or `vercel.json` change: **no OTA**.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 4: Apply migration 644** (once the PR is green and approved; merge authority per `00-INDEX.md`)

1. Confirm the project: Supabase MCP `list_projects` → `iyvtbjjxdggiadzwwvdj` (un1t-crm, NOT sentinel `tpttqakxmyxrwnqjepfm`). Confirm that `644` is still the next free number on `origin/main`, and not already in `list_migrations`.
2. **Pre-checks** (`execute_sql`, read-only):

```sql
-- The four rows as they are now. Expect the drift values; SAVE this output as the rollback source.
SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at,
       EXTRACT(EPOCH FROM (now() - last_ok_at))::int AS age_s
  FROM public.cron_heartbeats
 WHERE name IN ('sync-class-occurrences', 'ad-insights-sync', 'process-class-bookings', 'process-contact-imports')
 ORDER BY name;
-- expect: ad-insights-sync 86400/21600, process-class-bookings 60/120,
--         process-contact-imports 60/120, sync-class-occurrences 86400/7200.
-- GATE: every age_s must be inside its NEW window, or the row pages the moment 644 lands:
--   sync-class-occurrences < 2100, ad-insights-sync < 32400,
--   process-class-bookings < 360, process-contact-imports < 360.
--   (27 Sep 21:40 UTC: 595, 5969, 107, 90.) A row over its new window is a
--   genuinely late cron: investigate it (Vercel cron logs) before applying.

-- Baseline stale list, so a pre-existing stale row is not blamed on 644.
SELECT name, stale_seconds, max_allowed_seconds FROM public.cron_health WHERE is_stale ORDER BY name;
-- 27 Sep: instagram-feed-sync and receipt-coverage-weekly (both unrelated, see Open question 5).
```

   If the rows differ from the drift values (someone re-sized one by hand), stop and re-plan. 644's self-check would still pass, but the rollback values in its header would be wrong.

3. **Rollback record:** write `/private/tmp/claude-501/<scratchpad>/mig644-rollback.sql` with the four `UPDATE`s from the migration header. Correct the values if the pre-check read differs.
4. **Apply** with `apply_migration`, name `644_cron_heartbeat_cadence`, and the file's full SQL.
5. **Post-checks:**

```sql
SELECT name, expected_interval_seconds, grace_seconds, stale_seconds, max_allowed_seconds, is_stale
  FROM public.cron_health
 WHERE name IN ('sync-class-occurrences', 'ad-insights-sync', 'process-class-bookings', 'process-contact-imports')
 ORDER BY name;
-- expect: ad-insights-sync 14400/18000/32400, process-class-bookings 120/240/360,
--         process-contact-imports 120/240/360, sync-class-occurrences 900/1200/2100;
--         all is_stale = false; stale_seconds equal to the pre-check age (+ elapsed), i.e. last_ok_at NOT re-armed.

SELECT name FROM public.cron_health WHERE is_stale ORDER BY name;
-- expect: exactly the baseline list.
```

6. `get_advisors` (type `security`): expect nothing new, since 644 is DML only on a table whose RLS is unchanged.
7. **Merge.**
8. **About 20 minutes later**, check that the class sync is still stamping on its 15-minute clock:

```sql
SELECT name, stale_seconds, max_allowed_seconds, is_stale
  FROM public.cron_health
 WHERE name IN ('sync-class-occurrences', 'process-class-bookings', 'process-contact-imports');
-- expect: sync-class-occurrences stale_seconds < 900, the drains < 120, none stale.
```

- [ ] **Step 5: Changelog row**

Add ONE new row directly under the `| # / PR | Item | Notes |` / `|---|------|-------|` header of `docs/CHANGELOG.md` (lines 10-11 on `28d02e59`), keyed by the PR number `gh` printed, with the merge day's date. Never edit a pushed row (`merge=union` duplicates it).

```
| #<PR> | CLASSSYNCHB.1 — heartbeat rows back on their real cron cadence: class sync 15 min, ad sync 4 h, two drains 2 min | <merge date>. **Mig 644, applied before merge (no code dependency).** No route/lib/`mobile/`/`shared/`/`vercel.json` change, so **no OTA**. `sync-class-occurrences` runs `*/15` but its row was daily (86400+7200, read live 27 Sep): migs 285/286 widened it for an hourly then daily schedule, and HR-WAVE1 P0-8 (2 Jul) restored `*/15` without re-sizing it (mig 406's audit then read 900+900 off the migration text). A dead class sync paged after 26 h while the spine holds 48 h. A full live-vs-`vercel.json` comparison found the same drift in `ad-insights-sync` (`0 */4` since 4 Jul vs daily: 30 h) and the two `*/2` drains `process-class-bookings`/`process-contact-imports` (sized for every minute by migs 335/097+119 before #894 slowed them: one missed tick paged). New values, one rule, one missed tick never pages and two do (gap = interval + Vercel jitter + run time): 900+1200, 14400+18000, 120+240, 120+240 (the drains take the `*/2` convention of mig 377). `ON CONFLICT DO UPDATE` of interval/grace/notes only: `last_ok_at` is never re-armed, so a late row stays late. Post-state self-check aborts the file. Unchanged: every one of these routes stamps on any run that did not crash (the class sync stamps on a Glofox-down tick), so STALE = the cron stopped or crashes, not an upstream outage. Tests: PGlite replay rebuilds the live drift from the real migrations, then pins thresholds via `cron_health`, no re-arm, replay, fresh-DB seed, whole-file abort; `tests/cron-heartbeat-schedule-pins.test.js` fails the next PR that changes one of these four schedules without a heartbeat migration. CLAUDE.md: a schedule change re-sizes its row in the same PR. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "CLASSSYNCHB.1 — changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### PR gate (summary)

1. Focused tests (Task 5 Step 1) green, and every mutation check in Tasks 2-3 seen red and then reverted.
2. The twelve-command CI mirror green.
3. Independent review approved.
4. CI green on the final rebase. `docs/CHANGELOG.md` is the only expected conflict. C1 RECIPIENTS.1, the wave-3 neighbour, touches no migration.
5. Mig 644 applied with its pre-check gate, rollback record and post-checks, **then** merge, then the 20-minute follow-up read.

---

### Open questions

1. **Grace 1200, not the index's 900, for the class sync.** 900 + 900 is what mig 284 intended, but with the route stamping at the end of a run of up to 60 s, plus Vercel's jitter, a single skipped tick lands on or just past the 1800 s boundary. That is the flap mig 633 rejected for 300 + 600. 900 + 1200 pages at 35 minutes. If Richard wants the literal 900 + 900, the change is two numbers in the migration plus the two tests' thresholds.
2. **Folding three more rows into a row keyed "CLASSSYNCHB".** The brief asked to fold the obvious mismatches. `ad-insights-sync` and the two drains are the same drift (a schedule change with no heartbeat migration), each a one-line VALUES row, and each test is independent. If the reviewer wants C2 to stay narrow, drop them from the VALUES, the self-check, the pin test and `INTENDED`. The class-sync fix stands alone.
3. **This row means "the tick ran", not "the spine is fresh".** `sync-class-occurrences/route.js:49-50` stamps even when every location's sync failed. So a Glofox outage (or a revoked key) that empties the spine does not page from here, before or after this PR. After 48 h the class-climate automation stops firing silently. Options, none of them in this PR:
   - (a) C3 TRAINERCALLS.1 edits this route anyway, so it could pass `stats` as the stamp's `last_outcome`. That gives visibility, and costs nothing.
   - (b) A separate spine-freshness signal, such as "latest `synced_at` for a Glofox-connected location older than 2 h" in the health-check or sentinel, which pages on an upstream outage without making this row flap on Glofox blips.
   - Making this stamp conditional on `stats.errors === 0` would page on every 35-minute Glofox blip. That is not recommended.
4. **Mismatches deliberately NOT folded** (a candidate clean-up row, or a D-row sweep):
   - Label-only, with the same 6-minute window: `run-campaigns` (60 + 300 on `*/2`) and `send-host-campaigns` (300 + 60 on `*/2`).
   - Lax: `process-receipt-hunts` 600 + 1200 on `*/5` (as seeded), and `wallet-monthly-reset` 2678400 + 259200 on a daily cron (deliberate: self-gating and self-healing).
   - Tight graces where one missed tick already pages: `run-strava-exports` 120 + 90; `race-timing-events` 900 + 240; `run-whatsapp-broadcasts` 900 + 300; `run-sequences`, `run-sms-broadcasts`, `ac-auto-off`, `ac-external-rule` and `auto-end-stale-hr-sessions` at 300 + 180; `send-class-booking-reminders` 300 + 300; `checklist-sweep` and `agent-followups` at 900 + 900. These may be part of why memory records "stale-cron often benign".
   - A **repo-wide** guard would be better than this PR's four pins: a manifest of every `vercel.json` cron → its row's interval, checked against the schedule. It is a bigger test, and the manifest would need a live read to build.
5. **Stale live right now, unrelated to cadence:**
   - `instagram-feed-sync` last stamped 26 Sep 12:00 UTC, 33.7 h against its 8 h allowance. It is a real alarm (token or API?) and worth a look on its own.
   - `receipt-coverage-weekly` has been stale since 4 Sep (known: bank rec deprioritised). It also has **two** `vercel.json` entries (`0 7 * * 5` and `0 8 * * 5`), so it runs twice every Friday. Probably a leftover; one line to remove when that feature is picked up again.
6. **Seen in passing (the discarded-error class, not this PR):** `ad-insights-sync/route.js:30` discards the `ad_accounts` read error, so a failed read syncs nothing and still stamps. `process-contact-imports/route.js:65-70` and `process-class-bookings/route.js:41-42` do the same on their queue reads. Each reads as a healthy quiet run.
