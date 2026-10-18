-- 746_move_hatch_templates.sql
-- WAORGNUMBER.2 — the three hatch_* WhatsApp templates sit at Stillorgan because
-- Hatch had no number of its own when they were made. Move them to UN1T Hatch
-- Street's location_id (docs/superpowers/specs/2026-10-17-wa-org-shared-numbers-design.md §8).
--
-- APPLY AT GO-LIVE, together with switching the organisation number on at UN1T
-- Hatch Street; see WAORGNUMBER plan Task 21 (ruling R10). NOT right after PR 2
-- merges: until Hatch has the number switched on, Hatch has no studio sender and
-- the templates are only reachable from the Stillorgan list. The file is safe to
-- apply at any time, though: it touches only the three named rows, only while they
-- are still named hatch_* and not already at Hatch, and re-running it is a no-op.
--
--   * Only whatsapp_templates.location_id changes (the studio that MANAGES the
--     template). business_account_id (mig 745, the WABA the template lives on)
--     and meta_template_id are untouched, so the (WABA, name, language) and
--     meta_template_id unique indexes cannot be tripped by this move.
--   * The three sent Stillorgan broadcasts that reference these rows keep their
--     own location_id and history; nothing else is updated.
--   * The ids below are template row ids (no personal data), taken from spec §8.
--   * Hatch is found by name, never by a hard-coded id. If the rows still need to
--     move and 'UN1T Hatch Street' is not exactly one location, the file RAISES
--     instead of setting location_id to NULL or to the wrong studio.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  hatch_ids uuid[];
  pending   int;
BEGIN
  SELECT count(*) INTO pending
    FROM public.whatsapp_templates t
   WHERE t.id IN (
           'd67d6570-f64b-4d5c-8e19-fe3729f29c3d',
           '9118c478-5958-4655-9737-8e5c33bcc0fc',
           'a0e011b2-67a2-4121-833b-fa867ee8b8bf')
     AND t.name LIKE 'hatch\_%';

  IF pending = 0 THEN
    RAISE NOTICE '746: none of the three hatch_* templates exist here, nothing to move';
    RETURN;
  END IF;

  SELECT array_agg(id) INTO hatch_ids FROM public.locations WHERE name = 'UN1T Hatch Street';
  IF coalesce(array_length(hatch_ids, 1), 0) <> 1 THEN
    RAISE EXCEPTION '746: expected exactly one location named UN1T Hatch Street, found %', coalesce(array_length(hatch_ids, 1), 0);
  END IF;

  UPDATE public.whatsapp_templates
     SET location_id = hatch_ids[1]
   WHERE id IN (
           'd67d6570-f64b-4d5c-8e19-fe3729f29c3d',
           '9118c478-5958-4655-9737-8e5c33bcc0fc',
           'a0e011b2-67a2-4121-833b-fa867ee8b8bf')
     AND name LIKE 'hatch\_%'
     AND location_id IS DISTINCT FROM hatch_ids[1];
END
$$;

COMMIT;
