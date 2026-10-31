-- 796 — GLOFOXPRIVATE.1: the Glofox catalogue learns private memberships.
--
-- Glofox's GET /2.0/memberships returns only PUBLIC memberships: a membership
-- with the dashboard's "Private" toggle on (hidden from the member app's shop)
-- is left out of the list, so the nightly catalogue refresh (mig 233) never
-- saw it and the trial-plan pickers (Settings → Glofox, the landing-page offer
-- rows) could not offer it. Verified live 2026-10-31 on Stillorgan:
-- "1) The Elites Trial" (68b17bbd4e9e83430f0ddcdc, 16 members on it) is absent
-- from the list, while GET /2.0/memberships/{id} answers 200 with
-- private:true, active:true and its one plan (code 1756461990251).
--
-- So the sync now records every membership id it meets on a member record
-- (member.membership._id on the single-member GET: webhooks, the detail
-- backfill, the attendance refresh, the desk re-sync) by reading it by id,
-- and the pickers list the live public set plus the learned private ones.
--
-- Rows written before this migration all came from the list: public.
ALTER TABLE public.glofox_memberships
  ADD COLUMN IF NOT EXISTS private boolean,
  ADD COLUMN IF NOT EXISTS discovered_via text;

UPDATE public.glofox_memberships
   SET private = false, discovered_via = 'list'
 WHERE private IS NULL;

COMMENT ON COLUMN public.glofox_memberships.private IS
  'Glofox "Private" toggle: hidden from the member app and from GET /2.0/memberships, readable by id. false for rows the list returned.';
COMMENT ON COLUMN public.glofox_memberships.discovered_via IS
  'list = GET /2.0/memberships (the nightly refresh); member_detail = learned from member.membership._id through GET /2.0/memberships/{id}.';

-- No grant decision: the table holds table-level SELECT for authenticated
-- (mig 233; writes are denied by mig 485's restrictive policies), so the two
-- new columns are read by the same sessions and written only by the service
-- role.
