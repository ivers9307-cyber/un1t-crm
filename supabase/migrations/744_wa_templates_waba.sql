-- 744_wa_templates_waba.sql
-- WAORGNUMBER.2 — templates belong to a studio AND a WhatsApp Business Account
-- (docs/superpowers/specs/2026-10-17-wa-org-shared-numbers-design.md, R5).
--
--   * whatsapp_templates.business_account_id (text, NULL): the WABA the template
--     lives on. whatsapp_templates.location_id keeps meaning "the studio that
--     manages it". Backfilled from the row studio's LINK-default number
--     (location_whatsapp_numbers.is_default, mig 743) -> whatsapp_numbers.business_account_id;
--     a studio with no default link falls back to its newest switched-on number
--     that has a WABA. A studio with no number stays NULL (the unique index below
--     is partial, so those rows are simply not constrained).
--   * Partial unique index (business_account_id, name, language): two studios on
--     one WABA cannot both own "welcome_offer"/en, which Meta would refuse anyway.
--   * Partial unique index (meta_template_id): Meta's ids are globally unique, so
--     the status webhook's .maybeSingle() lookup becomes structural.
--
-- Both indexes are preceded by a duplicate check that RAISES (naming the keys),
-- so a duplicate fails the whole file loudly instead of as a bare index error
-- halfway through. Prod on 17 Oct: 21 rows, all Stillorgan, no duplicates.
--
-- GRANT DECISION (CLAUDE.md, new column): authenticated holds table-level SELECT
-- on whatsapp_templates (mig 669 left it exactly SELECT; the phone's template
-- picker and the web list's realtime read it), so the new column is readable
-- with no column grant, and the WABA id is not a secret (it is not a credential:
-- tests/credential-column-grants-guard.test.js covers other tables). authenticated
-- keeps NO write privilege here and anon nothing (mig 669); this file touches no
-- grant and no policy. Every writer is service_role.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.whatsapp_templates ADD COLUMN IF NOT EXISTS business_account_id text;

COMMENT ON COLUMN public.whatsapp_templates.business_account_id IS
  'The WhatsApp Business Account the template lives on (WAORGNUMBER R5). location_id is the studio that manages it.';

-- Backfill: the studio's link-default number's WABA, else its newest switched-on number with one.
UPDATE public.whatsapp_templates t
   SET business_account_id = (
     SELECT n.business_account_id
       FROM public.location_whatsapp_numbers l
       JOIN public.whatsapp_numbers n ON n.id = l.whatsapp_number_id
      WHERE l.location_id = t.location_id
        AND n.business_account_id IS NOT NULL
        AND n.business_account_id <> ''
      ORDER BY l.is_default DESC, l.created_at DESC, n.updated_at DESC
      LIMIT 1)
 WHERE t.business_account_id IS NULL AND t.location_id IS NOT NULL;

-- Duplicates must stop the file before an index is built.
DO $$
DECLARE
  v_dupes text;
BEGIN
  SELECT string_agg(business_account_id || '/' || name || '/' || COALESCE(language, '') || ' x' || n, ', ')
    INTO v_dupes
    FROM (
      SELECT business_account_id, name, language, count(*) AS n
        FROM public.whatsapp_templates
       WHERE business_account_id IS NOT NULL
       GROUP BY business_account_id, name, language
      HAVING count(*) > 1) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'mig 744: duplicate (business_account_id, name, language) in whatsapp_templates: %', v_dupes;
  END IF;

  SELECT string_agg(meta_template_id || ' x' || n, ', ')
    INTO v_dupes
    FROM (
      SELECT meta_template_id, count(*) AS n
        FROM public.whatsapp_templates
       WHERE meta_template_id IS NOT NULL
       GROUP BY meta_template_id
      HAVING count(*) > 1) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'mig 744: duplicate meta_template_id in whatsapp_templates: %', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_waba_name_lang
  ON public.whatsapp_templates (business_account_id, name, language)
  WHERE business_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_meta_id
  ON public.whatsapp_templates (meta_template_id)
  WHERE meta_template_id IS NOT NULL;

COMMIT;
