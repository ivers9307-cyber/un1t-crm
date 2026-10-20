// Shared PGlite fixture for the contact_studios read-model tests (ORGCONTACTS):
// the 731/732/758 side-channel world as the 762 test built it, plus what mig
// 764 reads. Used by tests/migration-765-…, tests/migration-768-… and
// tests/contact-studios-read-model.test.js. Fictional ids only.
import { IDS } from './member-write-sweep.js'
import { mig, LOC_A, LOC_B, LOC_C, ORG1 } from './contacts-resolvers-699-fixture.js'

export const MIG_251 = mig('251_crossover_contact_ids_rpc.sql')
export const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')
export const MIG_731 = mig('731_contacts_read_by_studio_membership.sql')
export const MIG_732 = mig('732_contacts_read_by_studio_client.sql')
export const MIG_758 = mig('758_glofox_crossover_members.sql')
export const MIG_762 = mig('762_contacts_read_by_studio_deal.sql')
export const MIG_764 = mig('764_contact_studios.sql')
export const MIG_765 = mig('765_contacts_read_by_contact_studios.sql')

export const QUAL_765 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_studio_contact_ids() AS auth_contact_studio_contact_ids)::uuid[])))'
export const STUDIO_HELPER = 'private.auth_contact_studio_contact_ids()'
export const OLD_HELPER = 'private.auth_contact_membership_contact_ids()'
export const CROSS_RPC = 'public.crossover_contact_ids(uuid)'
export const MD5_765_STUDIO = 'c4464ab057b9a175dc94037ced7e39b5'
export const md5Of = async (db, fn) => (await db.query(`SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h
  FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.h

export const C_A = IDS.C_MEMBER        // lives at A: a deal at B
export const C_A2 = IDS.C_MEMBER2      // lives at A: a Glofox crossover member at B
export const C_B = IDS.C_B             // lives at B
export const C_C1 = '30000000-0000-0000-0000-0000000000c1'   // lives at C (ORG1, inactive): active member at B
export const C_D1 = '30000000-0000-0000-0000-0000000000d1'   // moved to C below: un1t client at B
export const C_C2 = '30000000-0000-0000-0000-0000000000c2'   // lives at C: a relationship at C only
export const C_C3 = '30000000-0000-0000-0000-0000000000c3'   // lives at C: an ENDED relationship at B
export const ORG_ROW = 'f0000000-0000-0000-0000-000000000001'

// 731 + 732 + 758's fixture (as the 762 test builds it) with the ORG2 contact
// moved into ORG1 (mig 764 refuses a cross-organisation pair, rightly), plus
// what mig 764 reads: organisations, the contacts and locations columns, the
// deal/pipeline columns, un1t_subscriptions, class_bookings, the WhatsApp
// thread columns and cron_heartbeats.
export const BEFORE2 = `
  CREATE TABLE IF NOT EXISTS public.organizations (id uuid PRIMARY KEY);
  INSERT INTO public.organizations VALUES ('${ORG1}'), ('f0000000-0000-0000-0000-000000000002') ON CONFLICT DO NOTHING;
  ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS is_host_anchor boolean NOT NULL DEFAULT false;
  ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS membership_source text;
  ALTER TABLE public.contacts ADD COLUMN organization_id uuid, ADD COLUMN glofox_member_id text, ADD COLUMN glofox_membership_status text,
    ADD COLUMN glofox_membership_state text, ADD COLUMN created_via_import_id uuid, ADD COLUMN last_attended_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  INSERT INTO public.contacts (id, location_id, user_id) VALUES
    ('${C_C2}', '${LOC_C}', NULL), ('${C_C3}', '${LOC_C}', NULL) ON CONFLICT (id) DO NOTHING;
  UPDATE public.contacts SET location_id = '${LOC_C}' WHERE id = '${C_D1}';
  UPDATE public.contacts c SET organization_id = l.organization_id FROM public.locations l WHERE l.id = c.location_id;
  ALTER TABLE public.deals ADD COLUMN contact_id uuid, ADD COLUMN stage_id uuid, ADD COLUMN status text DEFAULT 'open',
    ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now();
  CREATE TABLE public.pipelines (id uuid PRIMARY KEY, location_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true, is_primary boolean NOT NULL DEFAULT false);
  CREATE TABLE public.pipeline_stages (id uuid PRIMARY KEY, pipeline_id uuid NOT NULL, slug text NOT NULL);
  CREATE TABLE public.contact_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
    contact_id uuid NOT NULL, source text NOT NULL, plan_name text NOT NULL DEFAULT 'Plan',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
  ALTER TABLE public.contact_memberships ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.contact_memberships FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_memberships TO service_role;
  ${MIG_251}
  INSERT INTO public.contact_memberships (organization_id, location_id, contact_id, source, status) VALUES
    ('${ORG1}', '${LOC_B}', '${C_C1}', 'un1t_online_api', 'active'),
    ('${ORG1}', '${LOC_A}', '${C_D1}', 'un1t_online_export', 'active');
  INSERT INTO public.deals (location_id, contact_id) VALUES ('${LOC_B}', '${C_A}');
  CREATE TABLE public.un1t_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_user_id text NOT NULL,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL, status text, credit_balance integer, credit_unlimited boolean,
    remote_created_at timestamptz, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (location_id, un1t_user_id));
  ALTER TABLE public.un1t_clients ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.un1t_clients FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_clients TO service_role;
  INSERT INTO public.un1t_clients (location_id, un1t_user_id, contact_id, status) VALUES ('${LOC_B}', 'u-b-1', '${C_D1}', 'inactive');
  CREATE TABLE public.un1t_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_id text NOT NULL,
    un1t_user_id text, contact_id uuid, status text, UNIQUE (location_id, un1t_id));
  CREATE TABLE public.contact_location_preferences (contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid NOT NULL, email_marketing boolean NOT NULL DEFAULT true, subscribed_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL, PRIMARY KEY (contact_id, location_id));
  CREATE TABLE public.class_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, contact_id uuid, starts_at timestamptz);
  ALTER TABLE public.whatsapp_conversations ADD COLUMN contact_id uuid;
  ALTER TABLE public.whatsapp_messages ADD COLUMN conversation_id uuid, ADD COLUMN direction text, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  CREATE TABLE public.cron_heartbeats (name text PRIMARY KEY, expected_interval_seconds integer NOT NULL, grace_seconds integer NOT NULL DEFAULT 60,
    last_ok_at timestamptz, notes text);
`
// Rows the Glofox sync would write once 758 exists (B's crossover member).
export const GLOFOX_ROWS = `
  INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id) VALUES ('${LOC_B}', 'gf-b-1', '${C_A2}');
`
// After 764's backfill: an ENDED relationship at B for C_C3 (decision 2: still visible).
export const ENDED_ROW = `
  INSERT INTO public.contact_studios (contact_id, location_id, organization_id, kind, status, source, ended_at)
  VALUES ('${C_C3}', '${LOC_B}', '${ORG1}', 'lead', 'ended', 'deal', now());
`


// person_groups as mig 270 made it and 681 closed it (767 adds organization_id).
export const PERSON_GROUPS_270 = `
  CREATE TABLE public.person_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    primary_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
    note text, created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX idx_person_groups_location ON public.person_groups(location_id);
  CREATE TABLE public.person_group_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL REFERENCES public.person_groups(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE, match_method text NOT NULL, confidence text NOT NULL,
    added_by uuid, added_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE public.person_groups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.person_group_members ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.person_groups, public.person_group_members FROM anon, authenticated, PUBLIC;
  INSERT INTO public.person_groups (location_id, primary_contact_id) VALUES ('${LOC_A}', '${C_A}');
`
