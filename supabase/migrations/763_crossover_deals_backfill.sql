-- 763 — CROSSOVERDEAL.1: take the sibling-studio contacts off Stillorgan's
-- pipeline where they never did anything at Stillorgan.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Mig 758 (GLOFOXSIBLING.1) made the Stillorgan Glofox sync attach a Glofox
-- member whose one CRM contact lives at Hatch Street instead of dropping them.
-- The first sync after it (19 Oct 2026, 22:38 UTC) then did what it does for
-- every member it syncs: ran the pipeline classifier on the person's
-- STILLORGAN Glofox record and placed a deal on Stillorgan's board. For 13
-- Hatch clients that record was a race entry (PAYG lead) or an untouched free
-- trial, so 8 landed in Stillorgan's New Leads and 2 in Dormant, and were
-- cold-called as Stillorgan leads. 3 of the 13 had really trained, paid or
-- bought a pack at Stillorgan and keep their deal.
--
-- The code fix (src/lib/glofox-sync.js, hasActivityAtStudio) refuses the
-- create for a sibling-studio contact with no activity at the Glofox studio;
-- an existing deal there still moves. This file removes the deals that fix
-- would never have made. Apply it AFTER the code deploys, or the next nightly
-- sync makes them again.
--
-- ===========================================================================
-- WHAT
-- ===========================================================================
-- A removal, not status = 'lost': these rows were machine-made three days
-- ago, never moved, carry no note and no activity (notes.deal_id and
-- activities.deal_id are ON DELETE SET NULL regardless), and a 'lost' deal
-- would still count in Stillorgan's conversion figures. The predicate is the
-- rule, not a list of ids: an open deal on a Stillorgan board, for a contact
-- who lives at another studio and is linked here through
-- glofox_crossover_members, in a stage that means "nothing happened here"
-- (new_lead, dormant), with no class booking at Stillorgan and none of the
-- Glofox-sync stamps (attendance, conversion, pack). contacts.pipeline_stage_slug
-- reads only the contact's OWN studio's boards (mig 594 trigger), so a Hatch
-- contact's stage is untouched by this.

DO $$
DECLARE
  v_removed int;
BEGIN
  WITH victims AS (
    SELECT d.id
    FROM public.deals d
    JOIN public.pipeline_stages s ON s.id = d.stage_id
    JOIN public.contacts c ON c.id = d.contact_id
    JOIN public.glofox_crossover_members gx
      ON gx.contact_id = d.contact_id AND gx.location_id = d.location_id
    WHERE d.status = 'open'
      AND c.location_id <> d.location_id
      AND s.slug IN ('new_lead', 'dormant')
      AND c.last_attended_at IS NULL
      AND COALESCE(c.total_attended_30d, 0) = 0
      AND COALESCE(c.total_attended_7d, 0) = 0
      AND c.converted_at IS NULL
      AND c.pack_customer_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.class_bookings cb
        WHERE cb.contact_id = d.contact_id AND cb.location_id = d.location_id
      )
      AND NOT EXISTS (SELECT 1 FROM public.notes n WHERE n.deal_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.deal_id = d.id)
  ),
  gone AS (
    DELETE FROM public.deals d USING victims v WHERE d.id = v.id RETURNING d.id
  )
  SELECT count(*) INTO v_removed FROM gone;
  RAISE NOTICE 'mig 763: removed % sibling-studio deal(s) with no activity at the Glofox studio', v_removed;
END $$;
