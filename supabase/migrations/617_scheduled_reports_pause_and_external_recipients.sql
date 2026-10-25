-- 617 — REPORTS.2: scheduled reports can be paused, and a staff_cost
-- schedule records which recipient addresses the owner confirmed as external.
--
-- WHY A NEW `paused` COLUMN (and not `active`)
-- ────────────────────────────────────────────
-- `active = false` already means DELETED: DELETE /api/schedule/reports/scheduled
-- deactivates rather than removing the row (generated_reports keeps its
-- scheduled_report_id), and the cron flips a finished 'once' schedule to
-- inactive. A pause has to be reversible and has to stay listed, so reusing
-- `active` would make a paused schedule indistinguishable from a deleted one.
-- The cron skips `paused = true`; the list hides `active = false`.
--
-- WHY `confirmed_external_recipients`
-- ───────────────────────────────────
-- A staff_cost report carries the studio's pay figures. STAFFCOST.1 emails it
-- to a recipient that matches a staff profile only when that person may see
-- rates at the location, but an address matching NO profile was sent
-- unconditionally, so a head coach's personal address slipped through. From
-- REPORTS.2 an unmatched address is sent only if the owner/manager who saved
-- the schedule confirmed it as external; this column is that per-recipient
-- record (lower-cased addresses, a subset of email_recipients).
--
-- Existing rows (prod, 17 Sep: ONE staff_cost schedule, one recipient that
-- matches no profile, never run) are treated as confirmed: it was set up on
-- purpose by an owner under the old rule, and breaking it silently on 1 Oct
-- would be the wrong way to introduce the new one. The backfill copies every
-- staff_cost row's recipients. An address in this list that DOES match a
-- staff profile gains nothing — the profile rule is checked first.
--
-- Forward-only, additive; no RLS or grant change (both columns ride the
-- table's existing policies, and every read/write goes through service-role
-- routes that gate in app code).

ALTER TABLE public.scheduled_reports
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.scheduled_reports
  ADD COLUMN IF NOT EXISTS confirmed_external_recipients text[] NOT NULL DEFAULT '{}';

UPDATE public.scheduled_reports
   SET confirmed_external_recipients = ARRAY(
         SELECT DISTINCT lower(btrim(r))
           FROM unnest(coalesce(email_recipients, '{}')) AS r
          WHERE btrim(r) <> ''
       )
 WHERE report_type = 'staff_cost';

COMMENT ON COLUMN public.scheduled_reports.paused IS
  'REPORTS.2 (mig 617) — true = the cron skips this schedule. Distinct from active=false, which means deleted.';
COMMENT ON COLUMN public.scheduled_reports.confirmed_external_recipients IS
  'REPORTS.2 (mig 617) — lower-cased recipient addresses the owner confirmed as external (matching no staff profile). A rate-bearing report is emailed to an unmatched address only if it is listed here.';
