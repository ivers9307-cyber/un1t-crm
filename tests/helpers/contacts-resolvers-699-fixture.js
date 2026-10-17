// The prod state of 2 Oct 2026 with migs 690 and 691 applied, as the SEC-3
// replay (tests/migration-699-sec-3.test.js) built it: post-677 privileges,
// the 690/691 inputs, profile_organizations as prod has it, the pre-690/691
// policies and function bodies VERBATIM, then the REAL 690 and 691 files.
// Moved here unchanged from the 699 test (UN1TDUAL.1) so the mig 731 replay
// (tests/migration-731-contacts-read-by-membership.test.js) builds on exactly
// the same state instead of a second copy. Fictional ids only: the repo is
// public.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, IDS } from './member-write-sweep.js'
import { KEY_BUNDLES } from '../../shared/permission-bundles.js'

export const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../../supabase/migrations', f), 'utf8')
export const MIG_690 = mig('690_contacts_read_needs_contacts_permission.sql')
export const MIG_691 = mig('691_mobile_permissions_follow_role_templates.sql')

export const { LOC_A, LOC_B } = IDS
export const LOC_C = 'c0000000-0000-0000-0000-00000000000c'   // ORG1, inactive
export const LOC_D = 'd0000000-0000-0000-0000-00000000000d'   // ORG2
export const ORG1 = 'f0000000-0000-0000-0000-000000000001'
export const ORG2 = 'f0000000-0000-0000-0000-000000000002'
export const ORG_ADMIN = '10000000-0000-0000-0000-0000000000a1'        // org admin of ORG1, no membership
export const ORG_ADMIN_STAFF = '10000000-0000-0000-0000-0000000000a2'  // org admin of ORG1, explicit staff at B
export const PHONE = ['activities', 'bookings', 'deals', 'notes', 'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates']
export const POLICY_KEYS = { activities: 'act', bookings: 'bookings', deals: 'pipeline', notes: 'pipeline' }
export const WA_POLICY = { whatsapp_conversations: 'wa_conv_select', whatsapp_messages: 'wa_msg_select', whatsapp_templates: 'wa_tmpl_select' }

// Pre-691 bodies, verbatim from prod (migs 626 / 550; as in the 691 replay).
export const MOBILE_CAN_FOR_626 = `
  SELECT loc_id IS NOT NULL
    AND coalesce((SELECT (features -> perm_key) <> 'false'::jsonb FROM public.locations WHERE id = loc_id), true)
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_uid
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations pl
            WHERE pl.profile_id = p_uid AND pl.location_id = loc_id
              AND CASE
                WHEN pl.permissions -> 'mobile' ? perm_key
                  THEN (pl.permissions -> 'mobile' ->> perm_key) = 'true'
                ELSE coalesce((SELECT d.allowed FROM private.mobile_permission_defaults d
                               WHERE d.role = pl.role AND d.key = perm_key), false)
              END
          )
        )
    )
`
export const AUTH_MOBILE_CAN_550 = `
  SELECT private.mobile_can_for((SELECT auth.uid()), loc_id, perm_key)
    AND (
      NOT EXISTS (
        SELECT 1 FROM private.permission_key_bundles pkb WHERE pkb.key = perm_key
      )
      OR
      EXISTS (
        SELECT 1 FROM private.permission_key_bundles pkb
        WHERE pkb.key = perm_key
          AND coalesce(
            (SELECT (features -> pkb.bundle) <> 'false'::jsonb FROM public.locations WHERE id = loc_id),
            true
          )
      )
    )
`
export const BUNDLE_ROWS = Object.entries(KEY_BUNDLES).flatMap(([k, bs]) => bs.map((b) => `('${k}', '${b}')`)).join(', ')

export const TABLES = `
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;
  REVOKE EXECUTE ON FUNCTION private.auth_is_master() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION private.auth_is_master() TO authenticated, service_role;

  ALTER TABLE public.locations ADD COLUMN features jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE public.locations ADD COLUMN active boolean DEFAULT true;
  ALTER TABLE public.locations ADD COLUMN organization_id uuid NOT NULL DEFAULT '${ORG1}';
  ALTER TABLE public.profiles ADD COLUMN employment_type text NOT NULL DEFAULT 'fte'
    CHECK (employment_type = ANY (ARRAY['fte', 'contractor']));
  ALTER TABLE public.profile_locations ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
  CREATE TABLE public.location_role_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, role text NOT NULL,
    employment_type text NOT NULL DEFAULT 'all', permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (location_id, role, employment_type));
  ALTER TABLE public.location_role_permissions ENABLE ROW LEVEL SECURITY;
  CREATE TABLE private.permission_key_bundles (key text NOT NULL, bundle text NOT NULL, PRIMARY KEY (key, bundle));
  CREATE TABLE private.mobile_permission_defaults (role text NOT NULL, key text NOT NULL, allowed boolean NOT NULL, PRIMARY KEY (role, key));

  -- profile_organizations as prod has it (mig 417 + 622): authenticated arwd,
  -- master-only writes, own-row-or-master reads.
  CREATE TABLE public.profile_organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL, organization_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'org_admin' CHECK (role = 'org_admin'), created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profile_id, organization_id));
  REVOKE ALL ON public.profile_organizations FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_organizations TO authenticated;

  GRANT SELECT ON public.contacts TO authenticated;
  ${PHONE.map((t) => `CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);`).join('\n')}
  ${Object.keys(WA_POLICY).map((t) => `REVOKE INSERT, UPDATE, DELETE ON public.${t} FROM authenticated;`).join('\n')}
  CREATE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${MOBILE_CAN_FOR_626}$fn$;
  CREATE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${AUTH_MOBILE_CAN_550}$fn$;
`

export const POLICIES = `
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  ${Object.entries(POLICY_KEYS).map(([t, k]) => {
    const e = k === 'act' ? `(private.auth_mobile_can(location_id, 'tasks') OR private.auth_mobile_can(location_id, 'pipeline'))`
      : `private.auth_mobile_can(location_id, '${k}')`
    return `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${t}_select ON public.${t} FOR SELECT TO authenticated USING (${e});
      CREATE POLICY ${t}_insert ON public.${t} FOR INSERT TO authenticated WITH CHECK (${e});
      CREATE POLICY ${t}_update ON public.${t} FOR UPDATE TO authenticated USING (${e}) WITH CHECK (${e});`
  }).join('\n')}
  ${Object.entries(WA_POLICY).map(([t, p]) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${p} ON public.${t} FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id, 'whatsapp'));`).join('\n')}
  ALTER TABLE public.profile_organizations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profile_organizations_select ON public.profile_organizations FOR SELECT TO authenticated
    USING ((profile_id = (SELECT auth.uid())) OR private.auth_is_master());
  CREATE POLICY profile_organizations_ins ON public.profile_organizations FOR INSERT TO authenticated WITH CHECK (private.auth_is_master());
  CREATE POLICY profile_organizations_upd ON public.profile_organizations FOR UPDATE TO authenticated
    USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());
  CREATE POLICY profile_organizations_del ON public.profile_organizations FOR DELETE TO authenticated USING (private.auth_is_master());
`

export const SEED = `
  INSERT INTO private.permission_key_bundles VALUES ${BUNDLE_ROWS};
  INSERT INTO private.mobile_permission_defaults (role, key, allowed) VALUES
    ('staff','pipeline',false),('staff','tasks',true),('staff','bookings',false),('staff','whatsapp',false),
    ('head_coach','pipeline',true),('head_coach','tasks',true),('head_coach','bookings',true),('head_coach','whatsapp',true),
    ('manager','pipeline',true),('manager','tasks',true),('manager','bookings',true),('manager','whatsapp',true),
    ('owner','pipeline',true),('owner','tasks',true),('owner','bookings',true),('owner','whatsapp',true);
  INSERT INTO public.locations (id, active, organization_id) VALUES ('${LOC_C}', false, '${ORG1}'), ('${LOC_D}', true, '${ORG2}');
  INSERT INTO public.profiles (id, role) VALUES ('${ORG_ADMIN}', 'staff'), ('${ORG_ADMIN_STAFF}', 'owner');
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${ORG_ADMIN_STAFF}', '${LOC_B}', 'staff');
  INSERT INTO public.profile_organizations (profile_id, organization_id) VALUES ('${ORG_ADMIN}', '${ORG1}'), ('${ORG_ADMIN_STAFF}', '${ORG1}');
  -- the owner 'all' template at B switches Contacts (web + phone) and phone WhatsApp off
  INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions)
    VALUES ('${LOC_B}', 'owner', 'all', '{"contacts": false, "mobile": {"contacts": false, "whatsapp": false}}');
  INSERT INTO public.contacts (id, location_id, user_id) VALUES
    ('30000000-0000-0000-0000-0000000000c1', '${LOC_C}', NULL), ('30000000-0000-0000-0000-0000000000d1', '${LOC_D}', NULL);
  ${PHONE.map((t) => `INSERT INTO public.${t} (location_id) VALUES ('${LOC_A}'), ('${LOC_B}'), ('${LOC_C}'), ('${LOC_D}');`).join('\n')}
`

export const signedOut = (db) => db.query(`SELECT set_config('request.jwt.claims', '{}', false)`)
// prod on 2 Oct: 690 and 691 applied
export const bootProd = async (opts = {}) => {
  const db = await boot({ tables: TABLES, policies: POLICIES, seed: SEED, after677: true, ...opts, migrate: [] })
  await signedOut(db)
  await db['exec'](MIG_690)
  await signedOut(db)
  await db['exec'](MIG_691)
  if (opts.before2) await db['exec'](opts.before2)
  for (const sql of opts.migrate || []) { await signedOut(db); await db['exec'](sql) }
  return db
}
