# Replaying `supabase/migrations` on a fresh database

Migrations in this repo are **forward-only** and are applied to exactly one
live project (`iyvtbjjxdggiadzwwvdj`) via the Supabase MCP, in order, once.
That is the only path any of them has ever been exercised on.

They are therefore **not a replayable schema build**. Several were written
against the live shape of the day and will abort part-way through if you run
the directory top-to-bottom into an empty database — which is what you would
do to stand up a staging environment, a local Postgres for integration tests,
or a second tenant.

This file is the list of what to hand-fix when you do. It is not a to-do:
editing the historical files is out (forward-only is what makes
`check:rls-restrictive`, `check:location-scoping` and `check:bundle-sql`
able to trust the directory as a record of the live box). Documenting the
trap is in.

**Rule for this file:** when you find a migration that cannot replay, add it
here rather than editing it. When you write a new migration, the question to
ask is "does this abort if the object already exists, or if it does not?" —
`IF EXISTS` / `IF NOT EXISTS` / a `DO $$ ... $$` guard on `pg_policies` or
`pg_constraint` costs one line and removes the entry you would otherwise be
adding here.

---

## Known hazards

### 1. `177_shift_min_coaches.sql` — a CHECK added before the backfill that can violate it

**What it does, in this order:**

```sql
alter table public.shift_blocks
  add column if not exists min_coaches smallint not null default 1;

alter table public.shift_blocks
  add constraint shift_blocks_min_coaches_check
  check (min_coaches >= 0 and min_coaches <= max_coaches);

update public.shift_blocks b
set    min_coaches = t.min_coaches
from   public.shift_templates t
where  b.template_id = t.id
  and  b.min_coaches is distinct from t.min_coaches;
```

**Why it can abort.** The `ADD CONSTRAINT` passes trivially: every row is
still at the default `1`, and `max_coaches` is already CHECKed `between 1 and
50` by mig 067. The `UPDATE` is the hazard. `shift_blocks.max_coaches` is a
**snapshot** of the template taken when the block was generated — that is the
deliberate design (mig 067: "editing a template later does NOT retroactively
change blocks already on the calendar"). So a template whose `max_coaches`
was **raised** after some blocks existed leaves those old blocks carrying the
older, lower `max_coaches`. Copy that template's `min_coaches` onto such a
block and you get `min_coaches > max_coaches`; the constraint — already armed
one statement earlier — fires, and the migration aborts with every statement
in the file rolled back.

It did not happen on the day 177 was applied, because no such row existed
then. It is not unreachable in general, and a replay over restored or
imported data can hit it.

**Hand-fix on a fresh database** — split the constraint around the backfill
and clamp the copy:

```sql
alter table public.shift_blocks
  add constraint shift_blocks_min_coaches_check
  check (min_coaches >= 0 and min_coaches <= max_coaches) not valid;   -- NOT VALID

update public.shift_blocks b
set    min_coaches = least(t.min_coaches, b.max_coaches)               -- clamped
from   public.shift_templates t
where  b.template_id = t.id
  and  b.min_coaches is distinct from least(t.min_coaches, b.max_coaches);

alter table public.shift_blocks
  validate constraint shift_blocks_min_coaches_check;                  -- then VALIDATE
```

The same file applies the same shape to `shift_templates`, which is **not**
affected: there is no backfill on that table, so nothing runs between the ADD
and the end of the file.

`605_rostering_replay_guards.sql` re-asserts the `shift_blocks` constraint in
the `NOT VALID` + `VALIDATE` shape, guarded on `pg_constraint`, so a database
that got past 177 some other way still ends up with it. It cannot fix 177
itself: 605 runs 433 migration files later.

---

### 2. `320_perf_consolidate_multiple_permissive_policies.sql` — bare `DROP POLICY` and un-guardable `CREATE POLICY`

**What it does.** 67 bare `DROP POLICY "name" ON public.<table>;` statements
(no `IF EXISTS`) followed by the consolidated replacements. Postgres has no
`CREATE POLICY IF NOT EXISTS`, so neither half can be made idempotent in
place.

**Why it can abort.** Two directions, both fatal to the file:

- a `DROP POLICY` for a policy that is **not** there → `ERROR: policy ... does
  not exist`;
- a `CREATE POLICY` for a name that **is** already there → `ERROR: policy ...
  already exists`.

Replaying the directory in filename order into an empty database does satisfy
every one of the 67 drops today (each dropped name is created by an earlier
file — 010, 011, 048, 067, 072, 109 — and nothing drops it in between; this
was checked by replaying the policy DDL of all 600+ files). But that is a
property of the current directory, not a guarantee: any divergence — a file
skipped, a partial re-run, a restore taken mid-history, a hand-made policy on
the target — puts 320 in the failing state.

**The failure mode is the dangerous part.** 320 is one file but not one
transaction as applied, so an abort part-way leaves the rostering tables with
some old policies dropped and some new ones created. RLS ORs permissive
policies, so a half-applied consolidation does not read as broken — it reads
as *working, slightly wider*. Nothing surfaces it.

**Hand-fix on a fresh database.** Before running 320, either

- rewrite its drops locally as `DROP POLICY IF EXISTS` (do not commit that —
  forward-only), or
- run it, and on the first error note which statement failed, drop the
  offending policy by hand and resume from that line.

Then check the end state:

```sql
SELECT tablename, policyname, cmd, permissive, roles
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY 1, 2;
```

**What mig 605 covers.** `605_rostering_replay_guards.sql` re-asserts the
**thirteen** policies that live only in 320 and are on the rostering tables —
`rosters` (3), `shift_assignments` (3), `shift_blocks` (3),
`shift_swap_requests` (4) — each behind an `IF NOT EXISTS` check on
`pg_policies`. So a database where 320 aborted mid-file still ends up with
the intended rostering policy set.

🔴 It deliberately does **not** re-assert 320's policies for
`time_off_requests`, `staff_allowances` or `shift_templates`. Mig 600
(ROSTER-FIX.2) replaced those with location-scoped versions; 320's are the
globally-scoped ones that let a manager at one studio read every studio's
leave and pay. Re-asserting 320 there would re-open the leak. Mig 600 uses
`DROP POLICY IF EXISTS` + `CREATE POLICY` throughout, so it is replay-safe on
its own.

605 covers nothing on the other ~50 tables 320 touches. If you are standing
up a full environment, the `pg_policies` diff above against the live box is
the check that matters.

---

### 3. `602_rosters_no_overlap.sql` — a backfill that must run before its own constraint

**Not a replay hazard so much as a shape worth knowing about**, because 602 is
the one migration in the directory that will deliberately **abort itself**.

602 was written under ROSTER-FIX.4, never applied anywhere (production reached
605 with 602 still a deliberate gap), and **rewritten in place on 2026-09-09**
under ROSTER-SUPERSEDE.1. That rewrite is not a breach of forward-only:
forward-only fences migrations that *have* been applied, because the directory
is the record of the live box, and a file that has never touched a database is
not part of that record. Once 602 has been applied, the usual rule resumes —
change it in a new migration.

Its shape, in order:

1. `btree_gist`, then `superseded_by` / `superseded_at` /
   `requested_period_start` / `requested_period_end` (all `IF NOT EXISTS`).
2. The status CHECK widened to include `'superseded'`. Mig 072 wrote that check
   **inline and unnamed**, so it is dropped **by definition** — any CHECK on
   `rosters` whose definition mentions `status` — rather than by a guessed
   auto-generated name. A wrong guess would leave the old constraint armed and
   every supersede rejected. `rosters_period_check` does not mention `status`
   and survives.
3. A three-step backfill: preserve `requested_period_*`, supersede the
   published rosters owning zero blocks, shrink the rest to the days they own.
4. 🔴 **A `DO $$ … RAISE EXCEPTION $$` guard** that counts overlapping
   published pairs *after* the backfill and aborts the file if any remain. It
   is there so the file refuses rather than half-applying: without it the
   `ADD CONSTRAINT` in step 5 fails with a bare `23P01` naming two ids, after
   the columns, the widened CHECK and the backfill have already landed.
5. The exclusion constraint, `WHERE (status = 'published')`.
6. `idx_rosters_superseded_by`.

**If it aborts**, that is the guard firing and it means two rosters genuinely
own the same day at one location. Run pre-apply check (d) in the file's own
header to see the pairs, decide which roster wins, and re-run — steps 1-3 are
all idempotent (`IF NOT EXISTS`, `COALESCE`-guarded, and predicated on the
current status), so a re-run after the fix is safe.

The file's header carries the read-only **pre-apply checks with their expected
values on production** (58 zero-block rosters, 16 owners, 0 non-contiguous
owners, 0 overlaps after the shrink). Re-verify them before applying: they are
what makes the constraint applicable at all.

