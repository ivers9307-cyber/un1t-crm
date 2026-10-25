// CARSCLIENTWRITE.1 — behavioural test for migration 674.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table in public gets ALL for anon, authenticated and service_role —
// the source of the five tables' arwdDxtm), cars, car_documents,
// car_bca_submissions, car_bca_submission_events and company_settings in
// PROD column order (30 Sep 2026) with their FKs, CHECKs and UNIQUEs, the 14
// live policies verbatim, cars_set_updated_at with update_updated_at()'s prod
// EXECUTE (service_role only: a trigger function's EXECUTE is never checked
// when it fires), and private.auth_is_in_location, auth_role, auth_is_owner
// and auth_is_active_staff verbatim with their prod EXECUTE. car_notes
// (post-672), invoices_queue and profile_locations (RLS with the own-row
// branch of profile_locations_read, which the BCA policies read as the
// caller) are reduced to what the FKs and policies need. The audit_mutation
// trigger on cars (DEFINER, writes audit_events) is left out: it never
// refuses a write. It proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio with a car reads the buyer's
//     contact details, marks the deposit paid and repoints the checkout URL
//     the public deposit page hands the buyer; repoints a car document's
//     storage_path at another studio's file; deletes a document, which
//     cascades away its invoices-queue row; reads a BCA download token; an
//     OWNER at one studio who is only a manager at another rewrites that
//     studio's company_settings (signature links, spam filter off) and
//     creates the row for a studio they do not belong to; a member reads and
//     writes nothing; anon reads 0 rows of four and errors on a helper for
//     company_settings;
//   * AFTER: every read and write (and LOCK … ACCESS EXCLUSIVE, i.e.
//     MAINTAIN) refused for authenticated, masters included, and anon, on all
//     five, by the grant itself; no policy left; RLS on; every service-role
//     path (car routes and webhooks with the updated_at trigger, document
//     upload/Xero fields/delete with the queue cascade, BCA submit and
//     events, the branding upsert, the car delete cascade) still works;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file
//     does not know, and RLS off; a second run passes; the plan's rollback
//     record restores the before-state.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_674 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/674_cars_company_settings_client_closed.sql'), 'utf8')

// The rollback record from the C94 plan (Task 5 Step 7), verbatim.
const ROLLBACK_674 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.cars, public.car_documents, public.car_bca_submissions,
     public.car_bca_submission_events, public.company_settings
  TO anon, authenticated;
CREATE POLICY cars_location_scoped ON public.cars FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY car_documents_via_car ON public.car_documents FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cars c WHERE c.id = car_documents.car_id AND private.auth_is_in_location(c.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cars c WHERE c.id = car_documents.car_id AND private.auth_is_in_location(c.location_id)));
CREATE POLICY car_bca_submissions_read_at_location ON public.car_bca_submissions FOR SELECT TO authenticated
  USING (location_id IN (SELECT pl.location_id FROM public.profile_locations pl
                          WHERE pl.profile_id = (SELECT auth.uid()) AND (SELECT private.auth_is_active_staff())));
CREATE POLICY car_bca_submissions_no_anon ON public.car_bca_submissions FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY car_bca_submissions_no_authenticated_write ON public.car_bca_submissions FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY car_bca_submissions_no_authenticated_update ON public.car_bca_submissions FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY car_bca_submissions_no_authenticated_delete ON public.car_bca_submissions FOR DELETE TO authenticated USING (false);
CREATE POLICY car_bca_submission_events_read_at_location ON public.car_bca_submission_events FOR SELECT TO authenticated
  USING (submission_id IN (SELECT s.id FROM public.car_bca_submissions s
                            WHERE s.location_id IN (SELECT pl.location_id FROM public.profile_locations pl
                                                     WHERE pl.profile_id = (SELECT auth.uid()) AND (SELECT private.auth_is_active_staff()))));
CREATE POLICY car_bca_submission_events_no_anon ON public.car_bca_submission_events FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY car_bca_submission_events_no_authenticated_write ON public.car_bca_submission_events FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY company_settings_read ON public.company_settings FOR SELECT TO public
  USING (private.auth_is_owner() OR private.auth_is_in_location(location_id));
CREATE POLICY company_settings_ins ON public.company_settings FOR INSERT TO public WITH CHECK (private.auth_is_owner());
CREATE POLICY company_settings_upd ON public.company_settings FOR UPDATE TO public
  USING (private.auth_is_owner()) WITH CHECK (private.auth_is_owner());
CREATE POLICY company_settings_del ON public.company_settings FOR DELETE TO public USING (private.auth_is_owner());
COMMENT ON TABLE public.cars IS NULL;
COMMENT ON TABLE public.car_documents IS NULL;
COMMENT ON TABLE public.car_bca_submissions IS NULL;
COMMENT ON TABLE public.car_bca_submission_events IS NULL;
COMMENT ON TABLE public.company_settings IS NULL;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'   // a studio with one car
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'   // a studio with no company_settings row
const LOC_C = 'c0000000-0000-0000-0000-00000000000c'   // the car business
const STAFF_A = '10000000-0000-0000-0000-000000000001'   // plain staff at A
const OWNER_C = '10000000-0000-0000-0000-000000000003'   // owner at C, only a manager at A
const MASTER = '10000000-0000-0000-0000-000000000004'
const MEMBER_UID = '20000000-0000-0000-0000-000000000001' // a customer's auth user (no profile)
const CAR_A = '60000000-0000-0000-0000-00000000000a'
const CAR_C = '60000000-0000-0000-0000-00000000000c'
const DOC_A = '70000000-0000-0000-0000-00000000000a'
const DOC_C = '70000000-0000-0000-0000-00000000000c'
const PATH_C = `${CAR_C}/bca_invoice/synthetic-c.pdf`
const IQ_A = '80000000-0000-0000-0000-00000000000a'
const SUB_A = '90000000-0000-0000-0000-00000000000a'
const CS_A = 'd0000000-0000-0000-0000-00000000000a'

const CARS = 'cars'
const DOCS = 'car_documents'
const SUBS = 'car_bca_submissions'
const EVTS = 'car_bca_submission_events'
const CS = 'company_settings'
const TABLES = [DOCS, SUBS, EVTS, CARS, CS]
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const denied = (t) => new RegExp(`permission denied for (table|relation) ${t}\\b`)
const rlsRefused = (t) => new RegExp(`new row violates row-level security policy for table "${t}"`)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  REVOKE ALL ON public.profiles FROM anon, authenticated;   -- migs 153b, 648
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  -- Reduced: the own-row branch of profile_locations_read, which the BCA read policies rely on.
  ALTER TABLE public.profile_locations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profile_locations_read ON public.profile_locations FOR SELECT TO authenticated
    USING (profile_id = (SELECT auth.uid()));

  -- The five tables: PROD column order, defaults, keys and CHECKs (pg_attribute/pg_constraint, 30 Sep 2026).
  CREATE TABLE public.cars (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'new' CONSTRAINT cars_status_check CHECK (status = ANY (ARRAY['new'::text, 'pending'::text, 'completed'::text])),
    uk_reg text, irish_reg text, vin text,
    make text NOT NULL DEFAULT 'Tesla',
    model text, vehicle_year integer,
    uk_purchase_price_ex_vat numeric(10,2), uk_vat numeric(10,2),
    irish_sale_price_inc_vat numeric(10,2), irish_sale_price_ex_vat numeric(10,2),
    buyer_name text, buyer_email text, buyer_phone text, buyer_address text,
    xero_invoice_id text, xero_invoice_number text, xero_invoice_url text, xero_invoice_issued_at timestamptz,
    uk_vat_refund_received boolean NOT NULL DEFAULT false, uk_vat_refund_received_at timestamptz,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    completed_at timestamptz,
    uk_transporter_cost numeric(10,2), ferry_cost numeric(10,2), import_customs_cost numeric(10,2), nct_cost numeric(10,2),
    additional_costs numeric(10,2), additional_costs_label text,
    fx_gbp_to_eur numeric(8,4),
    xero_invoice_amount numeric(10,2), xero_invoice_online_url text, xero_invoice_pdf_path text,
    xero_invoice_emailed_at timestamptz, xero_invoice_branding_id text,
    xero_invoice_issue_count integer NOT NULL DEFAULT 0,
    xero_invoice_paid_at timestamptz, xero_invoice_amount_paid numeric(10,2), xero_invoice_status text,
    deposit_token uuid CONSTRAINT cars_deposit_token_key UNIQUE,
    deposit_amount numeric(10,2), deposit_link_sent_at timestamptz, deposit_link_sent_via text,
    deposit_terms_accepted_at timestamptz, deposit_terms_accepted_ip text, deposit_terms_accepted_version integer,
    deposit_revolut_order_id text, deposit_revolut_checkout_url text, deposit_status text,
    deposit_paid_at timestamptz, deposit_paid_amount numeric(10,2),
    deposit_token_expires_at timestamptz, deposit_receipt_sent_at timestamptz
  );
  CREATE TABLE public.car_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    car_id uuid NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
    doc_type text NOT NULL CONSTRAINT car_documents_doc_type_check CHECK (doc_type = ANY (ARRAY['nct_invoice'::text, 'irish_customs'::text, 'bca_invoice'::text, 'transporter'::text, 'ferry_invoice'::text, 'other'::text])),
    storage_path text NOT NULL,
    filename text NOT NULL,
    mime_type text, size_bytes bigint,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    notes text,
    xero_file_id text, xero_sent_at timestamptz,
    xero_sent_by uuid REFERENCES public.profiles(id),
    xero_send_error text,
    extracted_invoice_fields jsonb, extracted_at timestamptz,
    extracted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    review_status text CONSTRAINT car_documents_review_status_check CHECK ((review_status IS NULL) OR (review_status = ANY (ARRAY['extracted'::text, 'reviewed'::text, 'pushed'::text, 'failed'::text]))),
    xero_bill_id text, xero_pushed_at timestamptz,
    xero_pushed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    xero_push_error text
  );
  CREATE TABLE public.car_bca_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    car_id uuid NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
    email_from text NOT NULL, email_to text NOT NULL, email_subject text NOT NULL, email_body text NOT NULL,
    documents jsonb NOT NULL,
    merged_pdf_path text, merged_pdf_size integer,
    submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    postmark_message_id text, postmark_error_code integer, postmark_error_msg text,
    superseded_by uuid REFERENCES public.car_bca_submissions(id) ON DELETE SET NULL,
    superseded_at timestamptz,
    download_token text, download_expires_at timestamptz,
    delivered_at timestamptz, delivered_to text,
    first_opened_at timestamptz, last_opened_at timestamptz, open_count integer NOT NULL DEFAULT 0,
    first_clicked_at timestamptz, last_clicked_at timestamptz, click_count integer NOT NULL DEFAULT 0,
    bounced_at timestamptz, bounce_type text, bounce_description text, complaint_at timestamptz,
    last_postmark_event_at timestamptz,
    first_viewed_at timestamptz, last_viewed_at timestamptz, view_count integer NOT NULL DEFAULT 0,
    first_merged_download_at timestamptz, last_merged_download_at timestamptz, merged_download_count integer NOT NULL DEFAULT 0
  );
  CREATE TABLE public.car_bca_submission_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL REFERENCES public.car_bca_submissions(id) ON DELETE CASCADE,
    event_type text NOT NULL CONSTRAINT car_bca_submission_events_event_type_check CHECK (event_type = ANY (ARRAY['delivered'::text, 'opened'::text, 'clicked'::text, 'bounced'::text, 'complained'::text, 'page_view'::text, 'download_merged'::text, 'download_file'::text])),
    file_slug text, ip text, user_agent text, raw_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.company_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL CONSTRAINT company_settings_location_id_key UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
    logo_url text, favicon_url text, company_name text,
    updated_at timestamptz DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id),
    send_quiet_hours_enabled boolean NOT NULL DEFAULT true,
    send_quiet_hours_start smallint NOT NULL DEFAULT 21,
    send_quiet_hours_end smallint NOT NULL DEFAULT 8,
    view_in_browser_label text, hosted_copy_note text, email_signature jsonb,
    email_spam_filter_enabled boolean NOT NULL DEFAULT true,
    email_spam_threshold numeric(4,1) NOT NULL DEFAULT 5.0,
    CONSTRAINT company_settings_email_signature_size CHECK ((email_signature IS NULL) OR (pg_column_size(email_signature) <= 4096)),
    CONSTRAINT company_settings_email_spam_threshold_range CHECK ((email_spam_threshold >= (0)::numeric) AND (email_spam_threshold <= (20)::numeric)),
    CONSTRAINT company_settings_hosted_copy_note_len CHECK ((hosted_copy_note IS NULL) OR (char_length(hosted_copy_note) <= 400)),
    CONSTRAINT company_settings_send_quiet_hours_range CHECK ((send_quiet_hours_start >= 0) AND (send_quiet_hours_start <= 23) AND (send_quiet_hours_end >= 0) AND (send_quiet_hours_end <= 23) AND (send_quiet_hours_start <> send_quiet_hours_end)),
    CONSTRAINT company_settings_view_in_browser_label_len CHECK ((view_in_browser_label IS NULL) OR (char_length(view_in_browser_label) <= 120))
  );

  -- Reduced: car_notes as mig 672 left it; invoices_queue's FK to car_documents.
  CREATE TABLE public.car_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), car_id uuid NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE, content text NOT NULL);
  REVOKE ALL ON public.car_notes FROM anon, authenticated;
  ALTER TABLE public.car_notes ENABLE ROW LEVEL SECURITY;
  CREATE TABLE public.invoices_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid,
    source_car_document_id uuid REFERENCES public.car_documents(id) ON DELETE CASCADE);
  ALTER TABLE public.invoices_queue ENABLE ROW LEVEL SECURITY;

  -- cars_set_updated_at, verbatim; update_updated_at() EXECUTE as prod since mig 667.
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;
  REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;
  CREATE TRIGGER cars_set_updated_at BEFORE UPDATE ON public.cars FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- Helpers, verbatim (pg_proc, 30 Sep 2026).
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.active IS NOT FALSE
          AND p.deleted_at IS NULL
          AND (
            p.role = 'master'
            OR EXISTS (
              SELECT 1 FROM public.profile_locations
              WHERE profile_id = (SELECT auth.uid())
                AND location_id = loc_id
            )
          )
      )
  $$;
  CREATE FUNCTION private.auth_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = (SELECT auth.uid())
          AND active IS NOT FALSE
          AND deleted_at IS NULL
      ) THEN
        CASE
          WHEN (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid())) = 'master'
            THEN 'master'
          ELSE COALESCE(
            (
              SELECT role FROM public.profile_locations pl
              WHERE pl.profile_id = (SELECT auth.uid())
              ORDER BY CASE pl.role
                WHEN 'owner'      THEN 1
                WHEN 'manager'    THEN 2
                WHEN 'head_coach' THEN 3
                WHEN 'staff'      THEN 4
              END
              LIMIT 1
            ),
            (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid()))
          )
        END
    END
  $$;
  CREATE FUNCTION private.auth_is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_role() = 'owner'
  $$;
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid())
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    )
  $$;
  -- Prod EXECUTE: in_location, role, owner: postgres + authenticated + service_role
  -- (so anon errors on them); active_staff: postgres + anon + authenticated.
  REVOKE EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_role(), private.auth_is_owner(), private.auth_is_active_staff() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_role(), private.auth_is_owner() TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION private.auth_is_active_staff() TO anon, authenticated;
`

// The live policies (migs 025, 163, 165 + the auth_is_active_staff sweep, 320).
// Their deparsed text is pinned against prod's pg_policies below (PROD_TEXT).
const PROD_POLICIES = `
  ALTER TABLE public.cars ENABLE ROW LEVEL SECURITY;
  CREATE POLICY cars_location_scoped ON public.cars FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));

  ALTER TABLE public.car_documents ENABLE ROW LEVEL SECURITY;
  CREATE POLICY car_documents_via_car ON public.car_documents FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.cars c WHERE c.id = car_documents.car_id AND private.auth_is_in_location(c.location_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.cars c WHERE c.id = car_documents.car_id AND private.auth_is_in_location(c.location_id)));

  ALTER TABLE public.car_bca_submissions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY car_bca_submissions_read_at_location ON public.car_bca_submissions FOR SELECT TO authenticated
    USING (location_id IN (SELECT pl.location_id FROM public.profile_locations pl
                            WHERE pl.profile_id = (SELECT auth.uid()) AND (SELECT private.auth_is_active_staff())));
  CREATE POLICY car_bca_submissions_no_anon ON public.car_bca_submissions FOR ALL TO anon USING (false) WITH CHECK (false);
  CREATE POLICY car_bca_submissions_no_authenticated_write ON public.car_bca_submissions FOR INSERT TO authenticated WITH CHECK (false);
  CREATE POLICY car_bca_submissions_no_authenticated_update ON public.car_bca_submissions FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
  CREATE POLICY car_bca_submissions_no_authenticated_delete ON public.car_bca_submissions FOR DELETE TO authenticated USING (false);

  ALTER TABLE public.car_bca_submission_events ENABLE ROW LEVEL SECURITY;
  CREATE POLICY car_bca_submission_events_read_at_location ON public.car_bca_submission_events FOR SELECT TO authenticated
    USING (submission_id IN (SELECT s.id FROM public.car_bca_submissions s
      WHERE s.location_id IN (SELECT pl.location_id FROM public.profile_locations pl
                               WHERE pl.profile_id = (SELECT auth.uid()) AND (SELECT private.auth_is_active_staff()))));
  CREATE POLICY car_bca_submission_events_no_anon ON public.car_bca_submission_events FOR ALL TO anon USING (false) WITH CHECK (false);
  CREATE POLICY car_bca_submission_events_no_authenticated_write ON public.car_bca_submission_events FOR INSERT TO authenticated WITH CHECK (false);

  ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
  CREATE POLICY company_settings_read ON public.company_settings FOR SELECT TO public
    USING (private.auth_is_owner() OR private.auth_is_in_location(location_id));
  CREATE POLICY company_settings_ins ON public.company_settings FOR INSERT TO public WITH CHECK (private.auth_is_owner());
  CREATE POLICY company_settings_upd ON public.company_settings FOR UPDATE TO public
    USING (private.auth_is_owner()) WITH CHECK (private.auth_is_owner());
  CREATE POLICY company_settings_del ON public.company_settings FOR DELETE TO public USING (private.auth_is_owner());
`

// pg_policies on prod, 30 Sep 2026 (policyname → [cmd, roles, qual, with_check]), verbatim.
const PROD_TEXT = {
  car_bca_submission_events_no_anon: ['ALL', '{anon}', 'false', 'false'],
  car_bca_submission_events_no_authenticated_write: ['INSERT', '{authenticated}', null, 'false'],
  car_bca_submission_events_read_at_location: ['SELECT', '{authenticated}', '(submission_id IN ( SELECT s.id\n   FROM car_bca_submissions s\n  WHERE (s.location_id IN ( SELECT pl.location_id\n           FROM profile_locations pl\n          WHERE ((pl.profile_id = ( SELECT auth.uid() AS uid)) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff))))))', null],
  car_bca_submissions_no_anon: ['ALL', '{anon}', 'false', 'false'],
  car_bca_submissions_no_authenticated_delete: ['DELETE', '{authenticated}', 'false', null],
  car_bca_submissions_no_authenticated_update: ['UPDATE', '{authenticated}', 'false', 'false'],
  car_bca_submissions_no_authenticated_write: ['INSERT', '{authenticated}', null, 'false'],
  car_bca_submissions_read_at_location: ['SELECT', '{authenticated}', '(location_id IN ( SELECT pl.location_id\n   FROM profile_locations pl\n  WHERE ((pl.profile_id = ( SELECT auth.uid() AS uid)) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff))))', null],
  car_documents_via_car: ['ALL', '{authenticated}', '(EXISTS ( SELECT 1\n   FROM cars c\n  WHERE ((c.id = car_documents.car_id) AND private.auth_is_in_location(c.location_id))))', '(EXISTS ( SELECT 1\n   FROM cars c\n  WHERE ((c.id = car_documents.car_id) AND private.auth_is_in_location(c.location_id))))'],
  cars_location_scoped: ['ALL', '{authenticated}', 'private.auth_is_in_location(location_id)', 'private.auth_is_in_location(location_id)'],
  company_settings_del: ['DELETE', '{public}', 'private.auth_is_owner()', null],
  company_settings_ins: ['INSERT', '{public}', null, 'private.auth_is_owner()'],
  company_settings_read: ['SELECT', '{public}', '(private.auth_is_owner() OR private.auth_is_in_location(location_id))', null],
  company_settings_upd: ['UPDATE', '{public}', 'private.auth_is_owner()', 'private.auth_is_owner()'],
}

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}'), ('${LOC_C}');
  INSERT INTO public.profiles (id, role) VALUES
    ('${STAFF_A}', 'staff'), ('${OWNER_C}', 'owner'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES
    ('${STAFF_A}', '${LOC_A}', 'staff'), ('${OWNER_C}', '${LOC_C}', 'owner'), ('${OWNER_C}', '${LOC_A}', 'manager');
  INSERT INTO public.cars (id, location_id, status, buyer_name, buyer_email, deposit_token, deposit_amount, deposit_status,
                           deposit_revolut_order_id, deposit_revolut_checkout_url, updated_at) VALUES
    ('${CAR_A}', '${LOC_A}', 'pending', 'Synthetic Buyer', 'buyer@example.invalid', gen_random_uuid(), 500, 'link_sent',
     'synthetic-order', 'https://checkout.example.invalid/synthetic', now() - interval '1 day'),
    ('${CAR_C}', '${LOC_C}', 'new', null, null, null, null, null, null, null, now() - interval '1 day');
  INSERT INTO public.car_documents (id, car_id, doc_type, storage_path, filename) VALUES
    ('${DOC_A}', '${CAR_A}', 'nct_invoice', '${CAR_A}/nct_invoice/synthetic-a.pdf', 'synthetic-a.pdf'),
    ('${DOC_C}', '${CAR_C}', 'bca_invoice', '${PATH_C}', 'synthetic-c.pdf');
  INSERT INTO public.invoices_queue (id, location_id, source_car_document_id) VALUES ('${IQ_A}', '${LOC_A}', '${DOC_A}');
  INSERT INTO public.car_bca_submissions (id, car_id, location_id, email_from, email_to, email_subject, email_body, documents, download_token) VALUES
    ('${SUB_A}', '${CAR_A}', '${LOC_A}', 'from@example.invalid', 'to@example.invalid', 'Synthetic', 'Synthetic', '[]', 'synthetic-download-token');
  INSERT INTO public.car_bca_submission_events (submission_id, event_type) VALUES ('${SUB_A}', 'delivered');
  INSERT INTO public.company_settings (id, location_id, company_name) VALUES
    ('${CS_A}', '${LOC_A}', 'Synthetic studio A'), (gen_random_uuid(), '${LOC_C}', 'Synthetic car business');
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

/** Run statements as an authenticated JWT for `uid` in a rolled-back tx; returns the LAST statement's rows. */
async function asUser(uid, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function asRole(role, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function policies() {
  const { rows } = await db.query(
    `SELECT tablename, policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`, [TABLES])
  return rows
}

async function clientAcl(table) {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = ('public.' || $1)::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`, [table])
  return rows
}

async function comments() {
  const { rows } = await db.query(
    `SELECT t, obj_description(('public.' || t)::regclass, 'pg_class') AS d FROM unnest($1::text[]) t ORDER BY t`, [TABLES])
  return rows
}

const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_674)
}

describe('before 674 — the holes (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('the default privileges gave both client roles every privilege on %s (arwdDxtm, PG 17)', async (t) => {
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it("the replay's 14 policies read exactly as prod's pg_policies", async () => {
    const got = Object.fromEntries((await policies()).map((p) => [p.policyname, [p.cmd, p.roles, p.qual, p.with_check]]))
    expect(got).toEqual(PROD_TEXT)
    expect((await policies()).every((p) => p.permissive === 'PERMISSIVE')).toBe(true)
  })

  it('plain staff: reads the buyer, marks the deposit paid and repoints the checkout URL the buyer is handed', async () => {
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.cars WHERE buyer_email IS NOT NULL AND deposit_token IS NOT NULL`))
      .toEqual([{ n: 1 }])
    expect(await asUser(STAFF_A,
      `UPDATE public.cars SET deposit_status = 'paid', deposit_paid_at = now(),
              deposit_revolut_checkout_url = 'https://attacker.example.invalid/pay'
        WHERE id = '${CAR_A}' RETURNING deposit_status, (updated_at > now() - interval '1 minute') AS trigger_fired`))
      .toEqual([{ deposit_status: 'paid', trigger_fired: true }])
    expect(await asUser(STAFF_A,
      `INSERT INTO public.cars (location_id) VALUES ('${LOC_A}') RETURNING (status = 'new') AS created`)).toEqual([{ created: true }])
  })

  it("plain staff: repoints a document at another studio's file; deleting a document cascades its invoices-queue row", async () => {
    expect(await asUser(STAFF_A,
      `UPDATE public.car_documents SET storage_path = '${PATH_C}' WHERE id = '${DOC_A}' RETURNING storage_path`))
      .toEqual([{ storage_path: PATH_C }])
    expect(await asUser(STAFF_A,
      `DELETE FROM public.car_documents WHERE id = '${DOC_A}'`,
      'RESET ROLE',
      `SELECT count(*)::int AS n FROM public.invoices_queue WHERE id = '${IQ_A}'`)).toEqual([{ n: 0 }])
    // the car business's document is out of reach (the policy's one real fence)
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.car_documents WHERE id = '${DOC_C}'`)).toEqual([{ n: 0 }])
  })

  it('plain staff: reads the BCA download token and events; the false write policies hold', async () => {
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.car_bca_submissions WHERE download_token IS NOT NULL`))
      .toEqual([{ n: 1 }])
    expect(await asUser(STAFF_A, count(EVTS))).toEqual([{ n: 1 }])
    expect(await asUser(STAFF_A, `UPDATE public.car_bca_submissions SET download_token = 'x' RETURNING id`)).toEqual([])
    await expect(asUser(STAFF_A, `INSERT INTO public.car_bca_submission_events (submission_id, event_type) VALUES ('${SUB_A}', 'opened')`))
      .rejects.toThrow(rlsRefused(EVTS))
  })

  it("an owner at one studio rewrites a studio where they are only a manager, and creates one where they are nobody", async () => {
    expect(await asUser(OWNER_C,
      `UPDATE public.company_settings
          SET email_signature = '{"phone":"0","links":[{"label":"Pay","url":"https://attacker.example.invalid"}]}',
              email_spam_filter_enabled = false, logo_url = 'https://attacker.example.invalid/logo.png'
        WHERE location_id = '${LOC_A}' RETURNING email_spam_filter_enabled`)).toEqual([{ email_spam_filter_enabled: false }])
    expect(await asUser(OWNER_C,
      `INSERT INTO public.company_settings (location_id, company_name) VALUES ('${LOC_B}', 'Synthetic') RETURNING (location_id = '${LOC_B}') AS created`))
      .toEqual([{ created: true }])
    expect(await asUser(OWNER_C, count(CS))).toEqual([{ n: 2 }])
    // plain staff cannot (auth_is_owner is false for them)
    await expect(asUser(STAFF_A, `INSERT INTO public.company_settings (location_id) VALUES ('${LOC_B}')`)).rejects.toThrow(rlsRefused(CS))
  })

  it('a member (no profile) reads none of the five and writes nothing', async () => {
    for (const t of TABLES) expect(await asUser(MEMBER_UID, count(t)), t).toEqual([{ n: 0 }])
    await expect(asUser(MEMBER_UID, `INSERT INTO public.cars (location_id) VALUES ('${LOC_A}')`)).rejects.toThrow(rlsRefused(CARS))
    await expect(asUser(MEMBER_UID, `INSERT INTO public.company_settings (location_id) VALUES ('${LOC_B}')`)).rejects.toThrow(rlsRefused(CS))
  })

  it('anon reads 0 rows of the car tables (no anon policy) and errors on a helper for company_settings', async () => {
    for (const t of [CARS, DOCS, SUBS, EVTS]) expect(await asRole('anon', count(t)), t).toEqual([{ n: 0 }])
    await expect(asRole('anon', count(CS))).rejects.toThrow(/permission denied for function auth_is_owner/)
  })
})

describe('after 674 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('anon, authenticated and public hold nothing on %s (MAINTAIN checked)', async (t) => {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of ALL_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} ${p} ${t}`).toBe(false)
      }
    }
  })

  it.each(TABLES)('%s: no column-level client privilege; RLS on; no policy; service_role still reads and writes; commented', async (t) => {
    const rel = `public.${t}`
    const { rows: [r] } = await db.query(`SELECT
      has_any_column_privilege('authenticated', $1, 'SELECT') OR has_any_column_privilege('authenticated', $1, 'INSERT')
        OR has_any_column_privilege('authenticated', $1, 'UPDATE') OR has_any_column_privilege('authenticated', $1, 'REFERENCES') AS a_col,
      has_any_column_privilege('anon', $1, 'SELECT') OR has_any_column_privilege('anon', $1, 'INSERT')
        OR has_any_column_privilege('anon', $1, 'UPDATE') AS n_col,
      has_table_privilege('service_role', $1, 'SELECT') AND has_table_privilege('service_role', $1, 'INSERT')
        AND has_table_privilege('service_role', $1, 'UPDATE') AND has_table_privilege('service_role', $1, 'DELETE') AS svc,
      (SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls,
      obj_description($1::regclass, 'pg_class') LIKE '%Service role only (CARSCLIENTWRITE.1, mig 674)%' AS commented`, [rel])
    expect(r).toEqual({ a_col: false, n_col: false, svc: true, rls: true, commented: true })
    expect(await clientAcl(t)).toEqual([])
  })

  it('no policy is left on any of the five', async () => {
    expect(await policies()).toEqual([])
  })
})

describe('after 674 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['plain staff', STAFF_A], ['owner', OWNER_C], ['master', MASTER], ['member', MEMBER_UID]])(
    '%s: SELECT, INSERT, UPDATE, DELETE, TRUNCATE and LOCK are refused on all five by the grant', async (_l, uid) => {
      for (const t of TABLES) {
        await expect(asUser(uid, count(t)), t).rejects.toThrow(denied(t))
        await expect(asUser(uid, `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
        await expect(asUser(uid, `TRUNCATE public.${t} CASCADE`), t).rejects.toThrow(/permission denied/)
        await expect(asUser(uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`), t).rejects.toThrow(denied(t))
      }
      await expect(asUser(uid, `UPDATE public.cars SET deposit_status = 'paid' WHERE id = '${CAR_A}'`)).rejects.toThrow(denied(CARS))
      await expect(asUser(uid, `INSERT INTO public.cars (location_id) VALUES ('${LOC_A}')`)).rejects.toThrow(denied(CARS))
      await expect(asUser(uid, `UPDATE public.car_documents SET storage_path = '${PATH_C}' WHERE id = '${DOC_A}'`)).rejects.toThrow(denied(DOCS))
      await expect(asUser(uid, `UPDATE public.company_settings SET email_spam_filter_enabled = false WHERE location_id = '${LOC_A}'`))
        .rejects.toThrow(denied(CS))
      await expect(asUser(uid, `INSERT INTO public.company_settings (location_id) VALUES ('${LOC_B}')
        ON CONFLICT (location_id) DO UPDATE SET company_name = 'x'`)).rejects.toThrow(denied(CS))
    })

  it('anon: every read and write is refused by the grant itself', async () => {
    for (const t of TABLES) {
      await expect(asRole('anon', count(t))).rejects.toThrow(denied(t))
      await expect(asRole('anon', `DELETE FROM public.${t}`)).rejects.toThrow(denied(t))
    }
  })

  it('service_role: car routes and webhooks (trigger fires), documents + queue cascade, BCA submit/events, branding upsert, car delete cascade', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.cars (location_id, created_by, make) VALUES ('${LOC_C}', '${OWNER_C}', 'Tesla')`,
      `UPDATE public.cars SET deposit_status = 'paid', deposit_paid_at = now(), deposit_paid_amount = 500 WHERE id = '${CAR_A}'`,
      `UPDATE public.cars SET xero_invoice_issue_count = coalesce(xero_invoice_issue_count, 0) + 1 WHERE id = '${CAR_A}'`,
      `INSERT INTO public.car_documents (car_id, doc_type, storage_path, filename, uploaded_by) VALUES ('${CAR_C}', 'other', '${CAR_C}/other/new.pdf', 'new.pdf', '${OWNER_C}')`,
      `UPDATE public.car_documents SET extracted_invoice_fields = '{}', review_status = 'extracted', xero_bill_id = 'synthetic' WHERE id = '${DOC_C}'`,
      `DELETE FROM public.car_documents WHERE id = '${DOC_A}'`,
      `INSERT INTO public.car_bca_submissions (car_id, location_id, email_from, email_to, email_subject, email_body, documents)
         VALUES ('${CAR_C}', '${LOC_C}', 'a@example.invalid', 'b@example.invalid', 's', 'b', '[]')`,
      `INSERT INTO public.car_bca_submission_events (submission_id, event_type) VALUES ('${SUB_A}', 'opened')`,
      `UPDATE public.car_bca_submissions SET open_count = open_count + 1, last_opened_at = now() WHERE id = '${SUB_A}'`,
      `INSERT INTO public.company_settings (location_id, company_name, updated_by) VALUES ('${LOC_A}', 'Synthetic renamed', '${OWNER_C}')
         ON CONFLICT (location_id) DO UPDATE SET company_name = EXCLUDED.company_name, updated_by = EXCLUDED.updated_by`,
      `SELECT (SELECT count(*)::int FROM public.cars) AS cars,
              (SELECT deposit_status FROM public.cars WHERE id = '${CAR_A}') AS dep,
              (SELECT updated_at > now() - interval '1 minute' FROM public.cars WHERE id = '${CAR_A}') AS trigger_fired,
              (SELECT count(*)::int FROM public.car_documents) AS docs,
              (SELECT count(*)::int FROM public.invoices_queue) AS iq,
              (SELECT count(*)::int FROM public.car_bca_submission_events) AS evts,
              (SELECT company_name FROM public.company_settings WHERE id = '${CS_A}') AS cs_name`)
    expect(rows).toEqual([{ cars: 3, dep: 'paid', trigger_fired: true, docs: 2, iq: 0, evts: 2, cs_name: 'Synthetic renamed' }])
    expect(await asRole('service_role',
      `DELETE FROM public.cars WHERE id = '${CAR_A}'`,
      `SELECT (SELECT count(*)::int FROM public.car_documents WHERE car_id = '${CAR_A}') AS docs,
              (SELECT count(*)::int FROM public.car_bca_submissions WHERE car_id = '${CAR_A}') AS subs,
              (SELECT count(*)::int FROM public.car_bca_submission_events) AS evts,
              (SELECT count(*)::int FROM public.invoices_queue) AS iq`))
      .toEqual([{ docs: 0, subs: 0, evts: 0, iq: 0 }])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_674) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await policies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['cars_location_scoped', 'car_documents_via_car', 'company_settings_upd']))
    expect((await clientAcl(CARS)).find((r) => r.grantee === 'authenticated').privs).toContain('UPDATE')
  }

  it("when another grantor's SELECT on cars to authenticated survives the REVOKE", () => expectAbort(
    `GRANT SELECT ON public.cars TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.cars TO authenticated; RESET ROLE;`,
    /mig 674: client roles still hold privileges on public\.cars: authenticated:SELECT/,
  ), 60_000)

  it("when another grantor's UPDATE on company_settings to anon survives", () => expectAbort(
    `GRANT UPDATE ON public.company_settings TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.company_settings TO anon; RESET ROLE;`,
    /mig 674: client roles still hold privileges on public\.company_settings: anon:UPDATE/,
  ), 60_000)

  it("when another grantor's column-level UPDATE (storage_path) on car_documents survives", () => expectAbort(
    `GRANT UPDATE (storage_path) ON public.car_documents TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (storage_path) ON public.car_documents TO authenticated; RESET ROLE;`,
    /mig 674: client roles still hold privileges on public\.car_documents: authenticated:UPDATE/,
  ), 60_000)

  it('when INSERT on company_settings is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.company_settings TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 674: authenticated still holds INSERT on public\.company_settings/,
  ), 60_000)

  it('when a policy the file does not know about is left on car_bca_submissions', () => expectAbort(
    `CREATE POLICY bca_read_extra ON public.car_bca_submissions FOR SELECT TO authenticated USING (true);`,
    /mig 674: public\.car_bca_submissions should have no policy left: bca_read_extra SELECT/,
  ), 60_000)

  it('when RLS is off on cars (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.cars DISABLE ROW LEVEL SECURITY;`,
    /mig 674: row level security is off on public\.cars/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_674)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep grants, policies and (absent) comments exactly (and so the holes)', async () => {
    await boot()
    const aclBefore = await Promise.all(TABLES.map(clientAcl))
    const policiesBefore = await policies()
    const commentsBefore = await comments()
    await runSql(MIG_674)
    await runSql(ROLLBACK_674)
    expect(await Promise.all(TABLES.map(clientAcl))).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await comments()).toEqual(commentsBefore)
    expect(commentsBefore.every((c) => c.d === null)).toBe(true)
    expect(await asUser(STAFF_A, `UPDATE public.cars SET deposit_status = 'paid' WHERE id = '${CAR_A}' RETURNING deposit_status`))
      .toEqual([{ deposit_status: 'paid' }])
  }, 60_000)
})
