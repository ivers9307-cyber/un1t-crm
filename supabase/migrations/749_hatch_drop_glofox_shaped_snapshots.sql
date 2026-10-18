-- 749 — UN1TRADAR.2: delete Hatch Street's Glofox-shaped snapshot history.
--
-- Spec B (docs/superpowers/specs/2026-10-17-hatch-radar-arrears-briefing-design.md)
-- §6 "Legacy rows", Claude's call 8: delete, not mark.
--
-- Hatch Street's members live in un1t.online, but until the membership read
-- seam (#2005 / #2072) the Glofox readers wrote snapshot rows for it from a
-- studio with no Glofox data: daily membership_snapshots from June to
-- 2026-10-17 (all zero), and weekly churn_radar_snapshots /
-- lead_radar_snapshots up to 2026-10-05. Those rows carry no information and
-- poison every reader that compares with "the latest" or "the oldest"
-- snapshot: the business trend chart (fetchMembershipTrend), loadRadar's
-- trend, the digest history, today-feed, business-rail's churn row,
-- business-kpis' churnPrev, account-home, and the briefing pulse comparator.
-- One delete fixes all of them; a source column would mean touching each.
--
-- The first un1t-shaped membership_snapshots row at Hatch is dated
-- 2026-10-18 (26 members, read-only check on 18 Oct 2026, equal to the un1t
-- adapter's membershipCounts). That date is the boundary: every Hatch
-- membership_snapshots row before it goes, and every Hatch radar snapshot
-- row (all dated 2026-10-05 or earlier).
--
-- DML only: no schema object is added or changed, so there is no grant
-- decision. The location is chosen by membership_source = 'un1t_online', never
-- by id, and the block refuses to run unless exactly one such location exists,
-- the boundary row is there, and no radar row at it is on or after the
-- boundary. Each count is reported with RAISE NOTICE, and a post-check refuses
-- to finish while any pre-boundary row is left. Safe to re-run: a second run
-- finds nothing to delete. Forward-only.
DO $$
DECLARE
  v_boundary   constant date := DATE '2026-10-18';
  v_locs       uuid[];
  v_loc        uuid;
  v_mem        integer;
  v_churn      integer;
  v_lead       integer;
BEGIN
  SELECT array_agg(id) INTO v_locs FROM public.locations WHERE membership_source = 'un1t_online';
  IF coalesce(array_length(v_locs, 1), 0) <> 1 THEN
    RAISE EXCEPTION 'mig 749: expected exactly one un1t_online location, found %', coalesce(array_length(v_locs, 1), 0);
  END IF;
  v_loc := v_locs[1];

  IF NOT EXISTS (
    SELECT 1 FROM public.membership_snapshots WHERE location_id = v_loc AND snapshot_date = v_boundary
  ) THEN
    RAISE EXCEPTION 'mig 749: no un1t-shaped membership_snapshots row dated 2026-10-18 at the un1t_online location';
  END IF;

  IF EXISTS (SELECT 1 FROM public.churn_radar_snapshots WHERE location_id = v_loc AND captured_at >= v_boundary)
     OR EXISTS (SELECT 1 FROM public.lead_radar_snapshots WHERE location_id = v_loc AND captured_at >= v_boundary) THEN
    RAISE EXCEPTION 'mig 749: a radar snapshot at the un1t_online location is on or after 2026-10-18; refusing to delete it';
  END IF;

  DELETE FROM public.churn_radar_snapshots WHERE location_id = v_loc AND captured_at < v_boundary;
  GET DIAGNOSTICS v_churn = ROW_COUNT;
  DELETE FROM public.lead_radar_snapshots WHERE location_id = v_loc AND captured_at < v_boundary;
  GET DIAGNOSTICS v_lead = ROW_COUNT;
  DELETE FROM public.membership_snapshots WHERE location_id = v_loc AND snapshot_date < v_boundary;
  GET DIAGNOSTICS v_mem = ROW_COUNT;

  IF EXISTS (SELECT 1 FROM public.churn_radar_snapshots WHERE location_id = v_loc AND captured_at < v_boundary)
     OR EXISTS (SELECT 1 FROM public.lead_radar_snapshots WHERE location_id = v_loc AND captured_at < v_boundary)
     OR EXISTS (SELECT 1 FROM public.membership_snapshots WHERE location_id = v_loc AND snapshot_date < v_boundary) THEN
    RAISE EXCEPTION 'mig 749: rows before 2026-10-18 remain at the un1t_online location after the delete';
  END IF;

  RAISE NOTICE 'mig 749: deleted % membership_snapshots, % churn_radar_snapshots, % lead_radar_snapshots rows at the un1t_online location',
    v_mem, v_churn, v_lead;
END
$$;
