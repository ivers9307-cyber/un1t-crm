-- 785 — FEES.4: members who are never charged a class fee.
--
-- WHY. Richard, 28 Oct 2026: a whitelist of members staff add who are never
-- charged, whatever they do (late cancels, no-shows). Per studio, because
-- fees are per studio.
--
-- WHAT.
--   (1) class_fee_exemptions: one row per (location, contact), with who added
--       it, when and an optional note. Service role only: RLS on, no policy,
--       nothing for anon/authenticated (staff manage it through
--       /api/class-fees/exemptions).
--   (2) class_fees_waive_rule_check admits 'exempt': an exempt member's offence
--       is still written, as waived with waive_rule 'exempt', so staff can see
--       what was let off. Every rule allowed before is kept.
--
-- GRANTS.
--   class_fee_exemptions: REVOKE ALL FROM anon, authenticated (service role only).
--   -- column-grant: n/a, class_fees has no client privilege (mig 781).
--
-- LOCKS. One transaction, 5s lock_timeout; class_fees is tiny.
--
-- ORDER. Apply BEFORE the FEES.4 code deploys: until then the exemptions
-- table does not exist and the nightly list fails whole (nothing is charged
-- in between).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.class_fee_exemptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id  uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  note        text        CONSTRAINT class_fee_exemptions_note_length_check CHECK (char_length(note) <= 500),
  added_by    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_fee_exemptions_unique UNIQUE (location_id, contact_id)
);

ALTER TABLE public.class_fee_exemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.class_fee_exemptions FROM anon, authenticated;

COMMENT ON TABLE public.class_fee_exemptions IS
  'FEES.4 (mig 785): members never charged a class fee at a studio (staff whitelist). Their offences are still written to class_fees as waived with waive_rule exempt. Service role only.';

ALTER TABLE public.class_fees
  DROP CONSTRAINT IF EXISTS class_fees_waive_rule_check;
ALTER TABLE public.class_fees
  ADD CONSTRAINT class_fees_waive_rule_check
  CHECK (
    waive_rule IS NULL
    OR (status = 'waived' AND waive_rule IN ('exempt', 'swap', 'spot_refilled', 'new_member', 'first_offence', 'monthly_cap'))
  );

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.class_fee_exemptions'::regclass) THEN
    RAISE EXCEPTION 'mig 785: class_fee_exemptions RLS is off';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'class_fee_exemptions'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 785: a client role holds a privilege on class_fee_exemptions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'class_fee_exemptions') THEN
    RAISE EXCEPTION 'mig 785: class_fee_exemptions must have no policy';
  END IF;
END;
$$;

COMMIT;
