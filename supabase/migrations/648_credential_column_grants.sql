-- 648 — SECFIX.3c: no signed-in person's own Supabase session reads a stored
-- integration credential.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 28 Sep 2026).
-- It is the evidence for the fix, not proof the fix landed. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-648-credential-column-grants.test.js).
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- Five tables hold stored integration credentials and still carry Supabase's
-- default table-level ALL for `authenticated` AND `anon`. Their RLS admits
-- every member of the studio, so a plain staff member's own JWT plus one
-- hand-written PostgREST call reads them:
--   locations            sensibo_api_key, thinq_pat, settings (Glofox
--                        api_key/api_token/webhook_secret, UniFi api_token)
--   channel_connections  access_token, app_secret, config->>'api_token'
--   whatsapp_numbers     access_token (the Meta system-user token)
--   xero_connections     access_token, refresh_token — and staff may INSERT,
--                        UPDATE and DELETE it (policies TO public,
--                        auth_is_in_location)
--   contact_external_integrations  members' Strava access/refresh tokens
--                        (and a member may UPDATE any column of their own row)
--
-- VERIFIED LIVE (28 Sep, BEFORE this migration):
--   relacl on all five: anon=arwdDxtm, authenticated=arwdDxtm. No column ACLs.
--   No PUBLIC grant. None is in supabase_realtime. No view depends on them.
--   Column lists as classified below (re-read 28 Sep: locations 39 columns,
--   contact_external_integrations 14).
--   As a plain `staff` member at Stillorgan (SET LOCAL ROLE authenticated +
--   their JWT sub, counts only, rolled back): 1 Sensibo key, 1 ThinQ PAT,
--   the Glofox credentials and UniFi token in settings, 5 connection
--   access_tokens + 2 app_secrets + 1 config api_token, 1 WhatsApp token,
--   1 Xero token pair, 2 members' Strava tokens.
--   anon: every policy on these tables calls private.* and anon has no USAGE
--   on schema private, so anon ERRORS today (fenced by accident, not grant).
--   Policies on OTHER tables that join locations as the invoking user (16:
--   organizations, org_settings, chooser_settings, contracts,
--   contract_templates, contract_template_versions, zoom_sync_runs,
--   storage.objects) read l.id and l.organization_id only. No policy on
--   another table references the other four tables.
--
-- ===========================================================================
-- THE FIX — table-level REVOKE ALL, then column GRANTs (allow-lists)
-- ===========================================================================
-- A column-level REVOKE alone is a NO-OP while a table-level grant exists
-- (mig 153 → 153b). The table-level REVOKE is what makes a column grant bind.
--
--   locations   SELECT: id, name, slug, address, phone, email, timezone,
--                 active, created_at, updated_at, country, features,
--                 organization_id, is_host_anchor
--                 (the public identity the API already serves every staff
--                 member, + the organization key that the organizations /
--                 org_settings / chooser_settings / contracts / storage
--                 policies join on as the invoking user)
--               UPDATE: name, slug, address, phone, email, timezone, country,
--                 active, monthly_contractor_budget_eur, invoices_inbound_slug,
--                 updated_at, car_deposit_default_amount, car_deposit_terms,
--                 car_deposit_terms_version, car_deposit_receipt_sms_enabled
--                 (exactly what LocationForm's edit and CarDepositSettings
--                 write from the browser; RLS locations_upd still limits it to
--                 owner-at / master. NOT organization_id: an owner could
--                 otherwise re-parent a studio into another organisation)
--               withheld: settings and every credential / configuration
--                 column (25)
--   contact_external_integrations
--               SELECT: id, contact_id, provider, external_athlete_id,
--                 auto_export_enabled, connected_at, disconnected_at,
--                 last_export_at, last_error
--               UPDATE: auto_export_enabled, disconnected_at
--               withheld: access_token, refresh_token, expires_at, scopes,
--                 import_backfilled_at
--   channel_connections, whatsapp_numbers, xero_connections
--               nothing (no browser or phone code reads or writes them;
--               every UI goes through masked service-role routes)
--   anon        nothing on any of the five.
--
-- UPDATE without SELECT on the same column is a legal blind write; the two
-- forms never read their columns back (they hold them from server props).
-- INSERT, DELETE, TRUNCATE, REFERENCES and TRIGGER are revoked outright: no
-- client inserts or deletes these rows (location create is POST
-- /api/locations; every connection write is a service-role route).
--
-- A GRANT is per ROLE, not per person: owners and masters lose the same
-- direct reads. Every surface of theirs that shows these columns is a
-- service-role route or page, which bypasses grants as it bypasses RLS.
--
-- A column ADDED to locations or contact_external_integrations later is
-- invisible to clients until a migration grants it (or says it is withheld).
-- tests/credential-column-grants-guard.test.js fails such a migration, any
-- later table-level grant on these five tables to a client role, and any
-- client select that names a withheld column (PostgREST refuses the WHOLE
-- select with 42501).
--
-- NOT CHANGED: policies, triggers (all SECURITY DEFINER), the private.*
-- helpers, service_role.
--
-- ===========================================================================
-- CONSUMERS CHECKED (origin/main + SECFIX.3b, 28 Sep)
-- ===========================================================================
--   * phone: shared/dashboard-data.js `locations:location_id ( id, name )`
--     (every bundle since 2 May); mobile member integrations screen: 8 of the
--     9 cei SELECT columns (+ contact_id / disconnected_at filters) and the
--     two updates (since #1435). No OTA needed.
--   * browser: LocationForm (update + select('id'), no organization_id),
--     CarDepositSettings (update, no select). The Glofox / UniFi / Twilio / AC
--     tabs save through PUT /api/locations/[id]/integrations/[provider]
--     (SECFIX.3b, C24). Nothing else in client code names these tables.
--   * champ-app: the same cei select + updates (cookie/browser client); its
--     locations / cei token reads are service-role.
--   * policies on other tables read locations.id / organization_id only.
--   * no SECURITY INVOKER function over these tables is client-executable.
--
-- ===========================================================================
-- APPLY: AFTER SECFIX.3b is deployed and this PR merges. Pre/post probes and
-- the rollback are in
-- docs/superpowers/plans/2026-09-27-followups/C35-SECFIX.3.md (Task 3c-5).
-- ===========================================================================

BEGIN;

-- Order matters: a column GRANT binds only once the table-level grant is gone.
REVOKE ALL ON public.locations FROM authenticated, anon;
REVOKE ALL ON public.contact_external_integrations FROM authenticated, anon;
REVOKE ALL ON public.channel_connections FROM authenticated, anon;
REVOKE ALL ON public.whatsapp_numbers FROM authenticated, anon;
REVOKE ALL ON public.xero_connections FROM authenticated, anon;

GRANT SELECT (id, name, slug, address, phone, email, timezone, active, created_at, updated_at, country, features, organization_id, is_host_anchor) ON public.locations TO authenticated;
GRANT UPDATE (name, slug, address, phone, email, timezone, country, active, monthly_contractor_budget_eur, invoices_inbound_slug, updated_at, car_deposit_default_amount, car_deposit_terms, car_deposit_terms_version, car_deposit_receipt_sms_enabled) ON public.locations TO authenticated;
GRANT SELECT (id, contact_id, provider, external_athlete_id, auto_export_enabled, connected_at, disconnected_at, last_export_at, last_error) ON public.contact_external_integrations TO authenticated;
GRANT UPDATE (auto_export_enabled, disconnected_at) ON public.contact_external_integrations TO authenticated;

COMMENT ON COLUMN public.locations.settings IS
  'Holds integration credentials (glofox.api_key/api_token/webhook_secret, unifi.api_token) beside config. No SELECT/UPDATE for authenticated/anon (SECFIX.3c, mig 648). Serve slices through a service-role route; never hand a raw row to a client component (redactLocationSecrets).';
COMMENT ON COLUMN public.locations.sensibo_api_key IS 'Credential. No client SELECT/UPDATE (mig 648). Write through PUT /api/locations/[id]/integrations/ac.';
COMMENT ON COLUMN public.locations.thinq_pat IS 'Credential. No client SELECT/UPDATE (mig 648). Write through PUT /api/locations/[id]/integrations/ac.';
COMMENT ON COLUMN public.channel_connections.access_token IS 'Credential. No client privilege on this table (mig 648); read via service-role routes that mask (maskConnectionRow).';
COMMENT ON COLUMN public.whatsapp_numbers.access_token IS 'Meta system-user token. No client privilege on this table (mig 648).';
COMMENT ON COLUMN public.xero_connections.access_token IS 'Xero OAuth token. No client privilege on this table (mig 648).';
COMMENT ON COLUMN public.contact_external_integrations.access_token IS 'Member''s third-party (Strava) token. Withheld from authenticated (mig 648).';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  spec record;
  t text;
  r text;
  actual text;
  expected text;
  unknown_cols text;
  col text;
BEGIN
  -- A. The three tables no client may touch at all.
  FOREACH t IN ARRAY ARRAY['channel_connections', 'whatsapp_numbers', 'xero_connections'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF has_table_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'SECFIX.3c: % still holds a privilege on public.%', r, t;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM information_schema.table_privileges
                WHERE table_schema = 'public' AND table_name = t AND grantee = 'PUBLIC')
       OR EXISTS (SELECT 1 FROM information_schema.column_privileges
                   WHERE table_schema = 'public' AND table_name = t AND grantee = 'PUBLIC') THEN
      RAISE EXCEPTION 'SECFIX.3c: PUBLIC holds a privilege on public.%', t;
    END IF;
  END LOOP;

  -- B. The two column-granted tables.
  FOR spec IN
    SELECT * FROM (VALUES
      ('locations',
       ARRAY['id','name','slug','address','phone','email','timezone','active','created_at','updated_at','country','features','organization_id','is_host_anchor'],
       ARRAY['name','slug','address','phone','email','timezone','country','active','monthly_contractor_budget_eur','invoices_inbound_slug','updated_at','car_deposit_default_amount','car_deposit_terms','car_deposit_terms_version','car_deposit_receipt_sms_enabled'],
       ARRAY['settings','sensibo_api_key','thinq_pat','thinq_client_id','thinq_country_code','sensibo_pod_id','ac_default_mode','ac_default_temp','ac_default_fan','ac_session_minutes','twilio_alpha_sender_id','bca_config','notification_config','churn_digest_recipients','monthly_contractor_budget_eur','invoices_inbound_slug','email_inbox_reply_to','dunning_sequence_id','dunning_auto_enroll','glofox_auto_cancel_memberships','car_deposit_default_amount','car_deposit_terms','car_deposit_terms_version','car_deposit_whatsapp_template_id','car_deposit_receipt_sms_enabled']),
      ('contact_external_integrations',
       ARRAY['id','contact_id','provider','external_athlete_id','auto_export_enabled','connected_at','disconnected_at','last_export_at','last_error'],
       ARRAY['auto_export_enabled','disconnected_at'],
       ARRAY['access_token','refresh_token','expires_at','scopes','import_backfilled_at'])
    ) AS v(tbl, sel, upd, withheld)
  LOOP
    -- 1. Every column is classified. A column this file does not know (added
    --    on prod since 28 Sep) would be silently withheld; stop instead.
    SELECT string_agg(a.attname::text, ', ' ORDER BY a.attname) INTO unknown_cols
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || spec.tbl)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname::text <> ALL (spec.sel || spec.withheld);
    IF unknown_cols IS NOT NULL THEN
      RAISE EXCEPTION 'SECFIX.3c: public.% has column(s) this migration does not classify: %', spec.tbl, unknown_cols;
    END IF;

    -- 2. No table-level privilege of any kind for either client role.
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF has_table_privilege(r, 'public.' || spec.tbl, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'SECFIX.3c: table-level privilege on public.% survived for % — a column grant would not bind', spec.tbl, r;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM information_schema.table_privileges
                WHERE table_schema = 'public' AND table_name = spec.tbl AND grantee = 'PUBLIC') THEN
      RAISE EXCEPTION 'SECFIX.3c: PUBLIC holds a table-level privilege on public.%', spec.tbl;
    END IF;

    -- 3. authenticated's SELECT and UPDATE column lists are exact.
    SELECT string_agg(column_name::text, ', ' ORDER BY column_name) INTO actual
      FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = spec.tbl AND grantee = 'authenticated' AND privilege_type = 'SELECT';
    SELECT string_agg(c, ', ' ORDER BY c) INTO expected FROM unnest(spec.sel) AS c;
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'SECFIX.3c: public.% SELECT for authenticated is [%], expected [%]', spec.tbl, coalesce(actual, '(none)'), expected;
    END IF;
    SELECT string_agg(column_name::text, ', ' ORDER BY column_name) INTO actual
      FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = spec.tbl AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
    SELECT string_agg(c, ', ' ORDER BY c) INTO expected FROM unnest(spec.upd) AS c;
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'SECFIX.3c: public.% UPDATE for authenticated is [%], expected [%]', spec.tbl, coalesce(actual, '(none)'), expected;
    END IF;

    -- 4. No INSERT/REFERENCES column grant; nothing at all for anon / PUBLIC.
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name = spec.tbl
                  AND (grantee IN ('anon', 'PUBLIC')
                       OR (grantee = 'authenticated' AND privilege_type IN ('INSERT', 'REFERENCES')))) THEN
      RAISE EXCEPTION 'SECFIX.3c: an unexpected column grant remains on public.%', spec.tbl;
    END IF;

    -- 5. Inheritance-aware (information_schema filters on role NAMES only).
    FOREACH col IN ARRAY spec.withheld LOOP
      IF has_column_privilege('authenticated', 'public.' || spec.tbl, col, 'SELECT')
         OR has_column_privilege('anon', 'public.' || spec.tbl, col, 'SELECT') THEN
        RAISE EXCEPTION 'SECFIX.3c: withheld column %.% is still readable by a client role', spec.tbl, col;
      END IF;
    END LOOP;
    FOREACH col IN ARRAY spec.sel LOOP
      IF NOT has_column_privilege('authenticated', 'public.' || spec.tbl, col, 'SELECT') THEN
        RAISE EXCEPTION 'SECFIX.3c: granted column %.% is not readable by authenticated', spec.tbl, col;
      END IF;
      IF has_column_privilege('anon', 'public.' || spec.tbl, col, 'SELECT') THEN
        RAISE EXCEPTION 'SECFIX.3c: column %.% is readable by anon', spec.tbl, col;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'SECFIX.3c mig 648: locations + contact_external_integrations column-granted; channel_connections, whatsapp_numbers, xero_connections closed to clients; anon holds nothing.';
END $$;

COMMIT;
