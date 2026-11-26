-- 875 — INBOXPERM.1: a client session reads Instagram conversations and
-- messages only at studios where it may use the inbox.
--
-- NOT APPLIED when this file was written. Forward-only and idempotent.
--
-- THE GAP. ig_conv_select (instagram_conversations) and ig_msg_select
-- (instagram_messages), role public, admitted any ACTIVE staff member of the
-- row's studio (profile_locations + private.auth_is_active_staff()) and any
-- master, with no inbox permission asked: a studio member who may not use the
-- inbox read its Instagram threads and messages straight through the browser
-- or phone Supabase client and over realtime. The /api routes already judge
-- the inbox key at the thread's studio (INBOXPERM.1); this closes the direct
-- door the same way.
--
-- THE FIX. Both policies become the WhatsApp twins (wa_conv_select,
-- wa_msg_select, mig 691): FOR SELECT TO authenticated,
--   location_id = ANY ((SELECT private.auth_mobile_can_location_ids('whatsapp'))::uuid[])
-- the InitPlan form (once per statement; the ::uuid[] cast is load-bearing).
-- Instagram has no key of its own: 'ig' rides `whatsapp` for both channels.
--
-- WHO READS, BEFORE: any active member of the row's studio; any master.
-- WHO READS, AFTER: the studios where the session holds the PHONE `whatsapp`
-- key as private.mobile_can_location_ids_for resolves it (mig 691): studio
-- switch + bundle layer, master at every studio past them, otherwise a
-- membership and per-user override -> employment-type template -> 'all'
-- template -> role default (owner, manager, head_coach, reception true;
-- staff false). Active, non-deleted profiles only. A master reads every
-- active studio's rows (as for WhatsApp). Role-default users read what they
-- read before; plain staff and anyone whose template turns the key off read
-- nothing directly.
-- KNOWN TRADE: the function reads only the phone key, so a person with a
-- WEB-only inbox grant and no phone key loses Instagram live updates in the
-- unified and Instagram inboxes (realtime authorises each row through this
-- policy) and falls back to the 60-second poll, exactly as on WhatsApp. The
-- /api routes, which judge web OR phone, are unaffected. Controller decision.
--
-- Untouched: the ig_*_deny_insert/update/delete and ig_*_deny_anon policies,
-- every grant (GRANT DECISION: none; SELECT stays with authenticated, the
-- policy now also names authenticated instead of public), and every
-- WhatsApp table. One permissive SELECT policy per table remains.
--
-- AFTER APPLYING: run the security advisor; refresh supabase/schema/access.json
-- (and the snapshot); run tests/role-access.test.js (the Instagram cases pin
-- this), check:rls-restrictive and check:schema-snapshot.

BEGIN;

DROP POLICY IF EXISTS ig_conv_select ON public.instagram_conversations;
CREATE POLICY ig_conv_select ON public.instagram_conversations
  FOR SELECT TO authenticated
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('whatsapp'))::uuid[]));

DROP POLICY IF EXISTS ig_msg_select ON public.instagram_messages;
CREATE POLICY ig_msg_select ON public.instagram_messages
  FOR SELECT TO authenticated
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('whatsapp'))::uuid[]));

-- Self-check: exactly one permissive SELECT policy per table, on the inbox key.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('instagram_conversations', 'ig_conv_select'), ('instagram_messages', 'ig_msg_select')) v(tbl, pol) LOOP
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND cmd = 'SELECT' AND permissive = 'PERMISSIVE') <> 1 THEN
      RAISE EXCEPTION 'mig 875: % must have exactly one permissive SELECT policy', r.tbl;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.pol
                     AND cmd = 'SELECT' AND roles = '{authenticated}' AND qual LIKE '%location_id = ANY%' AND qual LIKE '%auth_mobile_can_location_ids(''whatsapp''%') THEN
      RAISE EXCEPTION 'mig 875: % is not on the inbox key', r.pol;
    END IF;
  END LOOP;
END $$;

COMMIT;
