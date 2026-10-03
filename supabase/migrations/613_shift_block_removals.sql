-- 613 — SLOTREMOVAL.1: a deleted shift slot stays deleted.
--
-- THE FINDING
-- ───────────
-- "Delete this slot" (DELETE /api/schedule/blocks/[id]) removed the
-- shift_blocks row and recorded nothing. Every generated block comes from a
-- template, and the nightly horizon sweep (extendRosterHorizon ->
-- generateBlocksForTemplate) upserts (location_id, template_id, block_date)
-- with ignoreDuplicates for every date the template runs, so a missing row
-- reads as "not generated yet" and the slot came straight back. Consultation
-- slots deleted on 11 Sep were re-created the next night. COPYMODES.1's exact
-- copy re-created them the same way from the source week.
--
-- THE FIX
-- ───────
-- A tombstone per deleted (location, template, date). The generator and both
-- copy modes skip a slot that has one; creating the block again by hand
-- (POST /api/schedule/blocks) deletes it, which is the undo.
--
-- Rows cascade with their template (and location), so deactivating or
-- deleting a template needs no cleanup here.
--
-- SHAPE RULES (CLAUDE.md): PERMISSIVE only; one policy per (table, command);
-- never FOR ALL; TO authenticated. No UPDATE policy on purpose: a removal is
-- written or withdrawn, never edited. Every app path is service-role (RLS
-- bypass); the policies fence a browser/mobile client only.
--
-- NOT APPLIED BY THE PR — applied via Supabase MCP after merge.
-- POST-APPLY CHECK:
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'shift_block_removals';
--   -- expect exactly SELECT / INSERT / DELETE, each {authenticated}
--   then get_advisors (security + performance), expecting nothing new.

BEGIN;

CREATE TABLE IF NOT EXISTS public.shift_block_removals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.shift_templates(id) ON DELETE CASCADE,
  block_date  date NOT NULL,
  removed_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  removed_at  timestamptz NOT NULL DEFAULT now(),
  reason      text,
  CONSTRAINT shift_block_removals_slot_key UNIQUE (location_id, template_id, block_date)
);

-- The generator's read is "this template, this date window"; the unique key
-- leads with location_id, so it can't serve that (or the template FK).
CREATE INDEX IF NOT EXISTS shift_block_removals_template_date_idx
  ON public.shift_block_removals (template_id, block_date);

-- Covers the removed_by FK (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS shift_block_removals_removed_by_idx
  ON public.shift_block_removals (removed_by)
  WHERE removed_by IS NOT NULL;

ALTER TABLE public.shift_block_removals ENABLE ROW LEVEL SECURITY;

-- anon has no business here; the policies below are TO authenticated anyway.
REVOKE ALL ON public.shift_block_removals FROM anon;

DROP POLICY IF EXISTS "shift_block_removals_select" ON public.shift_block_removals;
CREATE POLICY "shift_block_removals_select" ON public.shift_block_removals
  FOR SELECT TO authenticated
  USING (private.auth_is_manager_at(location_id));

DROP POLICY IF EXISTS "shift_block_removals_insert" ON public.shift_block_removals;
CREATE POLICY "shift_block_removals_insert" ON public.shift_block_removals
  FOR INSERT TO authenticated
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    AND (removed_by IS NULL OR removed_by = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "shift_block_removals_delete" ON public.shift_block_removals;
CREATE POLICY "shift_block_removals_delete" ON public.shift_block_removals
  FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));

COMMENT ON TABLE public.shift_block_removals IS
  'SLOTREMOVAL.1 (mig 613) — one row per shift slot (location, template, date) a manager deleted. '
  'The nightly roster horizon generator and roster copies skip these slots so a deleted slot is not '
  're-created; manually creating the block again deletes the row. Cascades with the template.';

COMMIT;
