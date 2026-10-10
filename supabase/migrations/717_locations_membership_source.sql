-- 717 — W1.M1: which system is the source of truth for MEMBERSHIPS at a
-- location (SaaS Wave 1, Track M; plan
-- docs/superpowers/plans/2026-10-10-saas-wave1-identity.md).
--
-- WHY. Glofox was the only membership source and nothing said so: a gym
-- without Glofox got empty radars, a zero trend and a classifier that keyed
-- on glofox_* columns (SaaS review 2026-10-09 §1, theme E). Five crons found
-- Glofox locations by sniffing settings->'glofox' and five different code
-- tests disagreed about "connected". One column, read by one resolver
-- (src/lib/membership/source.js), answers it.
--
-- VALUES. 'none' (lead CRM only), 'glofox' (today), 'un1t' (the home-grown
-- source, arriving: admitted now so it plugs in with NO schema change — its
-- provider module registers itself in code). The CHECK is the whole
-- contract; adding a fourth source later is a new migration by design.
--
-- BACKFILL. 'glofox' where a REAL connection exists, judged the way the
-- runtime judges it (missingGlofoxCredentialsForLocation: branch id, API
-- key AND API token): an active registry row (channel_connections,
-- platform='glofox', migs 230/418/419: branch_id → external_account_id,
-- api_key → access_token, api_token → config->>'api_token') holding all
-- three, or the legacy settings->'glofox' slice holding all three. Live on
-- 2026-10-10 that is exactly UN1T Stillorgan; Hatch Street and CCF Autos
-- carry a slice with no branch id and stay 'none'. Every other location
-- stays 'none' (the column default).
--
-- GRANT. SELECT for authenticated: the phone's Studio tab and the browser
-- gate on it, and it is not a secret (locations is column-granted since
-- mig 648; a new column is invisible to clients until granted, and a
-- PostgREST select naming it would fail WHOLE). No UPDATE grant: writes go
-- through PUT /api/locations/[id]/membership-source (W1.M2), service role.
-- tests/helpers/credential-column-grants.js lists the column under select.
--
-- Replay-safe: ADD COLUMN IF NOT EXISTS, a backfill that only promotes
-- 'none' rows, an idempotent GRANT. The self-check at the end reads the
-- catalog (never this file's text) and aborts the whole file on a miss.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS membership_source text NOT NULL DEFAULT 'none'
    CONSTRAINT locations_membership_source_check CHECK (membership_source IN ('none', 'glofox', 'un1t'));

UPDATE public.locations l
   SET membership_source = 'glofox'
 WHERE l.membership_source = 'none'
   AND (
     EXISTS (
       SELECT 1 FROM public.channel_connections c
        WHERE c.location_id = l.id
          AND c.platform = 'glofox'
          AND c.is_active = true
          AND coalesce(c.external_account_id, '') <> ''
          AND coalesce(c.access_token, '') <> ''
          AND coalesce(c.config->>'api_token', '') <> ''
     )
     OR (
       coalesce(l.settings->'glofox'->>'branch_id', '') <> ''
       AND coalesce(l.settings->'glofox'->>'api_key', '') <> ''
       AND coalesce(l.settings->'glofox'->>'api_token', '') <> ''
     )
   );

GRANT SELECT (membership_source) ON public.locations TO authenticated;

COMMENT ON COLUMN public.locations.membership_source IS
  'W1.M1 (mig 717) — none | glofox | un1t. The ONE answer to "where do memberships come from"; resolved by src/lib/membership/source.js. Written only by PUT /api/locations/[id]/membership-source.';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_glofox integer;
BEGIN
  IF NOT has_column_privilege('authenticated', 'public.locations', 'membership_source', 'SELECT') THEN
    RAISE EXCEPTION 'W1.M1: authenticated cannot read locations.membership_source';
  END IF;
  IF has_column_privilege('authenticated', 'public.locations', 'membership_source', 'UPDATE')
     OR has_column_privilege('anon', 'public.locations', 'membership_source', 'SELECT') THEN
    RAISE EXCEPTION 'W1.M1: a client role holds a privilege on locations.membership_source it must not';
  END IF;
  -- The table-level grants mig 648 removed must still be gone, or the column
  -- grant above binds nothing.
  IF has_table_privilege('authenticated', 'public.locations', 'SELECT')
     OR has_table_privilege('anon', 'public.locations', 'SELECT') THEN
    RAISE EXCEPTION 'W1.M1: a table-level SELECT on public.locations survived for a client role (mig 648)';
  END IF;
  SELECT count(*) INTO n_glofox FROM public.locations WHERE membership_source = 'glofox';
  RAISE NOTICE 'W1.M1 mig 717: locations.membership_source added; % location(s) backfilled to glofox.', n_glofox;
END $$;
