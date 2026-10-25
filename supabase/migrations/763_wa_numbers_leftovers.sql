-- 763 — ORGCONTACTS.0 (spec §3.1-3.2): the WAORGNUMBER leftovers go.
--
-- Proven by tests/migration-763-wa-numbers-leftovers.test.js (PGlite; mig
-- 176's shape of whatsapp_numbers, then the real 723 and 743 files, then this).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- WAORGNUMBER.1 (mig 743) moved WhatsApp numbers to the organisation and the
-- per-studio default to location_whatsapp_numbers, and scheduled four leftovers
-- for removal once the code stopped touching them (docs/superpowers/specs/
-- 2026-10-17-wa-org-shared-numbers-design.md §8). The code stops touching them
-- in the PR that ships this file, so this file is applied AFTER that PR has
-- deployed (the reverse of the usual order; the PR body says so):
--   1. whatsapp_numbers.is_default (DEPRECATED since 743) and mig 176's
--      per-studio default partial index idx_whatsapp_numbers_default. The
--      live default is location_whatsapp_numbers.is_default.
--   2. mig 743's two compatibility triggers, which kept pre-743 code working:
--      trg_whatsapp_numbers_fill_organization (BEFORE INSERT: organization_id
--      from the home studio) and trg_whatsapp_numbers_switch_on_at_home (AFTER
--      INSERT: the home link row). The two routes that insert numbers
--      (/api/organizations/[id]/whatsapp/numbers and …/embedded-signup) now
--      pass organization_id and write the home link row themselves
--      (switchOnAtHome in src/lib/org-whatsapp-numbers.js).
--      trg_whatsapp_numbers_org_change_guard STAYS: it is the organisation
--      fence, not compatibility.
--   3. mig 176's UNIQUE (location_id, label): a label is unique per
--      ORGANISATION now (the org numbers page lists them side by side), as
--      whatsapp_numbers_organization_label_unique.
--   4. whatsapp_numbers.location_id is the number's HOME studio, named for what
--      it does: unknown senders, Meta-made templates and chat-opener edits
--      belong to it (comment; the org numbers page says the same).
--
-- WHO CHANGES: nobody's sends, threads or defaults move. A second number with
-- a label already used elsewhere in the organisation is refused from now on.
--
-- APPLY: AFTER the ORGCONTACTS.0 PR has deployed, then get_advisors (security).
-- The pre-check refuses the file while two numbers of one organisation share a
-- label (rename one on /settings/whatsapp-numbers first).
-- ROLLBACK (forward migration): mig 743's two compatibility functions and
--   triggers, verbatim; ALTER TABLE public.whatsapp_numbers ADD COLUMN
--   is_default boolean NOT NULL DEFAULT false (the value is lost: it was
--   deprecated and unread); mig 176's partial index; a UNIQUE (location_id,
--   label) constraint; DROP CONSTRAINT whatsapp_numbers_organization_label_unique.
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Pre-checks.
DO $$
DECLARE
  v_dupes int;
BEGIN
  IF to_regclass('public.location_whatsapp_numbers') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'whatsapp_numbers' AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'mig 763: mig 743 (location_whatsapp_numbers, whatsapp_numbers.organization_id) is not applied';
  END IF;
  SELECT count(*) INTO v_dupes
    FROM (SELECT organization_id, label FROM public.whatsapp_numbers GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'mig 763: % label(s) are used by more than one number of the same organisation; rename on /settings/whatsapp-numbers first', v_dupes;
  END IF;
END $$;

CREATE TEMP TABLE m763_link_acl ON COMMIT DROP AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.location_whatsapp_numbers'::regclass;

-- 1. The deprecated per-number default and its index.
DROP INDEX IF EXISTS public.idx_whatsapp_numbers_default;
ALTER TABLE public.whatsapp_numbers DROP COLUMN IF EXISTS is_default;

-- 2. The compatibility triggers (and their functions). The org-change guard stays.
DROP TRIGGER IF EXISTS trg_whatsapp_numbers_fill_organization ON public.whatsapp_numbers;
DROP FUNCTION IF EXISTS private.whatsapp_numbers_fill_organization();
DROP TRIGGER IF EXISTS trg_whatsapp_numbers_switch_on_at_home ON public.whatsapp_numbers;
DROP FUNCTION IF EXISTS private.whatsapp_numbers_switch_on_at_home();

-- 3. The label is unique per organisation. Mig 176's constraint is found by
--    its columns, never by a guessed name (a CREATE TABLE names it however
--    Postgres did at the time).
DO $$
DECLARE
  v_old text;
BEGIN
  SELECT c.conname INTO v_old
    FROM pg_constraint c
   WHERE c.conrelid = 'public.whatsapp_numbers'::regclass
     AND c.contype = 'u'
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['label', 'location_id'];
  IF v_old IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.whatsapp_numbers DROP CONSTRAINT %I', v_old);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_numbers'::regclass AND conname = 'whatsapp_numbers_organization_label_unique') THEN
    ALTER TABLE public.whatsapp_numbers ADD CONSTRAINT whatsapp_numbers_organization_label_unique UNIQUE (organization_id, label);
  END IF;
END $$;

-- 4. What the home studio means.
COMMENT ON COLUMN public.whatsapp_numbers.location_id IS
  'Home studio (WAORGNUMBER R1, ORGCONTACTS.0). Unknown senders, Meta-made templates and chat-opener edits belong to this studio. Which studios SEND from the number is location_whatsapp_numbers.';

-- 5. Self-check: the catalog, never this file.
DO $$
DECLARE
  v_triggers text[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'whatsapp_numbers' AND column_name = 'is_default')
     OR to_regclass('public.idx_whatsapp_numbers_default') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 763: whatsapp_numbers.is_default or its index is still there';
  END IF;
  IF to_regclass('public.location_whatsapp_numbers_one_default') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'location_whatsapp_numbers' AND column_name = 'is_default') THEN
    RAISE EXCEPTION 'mig 763: the link table''s default (column or index) is missing; this file must not touch it';
  END IF;
  SELECT array_agg(tgname::text ORDER BY tgname) INTO v_triggers
    FROM pg_trigger WHERE tgrelid = 'public.whatsapp_numbers'::regclass AND NOT tgisinternal;
  IF v_triggers IS DISTINCT FROM ARRAY['trg_whatsapp_numbers_org_change_guard'] THEN
    RAISE EXCEPTION 'mig 763: whatsapp_numbers triggers are %, expected only the org-change guard', v_triggers;
  END IF;
  IF to_regprocedure('private.whatsapp_numbers_fill_organization()') IS NOT NULL
     OR to_regprocedure('private.whatsapp_numbers_switch_on_at_home()') IS NOT NULL
     OR to_regprocedure('private.whatsapp_numbers_org_change_guard()') IS NULL THEN
    RAISE EXCEPTION 'mig 763: the compatibility functions are still there, or the org-change guard is gone';
  END IF;
  -- Exactly one unique constraint NAMES label, and it is the organisation one.
  -- Mig 176's UNIQUE (phone_number_id) (Meta's id) stays and is not counted:
  -- the first apply on 25 Oct 2026 counted every unique constraint, found two,
  -- and rolled the whole file back.
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conrelid = 'public.whatsapp_numbers'::regclass AND c.contype = 'u'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attname = 'label')) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.whatsapp_numbers'::regclass AND c.conname = 'whatsapp_numbers_organization_label_unique'
                       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                              FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['label', 'organization_id']) THEN
    RAISE EXCEPTION 'mig 763: whatsapp_numbers must carry exactly one unique constraint on label, whatsapp_numbers_organization_label_unique (organization_id, label)';
  END IF;
  IF EXISTS (SELECT 1 FROM m763_link_acl a, pg_class c
              WHERE c.oid = 'public.location_whatsapp_numbers'::regclass AND c.relacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'mig 763: the location_whatsapp_numbers ACL changed; this file must not touch it';
  END IF;
  RAISE NOTICE 'mig 763: whatsapp_numbers.is_default, the two 743 compatibility triggers and the per-studio label uniqueness are gone; labels are unique per organisation.';
END $$;

COMMIT;
