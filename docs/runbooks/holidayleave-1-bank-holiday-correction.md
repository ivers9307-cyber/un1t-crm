# Bank-holiday leave correction runbook (HOLIDAYLEAVE.1)

One-off, operator-run, **after** the HOLIDAYLEAVE.1 deploy is live: **dry run → read every row → save it → apply once → save the rollback record → dry run again.** An undo is in section 5.
Not a migration. Supabase MCP `execute_sql` against the **un1t-crm** project
(`iyvtbjjxdggiadzwwvdj`, confirm with `list_projects`; NOT sentinel).

Until HOLIDAYLEAVE.1 a `holiday` request was charged for every Mon-Fri day,
bank holidays and studio closures included. The number sits on
`time_off_requests.total_days`, and approval added exactly that number to
`staff_allowances.used_days`. This corrects requests already on file and hands
the over-charged days back. The SQL below is what
`tests/holidayleave-correction.test.js` runs (it reads this file), against the
real mig 011 tables + trigger and the real mig 616 trigger function.

## 1. Read the deploy time (`:deploy_ts`)

Both statements only look at requests **filed before the fix went live**
(`r.created_at < :deploy_ts`). Without that fence a request the NEW code
counted correctly starts to look like an old one the day somebody adds a studio
closure inside it, and a re-run would hand back a day that was never charged.

`:deploy_ts` is the moment the production deployment of this PR's merge commit
became **Ready**, in UTC. The merge time alone is minutes too early, and
requests filed in that gap were still counted the old way:

```bash
# <merge sha> must be the FULL 40-character commit oid: the deployments API
# answers an empty list for a short sha. This prints it:
gh pr view <PR> --repo ivers9307-cyber/un1t-crm --json mergeCommit -q .mergeCommit.oid
gh api "repos/ivers9307-cyber/un1t-crm/deployments?sha=<merge sha>&environment=Production" --jq '.[0].id'
gh api "repos/ivers9307-cyber/un1t-crm/deployments/<deployment id>/statuses" \
  --jq '.[] | select(.state == "success") | .created_at'      # e.g. 2026-09-22T10:41:07Z
```

(Or: Vercel dashboard → Deployments → the Production deployment of that commit
→ its Ready time, converted to UTC.) If in doubt round **up** a few minutes,
never down. Replace `:deploy_ts` with the literal, e.g.
`'2026-09-22T10:41:07Z'::timestamptz`, and use **the same literal in both
statements, on every run**. Un-substituted, both statements are a syntax error
and change nothing.

## 2. Dry run (read-only) — read every row

```sql
WITH bank(d) AS (
  VALUES ('2026-01-01'::date), ('2026-02-02'), ('2026-03-17'), ('2026-04-06'), ('2026-05-04'),
         ('2026-06-01'), ('2026-08-03'), ('2026-10-26'), ('2026-12-25'), ('2026-12-26'),
         ('2027-01-01'), ('2027-02-01'), ('2027-03-17'), ('2027-03-29'), ('2027-05-03'),
         ('2027-06-07'), ('2027-08-02'), ('2027-10-25'), ('2027-12-25'), ('2027-12-26')
),
candidates AS (
  SELECT
    r.id, r.profile_id, p.full_name, p.employment_type, r.status,
    r.start_date, r.end_date, r.total_days,
    extract(year FROM r.start_date)::int AS yr,
    days.*
  FROM public.time_off_requests r
  JOIN public.locations l ON l.id = r.location_id
  JOIN public.profiles p ON p.id = r.profile_id
  CROSS JOIN LATERAL (
    -- One row per WEEKDAY of the request. bank.d and (location_id, date) are
    -- both unique, so neither join can multiply a day.
    SELECT
      count(*) AS weekday_count,
      count(*) FILTER (WHERE b.d IS NOT NULL OR lh.id IS NOT NULL) AS holiday_count,
      coalesce(array_agg(g.day::date::text ORDER BY g.day) FILTER (WHERE b.d IS NOT NULL), '{}') AS bank_dates,
      coalesce(array_agg(g.day::date::text ORDER BY g.day) FILTER (WHERE lh.id IS NOT NULL), '{}') AS closure_dates,
      coalesce(array_agg(g.day::date::text ORDER BY g.day) FILTER (WHERE lh.created_at > r.created_at), '{}') AS closures_added_after_request
    FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') g(day)
    LEFT JOIN bank b ON b.d = g.day::date
    LEFT JOIN public.location_holidays lh ON lh.location_id = r.location_id AND lh.date = g.day::date
    WHERE extract(isodow FROM g.day) < 6
  ) days
  WHERE r.type = 'holiday'
    AND r.status IN ('approved', 'pending')
    AND r.created_at < :deploy_ts
    AND r.end_date >= '2026-01-01'
    AND coalesce(l.country, 'IE') = 'IE'
),
judged AS (
  SELECT
    c.*, sa.id AS allowance_id, sa.used_days,
    (coalesce(c.employment_type, 'fte') <> 'contractor'
       AND c.yr = extract(year FROM c.end_date)::int
       AND c.start_date >= '2026-01-01' AND c.end_date <= '2027-12-31'
       AND c.holiday_count > 0
       AND c.total_days = c.weekday_count
       AND (c.status = 'pending' OR sa.id IS NOT NULL)) AS will_fix
  FROM candidates c
  LEFT JOIN public.staff_allowances sa ON sa.profile_id = c.profile_id AND sa.year = c.yr
)
SELECT
  j.id, j.full_name, j.status, j.yr AS allowance_year, j.start_date, j.end_date,
  j.total_days AS current_total_days,
  j.weekday_count, j.holiday_count,
  j.bank_dates, j.closure_dates, j.closures_added_after_request,
  j.weekday_count - j.holiday_count AS proposed_total_days,
  j.will_fix,
  CASE
    WHEN coalesce(j.employment_type, 'fte') = 'contractor' THEN 'contractor: no allowance'
    WHEN j.yr <> extract(year FROM j.end_date)::int THEN 'straddles a year: look by hand'
    WHEN j.end_date > '2027-12-31' THEN 'after 2027: no bank-holiday list in this runbook, look by hand'
    WHEN j.total_days = j.weekday_count - j.holiday_count THEN 'already correct'
    WHEN j.total_days <> j.weekday_count THEN 'total_days is not the old Mon-Fri count: edited by hand or pre-ROSTER-FIX.2, look by hand'
    WHEN j.status = 'approved' AND j.allowance_id IS NULL THEN 'approved but no allowance row for that year: look by hand'
    ELSE 'old count, will be corrected'
  END AS note,
  j.used_days AS allowance_used_days_now,
  j.used_days - coalesce(sum(j.holiday_count) FILTER (WHERE j.will_fix AND j.status = 'approved')
                           OVER (PARTITION BY j.profile_id, j.yr), 0) AS allowance_used_days_after
FROM judged j
WHERE j.holiday_count > 0
ORDER BY j.full_name, j.start_date;
```

Before going on:

- Every `will_fix = true` row: `bank_dates` / `closure_dates` are the days coming
  off, and `proposed_total_days` is what a person would expect for those dates.
- **`closures_added_after_request` not empty** = the studio closure was created
  after the request was filed, so this is a retroactive deduction the coach was
  never promised. It is applied like any other closure. If that is not wanted
  for a row, stop here and have the statement narrowed; do not hand-edit after.
- `proposed_total_days = 0`: the whole request was a bank holiday. It will be
  set to 0 and the day returned; consider cancelling it in the app instead.
- `allowance_used_days_after` must never be negative. If it is, that allowance
  was edited by hand: stop and look (`GREATEST(0, …)` protects the column, but
  the person deserves a correct number).
- Rows whose `note` says "look by hand" are reported and never touched.
- The output contains staff names. The repo is **public**: never paste it into
  a PR, an issue or the changelog.

**Save it before doing anything else.** Write the full dry-run output, and the
`:deploy_ts` literal used, to a local file outside every git checkout (so not
under `~/code`), e.g. `~/Documents/un1t-ops/holidayleave-1/dry-run-<date>.json`.
The apply's `rollback_record` (section 3) goes beside it. Keep the folder until
**31 January 2028**, when the 2027 leave year is closed and carried over and
these numbers can no longer matter, then delete it: the dry run holds staff
names, so it is not kept for ever.

## 3. Apply (one statement, atomic) — once

One statement with data-modifying CTEs, deliberately: the SQL tool rolls back a
bare `begin;` that has no `commit;`, and a single statement commits itself with
both updates or neither.

```sql
WITH bank(d) AS (
  VALUES ('2026-01-01'::date), ('2026-02-02'), ('2026-03-17'), ('2026-04-06'), ('2026-05-04'),
         ('2026-06-01'), ('2026-08-03'), ('2026-10-26'), ('2026-12-25'), ('2026-12-26'),
         ('2027-01-01'), ('2027-02-01'), ('2027-03-17'), ('2027-03-29'), ('2027-05-03'),
         ('2027-06-07'), ('2027-08-02'), ('2027-10-25'), ('2027-12-25'), ('2027-12-26')
),
candidates AS (
  SELECT
    r.id, r.profile_id, r.status, r.total_days,
    extract(year FROM r.start_date)::int AS yr,
    days.weekday_count, days.holiday_count
  FROM public.time_off_requests r
  JOIN public.locations l ON l.id = r.location_id
  JOIN public.profiles p ON p.id = r.profile_id
  CROSS JOIN LATERAL (
    SELECT
      count(*) AS weekday_count,
      count(*) FILTER (WHERE b.d IS NOT NULL OR lh.id IS NOT NULL) AS holiday_count
    FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') g(day)
    LEFT JOIN bank b ON b.d = g.day::date
    LEFT JOIN public.location_holidays lh ON lh.location_id = r.location_id AND lh.date = g.day::date
    WHERE extract(isodow FROM g.day) < 6
  ) days
  WHERE r.type = 'holiday'
    AND r.status IN ('approved', 'pending')
    AND r.created_at < :deploy_ts
    AND r.start_date >= '2026-01-01' AND r.end_date <= '2027-12-31'
    AND extract(year FROM r.start_date) = extract(year FROM r.end_date)
    AND coalesce(l.country, 'IE') = 'IE'
    AND coalesce(p.employment_type, 'fte') <> 'contractor'
),
fixable AS (
  -- Only rows still holding the OLD formula's answer. An APPROVED row must
  -- already have the allowance row its day goes back to (it was charged to it).
  SELECT c.* FROM candidates c
   WHERE c.holiday_count > 0
     AND c.total_days = c.weekday_count
     AND (c.status = 'pending'
          OR EXISTS (SELECT 1 FROM public.staff_allowances sa
                      WHERE sa.profile_id = c.profile_id AND sa.year = c.yr))
),
fixed_requests AS (
  -- RACE SAFETY. `fixable` is this statement's snapshot. The UPDATE locks each
  -- row and, under READ COMMITTED, re-checks this WHERE against the row's
  -- LATEST committed version. A request approved, cancelled or edited after
  -- the snapshot no longer satisfies `r.status = f.status` /
  -- `r.total_days = f.total_days`, so it is SKIPPED whole (counted in
  -- skipped_changed_underneath) and the next run sees it in its new state.
  -- For every row that IS updated, the status the allowance was charged under
  -- is therefore the status returned here (r.status, the row as updated), and
  -- an approval or cancellation arriving later waits for this row lock and
  -- then reads total_days already corrected, so the trigger moves the right
  -- number. A row is never both corrected here and charged the old count.
  UPDATE public.time_off_requests r
     SET total_days = f.weekday_count - f.holiday_count,
         updated_at = now()
    FROM fixable f
   WHERE r.id = f.id
     AND r.status = f.status
     AND r.total_days = f.total_days
  RETURNING r.id, r.profile_id, r.status, f.yr, f.holiday_count, f.total_days AS old_total_days
),
fixed_allowances AS (
  -- Only APPROVED requests were ever charged, each to the allowance row of
  -- ITS year (the trigger keys on the year of start_date, as `yr` does). The
  -- new used_days is computed from the row's latest version, so an approval
  -- landing on the same allowance meanwhile is not lost.
  UPDATE public.staff_allowances sa
     SET used_days = GREATEST(0, sa.used_days - d.days_back),
         updated_at = now()
    FROM (SELECT profile_id, yr, sum(holiday_count) AS days_back
            FROM fixed_requests
           WHERE status = 'approved'
           GROUP BY profile_id, yr) d
   WHERE sa.profile_id = d.profile_id
     AND sa.year = d.yr
  RETURNING sa.id
)
SELECT
  (SELECT count(*) FROM fixed_requests)                                                  AS requests_corrected,
  (SELECT count(*) FROM fixed_requests WHERE status = 'pending')                         AS of_which_pending,
  (SELECT coalesce(sum(holiday_count), 0) FROM fixed_requests WHERE status = 'approved') AS allowance_days_returned,
  (SELECT count(*) FROM fixed_allowances)                                                AS allowance_rows_updated,
  (SELECT count(*) FROM fixable) - (SELECT count(*) FROM fixed_requests)                 AS skipped_changed_underneath,
  -- What this run REALLY changed (the dry run can differ: rows skipped, or
  -- approved in between). Ids and numbers only, no names. Input of the undo.
  (SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status, 'yr', yr, 'old', old_total_days, 'days_back', holiday_count))
     FROM fixed_requests)                                                                AS rollback_record;
```

**Save `rollback_record` immediately**, verbatim, as
`rollback-record-<date>.json` beside the dry run (section 2). It is the only
record of what was changed and the only input the undo accepts; it holds ids
and numbers, no names. It is `null` when the run corrected nothing. If you
apply more than once (section 4), save each run's record separately.

## 4. Prove it is done

Run the dry run (section 2) again with the same `:deploy_ts`. Expected: **zero
rows with `will_fix = true`**; the corrected rows now read `already correct`.
If `skipped_changed_underneath` was not 0, somebody approved, cancelled or
edited a request while the statement ran: those rows are still `will_fix` in
this dry run, read them and apply once more. A further apply on a finished
estate answers `0, 0, 0, 0, 0` and a `null` record.

Post the five numbers (numbers only, no names, not the record) as a **comment
on the PR**, and keep the local files. Do NOT edit the PR's changelog row to
add them: that row is already pushed, and `merge=union` on `docs/CHANGELOG.md`
turns an edited row into a duplicate.

## 5. Undo

Only if the correction itself turns out to be wrong. ONE self-committing
statement again. Replace `:rollback_record` with the saved JSON as a literal,
e.g. `'[{"id": "…", "status": "approved", "yr": 2026, "old": 5.0, "days_back": 1}]'::jsonb`
(one undo per saved record). Un-substituted it is a syntax error; a `null`
record is an error too, and means there was nothing to undo.

```sql
WITH rec AS (
  SELECT (e->>'id')::uuid          AS id,
         e->>'status'              AS status,
         (e->>'yr')::int           AS yr,
         (e->>'old')::numeric      AS old_total_days,
         (e->>'days_back')::numeric AS days_back
    FROM jsonb_array_elements(:rollback_record) e
),
restored AS (
  -- Same guards, same race argument as the apply: the row is locked and this
  -- WHERE is re-checked on its latest version. It is restored only while it is
  -- STILL in the status the apply recorded AND still holds the corrected value
  -- (old - days_back). Anything else is skipped and left as it is:
  --   approved -> cancelled/rejected since: the trigger already returned the
  --     corrected count, so the books balance. Re-charging would double-count.
  --   pending -> approved since: the trigger charged the corrected count and
  --     the row holds the corrected count. Consistent, nothing to restore.
  --   total_days edited since, or this undo already run: not ours to touch.
  UPDATE public.time_off_requests r
     SET total_days = rec.old_total_days,
         updated_at = now()
    FROM rec
   WHERE r.id = rec.id
     AND r.status = rec.status
     AND r.total_days = rec.old_total_days - rec.days_back
  RETURNING r.id, r.profile_id, r.status, rec.yr, rec.days_back
),
recharged AS (
  -- The mig 616 trigger fires on the UPDATE above and does nothing, because
  -- status did not change: so, as in the apply, the allowance is moved by
  -- hand, and only for rows recorded approved that are STILL approved (the
  -- guard above). A cancellation arriving later waits for the row lock and
  -- then returns the restored count, matching what is re-charged here.
  UPDATE public.staff_allowances sa
     SET used_days = sa.used_days + d.days_back,
         updated_at = now()
    FROM (SELECT profile_id, yr, sum(days_back) AS days_back
            FROM restored
           WHERE status = 'approved'
           GROUP BY profile_id, yr) d
   WHERE sa.profile_id = d.profile_id
     AND sa.year = d.yr
  RETURNING sa.id
)
SELECT
  (SELECT count(*) FROM restored)                                                  AS requests_restored,
  (SELECT count(*) FROM restored WHERE status = 'pending')                         AS of_which_pending,
  (SELECT coalesce(sum(days_back), 0) FROM restored WHERE status = 'approved')     AS allowance_days_recharged,
  (SELECT count(*) FROM recharged)                                                 AS allowance_rows_updated,
  (SELECT count(*) FROM rec) - (SELECT count(*) FROM restored)                     AS skipped;
```

`requests_restored + skipped` is the length of the record. A second run of the
same undo answers `0, 0, 0, 0, <length>`. For every skipped row, compare the
record with the row as it is now and decide by hand.

## Notes

- **Idempotence is two fences, not one.** A row is touched only while
  `total_days` still equals the old formula's answer (its plain Mon-Fri count),
  which a corrected row no longer does; and only if it was filed before
  `:deploy_ts`, which is what keeps a correctly-counted newer request out once a
  closure is added inside it. The first fence also skips anything edited by
  hand and any pre-ROSTER-FIX.2 row that counted weekends.
- **Why the allowance is adjusted by hand.** `trg_update_holiday_allowance`
  (mig 011, function replaced in mig 616) only acts when `status` changes to or
  from `approved`. Updating `total_days` on an approved row fires it and it does
  nothing. A pending row was never charged: fixing its `total_days` is what
  stops the over-charge when it IS approved.
- **2026 and 2027, keyed per (person, year).** Requests already on file reach
  into 2027 (the January half of a Christmas straddler holds Fri 1 Jan 2027).
  Generalising was chosen over a 2026-only fix plus a report, because the only
  change is the allowance key (`sa.year = yr` instead of `= 2026`), it is
  covered by the test, and the alternative leaves 2027 rows to be hand-edited,
  which is the riskier path. Both bank lists are copied from
  `src/lib/bank-holidays.js` and the test fails if they drift. Anything after
  2027, and any legacy row spanning two years, is reported and never touched.
- **2025 and earlier are out of scope** (`r.end_date >= '2026-01-01'`; no 2025
  list is embedded in the statements). That leave year is closed: its
  allowances have been settled and carried over, so handing a day back to a
  2025 row changes nothing anyone can take, and most 2025 rows pre-date
  ROSTER-FIX.2 and would fail the old-count test anyway.
- **Scope mirrors the code:** type `holiday`; studios whose `locations.country`
  is `IE` (or null, the route's default); contractors excluded (no allowance,
  mig 616; cannot file holiday, LEAVE.3); a closure counts only for the studio
  the request was filed at, as in `getNonWorkingDates`. Weekend bank holidays
  (Sat 26 Dec 2026) are in the list but were never charged: weekdays only.
- **Partial-day closures zero the whole day.** Mig 017 lets a studio record
  "Closed from 14:00" as a `location_holidays` row. For leave, here and in the
  route, any row on a date makes that date cost nothing. By design of
  HOLIDAYLEAVE.1: `total_days` has never carried a half day.
- **Assumes READ COMMITTED**, Postgres' and Supabase's default, which
  `execute_sql` does not change. The race argument in section 3 does not hold
  under REPEATABLE READ (there the statement would fail, not mis-charge).

## Known follow-up

- **The WEB leave form still previews calendar days.** `TimeOffManager.jsx`
  (~550) computes `totalDays` as end minus start plus one and flags
  "(exceeds balance)" against that number, while the server now charges fewer
  (weekends were already a mismatch; bank holidays and closures widen it). A
  coach can be warned off a request the server would accept. Not touched by
  HOLIDAYLEAVE.1: it is fixed by reusing the server-computed preview that the
  LEAVEPHONE.1 PR adds.
