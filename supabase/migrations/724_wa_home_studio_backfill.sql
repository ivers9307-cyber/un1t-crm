-- 724_wa_home_studio_backfill.sql
-- WAHOMESTUDIO.1 — one-off: re-file every WhatsApp thread whose contact's
-- home studio is a NUMBER-LESS sibling (same organisation) of the thread's
-- studio, through move_whatsapp_conversation (mig 723). These are the threads
-- WANUMBERLESS.1 (#1940) and sending-studio outbound filed at the receiving
-- studio (~120 Hatch Street threads in the Stillorgan inbox, 15 Oct 2026).
-- Each move runs in its own sub-block: a unique_violation (e.g. a merge that
-- would copy a wa_bsuid another row at the home studio already holds) is
-- NOTICEd and counted as skipped, never aborting the other threads.
-- Apply RIGHT AFTER the WAHOMESTUDIO.1 code deploys (spec §5): before it, a
-- thread at Hatch cannot be answered. Idempotent: a second run finds nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  r record;
  v_res jsonb;
  v_moved int := 0;
  v_merged int := 0;
  v_skipped int := 0;
BEGIN
  FOR r IN
    SELECT c.id, k.location_id AS home
      FROM public.whatsapp_conversations c
      JOIN public.contacts k ON k.id = c.contact_id
      JOIN public.locations lc ON lc.id = c.location_id
      JOIN public.locations lh ON lh.id = k.location_id
     WHERE k.location_id <> c.location_id
       AND lh.organization_id = lc.organization_id
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_numbers n WHERE n.location_id = k.location_id AND n.is_active)
     ORDER BY c.created_at, c.id
  LOOP
    BEGIN
      v_res := public.move_whatsapp_conversation(r.id, r.home);
      IF (v_res->>'merged')::boolean THEN v_merged := v_merged + 1; ELSE v_moved := v_moved + 1; END IF;
    EXCEPTION WHEN unique_violation THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'WAHOMESTUDIO.1 backfill: skipped thread % (%)', r.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'WAHOMESTUDIO.1 backfill: % moved, % merged, % skipped', v_moved, v_merged, v_skipped;
END $$;

COMMIT;
