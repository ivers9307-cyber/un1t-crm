-- 728 — UN1TNEXT.4: retire the hand-imported un1t.online membership rows
-- (roadmap docs/superpowers/plans/2026-10-17-un1t-online-followups.md, P0.4).
--
-- WHY. Before the API sync (#2068), Hatch Street's memberships came from an
-- operator-run import of the un1t.online client export (mig 722,
-- contact_memberships.source = 'un1t_online_export'). Nothing re-runs that
-- import, so those rows never change: when a member cancels, the sync ends its
-- 'un1t_online_api' row but the export row stays 'active' for ever, and
-- member-validation.js (event pricing) and the contact page's memberships card
-- keep treating them as a member. On 2026-10-17 all 20 active export rows had
-- an active 'un1t_online_api' row for the same contact and studio.
--
-- WHAT. End (never delete) every ACTIVE export row whose contact holds an
-- ACTIVE api row at the same location: status 'ended', ended_at now(). History
-- is kept and the change is reversible. Rows already ended are untouched.
--
-- FAIL CLOSED. If any active export row has NO active api replacement, the
-- whole file aborts and nothing changes: ending it would drop a real member's
-- pricing. Investigate that contact first (the sync may not have matched it).
-- On a fresh database (no export rows) this is a no-op.
--
-- Do not re-run the un1t.online export import: the API sync supersedes it.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  uncovered integer;
BEGIN
  SELECT count(*) INTO uncovered
    FROM public.contact_memberships e
   WHERE e.source = 'un1t_online_export'
     AND e.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.contact_memberships a
        WHERE a.contact_id  = e.contact_id
          AND a.location_id = e.location_id
          AND a.source      = 'un1t_online_api'
          AND a.status      = 'active');
  IF uncovered > 0 THEN
    RAISE EXCEPTION 'mig 728: % active un1t_online_export row(s) have no active un1t_online_api replacement; refusing to end any', uncovered;
  END IF;
END $$;

UPDATE public.contact_memberships e
   SET status     = 'ended',
       ended_at   = now(),
       updated_at = now()
 WHERE e.source = 'un1t_online_export'
   AND e.status = 'active'
   AND EXISTS (
     SELECT 1 FROM public.contact_memberships a
      WHERE a.contact_id  = e.contact_id
        AND a.location_id = e.location_id
        AND a.source      = 'un1t_online_api'
        AND a.status      = 'active');

-- Self-check: no active export row is left.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.contact_memberships
              WHERE source = 'un1t_online_export' AND status = 'active') THEN
    RAISE EXCEPTION 'mig 728: an active un1t_online_export row survived';
  END IF;
END $$;

COMMIT;
