-- 736_wa_org_numbers.sql
-- WAORGNUMBER.1 — WhatsApp numbers are owned by the ORGANISATION and switched on
-- per studio (docs/superpowers/specs/2026-10-17-wa-org-shared-numbers-design.md, R1).
--
--   * whatsapp_numbers.organization_id (NOT NULL, FK organizations), backfilled
--     from the row's location. whatsapp_numbers.location_id stays and now means
--     the number's HOME studio (comment below).
--   * public.location_whatsapp_numbers: "this number is switched on at this
--     studio". PK (location_id, whatsapp_number_id); at most one is_default per
--     studio. Backfilled one row per existing number, so Stillorgan keeps exactly
--     what it has; Hatch is NOT switched on here (that is the go-live tick).
--   * private.location_whatsapp_numbers_same_org(): a link may never cross
--     organisations (BEFORE INSERT OR UPDATE).
--   * whatsapp_numbers.is_default is DEPRECATED: the per-studio default lives on
--     the link table. It stays on disk and is still written for one release.
--   * move_whatsapp_conversation (mig 723) re-created: an unstamped thread is
--     stamped with the source studio's LINK default (then the newest link), not
--     the number's own home-studio default.
--
-- Applied BEFORE the app code that understands it merges, so two triggers keep
-- today's code working: a number inserted without organization_id gets it from
-- its location (BEFORE INSERT), and a newly inserted number is switched on at
-- its home studio (AFTER INSERT; default only when that studio has no default
-- yet). Both are what the new code will do explicitly; ON CONFLICT DO NOTHING
-- keeps them harmless once it does.
--
-- Trigger functions need no EXECUTE grant (CLAUDE.md, mig 667); the REVOKEs
-- state that decision (tests/function-execute-guard, private-function guard).
-- The link table is closed to clients: RLS on with no policy, no client privilege.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1-3. organization_id: add nullable, backfill, then tighten.
ALTER TABLE public.whatsapp_numbers ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.whatsapp_numbers n
   SET organization_id = l.organization_id
  FROM public.locations l
 WHERE l.id = n.location_id AND n.organization_id IS NULL;

ALTER TABLE public.whatsapp_numbers ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.whatsapp_numbers DROP CONSTRAINT IF EXISTS whatsapp_numbers_organization_id_fkey;
ALTER TABLE public.whatsapp_numbers
  ADD CONSTRAINT whatsapp_numbers_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_organization ON public.whatsapp_numbers (organization_id);

-- 4. The switch-on table, its same-organisation fence and its one-default index.
CREATE TABLE IF NOT EXISTS public.location_whatsapp_numbers (
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  whatsapp_number_id uuid NOT NULL REFERENCES public.whatsapp_numbers(id) ON DELETE CASCADE,
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NULL,
  PRIMARY KEY (location_id, whatsapp_number_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS location_whatsapp_numbers_one_default
  ON public.location_whatsapp_numbers (location_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_location_whatsapp_numbers_number
  ON public.location_whatsapp_numbers (whatsapp_number_id);
ALTER TABLE public.location_whatsapp_numbers ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION private.location_whatsapp_numbers_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_number_org uuid;
  v_location_org uuid;
BEGIN
  SELECT organization_id INTO v_number_org FROM public.whatsapp_numbers WHERE id = NEW.whatsapp_number_id;
  SELECT organization_id INTO v_location_org FROM public.locations WHERE id = NEW.location_id;
  IF v_number_org IS DISTINCT FROM v_location_org THEN
    RAISE EXCEPTION 'whatsapp number % belongs to another organisation', NEW.whatsapp_number_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.location_whatsapp_numbers_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_location_whatsapp_numbers_same_org ON public.location_whatsapp_numbers;
CREATE TRIGGER trg_location_whatsapp_numbers_same_org
  BEFORE INSERT OR UPDATE ON public.location_whatsapp_numbers
  FOR EACH ROW EXECUTE FUNCTION private.location_whatsapp_numbers_same_org();

-- 5. One link row per existing number: (home studio, number, its current default flag).
INSERT INTO public.location_whatsapp_numbers (location_id, whatsapp_number_id, is_default)
SELECT location_id, id, COALESCE(is_default, false) FROM public.whatsapp_numbers
ON CONFLICT DO NOTHING;

-- 6. Closed to every client session (mig 677 default says so too; state it).
REVOKE ALL ON public.location_whatsapp_numbers FROM anon, authenticated;

-- Compatibility for code that predates this migration (see the header).
CREATE OR REPLACE FUNCTION private.whatsapp_numbers_fill_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT l.organization_id INTO NEW.organization_id FROM public.locations l WHERE l.id = NEW.location_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.whatsapp_numbers_fill_organization() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whatsapp_numbers_fill_organization ON public.whatsapp_numbers;
CREATE TRIGGER trg_whatsapp_numbers_fill_organization
  BEFORE INSERT ON public.whatsapp_numbers
  FOR EACH ROW EXECUTE FUNCTION private.whatsapp_numbers_fill_organization();

-- SECURITY DEFINER: the link table is closed to clients and the inserting role
-- may be any role that can insert a number. The advisory lock (per home studio,
-- released at commit) serialises two numbers inserted at one studio, so both
-- cannot see "no default yet": the partial unique index would then swallow the
-- second link row through ON CONFLICT DO NOTHING and leave that number switched
-- off. A conflict on the PK (the code already linked it) is still a quiet no-op.
CREATE OR REPLACE FUNCTION private.whatsapp_numbers_switch_on_at_home()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wa_link_default:' || NEW.location_id::text));
  INSERT INTO public.location_whatsapp_numbers (location_id, whatsapp_number_id, is_default)
  VALUES (
    NEW.location_id, NEW.id,
    NOT EXISTS (SELECT 1 FROM public.location_whatsapp_numbers x WHERE x.location_id = NEW.location_id AND x.is_default))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.whatsapp_numbers_switch_on_at_home() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whatsapp_numbers_switch_on_at_home ON public.whatsapp_numbers;
CREATE TRIGGER trg_whatsapp_numbers_switch_on_at_home
  AFTER INSERT ON public.whatsapp_numbers
  FOR EACH ROW EXECUTE FUNCTION private.whatsapp_numbers_switch_on_at_home();

-- The other half of the organisation fence: the link trigger judges a link when
-- it is written, so changing a NUMBER's organization_id afterwards (or its home
-- studio into another organisation) could leave a link pointing across
-- organisations. Refuse that change while any such link exists. Moving the home
-- studio within the same organisation stays allowed.
CREATE OR REPLACE FUNCTION private.whatsapp_numbers_org_change_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.location_whatsapp_numbers l
      JOIN public.locations loc ON loc.id = l.location_id
     WHERE l.whatsapp_number_id = NEW.id
       AND loc.organization_id IS DISTINCT FROM NEW.organization_id) THEN
    RAISE EXCEPTION 'whatsapp number % belongs to another organisation than a studio it is switched on at', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.whatsapp_numbers_org_change_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whatsapp_numbers_org_change_guard ON public.whatsapp_numbers;
CREATE TRIGGER trg_whatsapp_numbers_org_change_guard
  BEFORE UPDATE OF organization_id, location_id ON public.whatsapp_numbers
  FOR EACH ROW EXECUTE FUNCTION private.whatsapp_numbers_org_change_guard();

-- 7-8. What the columns mean now.
COMMENT ON COLUMN public.whatsapp_numbers.location_id IS
  'Home studio: new-enquiry threads and coexistence history land here (WAORGNUMBER R1)';
COMMENT ON COLUMN public.whatsapp_numbers.is_default IS
  'DEPRECATED (mig 736): the per-studio default is location_whatsapp_numbers.is_default. Still written for one release; a later migration drops it.';

-- 9. mig 723's function, verbatim, except the stamp subquery: the source
-- studio's link default (then the newest link) among its ACTIVE numbers.
-- CREATE OR REPLACE keeps the ACL mig 723 set (service_role only).
CREATE OR REPLACE FUNCTION public.move_whatsapp_conversation(p_conversation_id uuid, p_target_location_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv public.whatsapp_conversations%ROWTYPE;
  v_source_org uuid;
  v_target_org uuid;
  v_target_id uuid;
  v_stamp uuid;
  v_merged boolean := false;
BEGIN
  SELECT * INTO v_conv FROM public.whatsapp_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_conv.location_id = p_target_location_id THEN
    RAISE EXCEPTION 'same_studio' USING ERRCODE = '22023';
  END IF;
  SELECT organization_id INTO v_source_org FROM public.locations WHERE id = v_conv.location_id;
  SELECT organization_id INTO v_target_org FROM public.locations WHERE id = p_target_location_id;
  IF v_target_org IS NULL OR v_source_org IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'other_organisation' USING ERRCODE = '22023';
  END IF;

  v_stamp := COALESCE(v_conv.whatsapp_number_id, (
    SELECT n.id FROM public.location_whatsapp_numbers l
      JOIN public.whatsapp_numbers n ON n.id = l.whatsapp_number_id
     WHERE l.location_id = v_conv.location_id AND n.is_active
     ORDER BY l.is_default DESC, l.created_at DESC, n.updated_at DESC
     LIMIT 1));

  SELECT id INTO v_target_id FROM public.whatsapp_conversations
   WHERE location_id = p_target_location_id
     AND ((v_conv.wa_phone IS NOT NULL AND wa_phone = v_conv.wa_phone)
       OR (v_conv.wa_bsuid IS NOT NULL AND wa_bsuid = v_conv.wa_bsuid))
   ORDER BY (v_conv.wa_phone IS NOT NULL AND wa_phone = v_conv.wa_phone) DESC
   LIMIT 1
   FOR UPDATE;

  IF v_target_id IS NULL THEN
    UPDATE public.whatsapp_conversations
       SET location_id = p_target_location_id, whatsapp_number_id = v_stamp
     WHERE id = v_conv.id;
    v_target_id := v_conv.id;
  ELSE
    v_merged := true;
    UPDATE public.whatsapp_messages SET conversation_id = v_target_id WHERE conversation_id = v_conv.id;
    UPDATE public.whatsapp_conversations t SET
      contact_id = COALESCE(t.contact_id, v_conv.contact_id),
      unread_count = COALESCE(t.unread_count, 0) + COALESCE(v_conv.unread_count, 0),
      window_expires_at = GREATEST(t.window_expires_at, v_conv.window_expires_at),
      window_open_at = GREATEST(t.window_open_at, v_conv.window_open_at),
      last_message_direction = CASE WHEN v_conv.last_message_at > COALESCE(t.last_message_at, '-infinity') THEN v_conv.last_message_direction ELSE t.last_message_direction END,
      last_message_preview = CASE WHEN v_conv.last_message_at > COALESCE(t.last_message_at, '-infinity') THEN v_conv.last_message_preview ELSE t.last_message_preview END,
      last_message_at = GREATEST(t.last_message_at, v_conv.last_message_at),
      whatsapp_number_id = COALESCE(t.whatsapp_number_id, v_stamp),
      is_blocked = t.is_blocked OR v_conv.is_blocked,
      agent_active = t.agent_active AND v_conv.agent_active,
      agent_paused_at = COALESCE(t.agent_paused_at, v_conv.agent_paused_at),
      agent_handed_off_at = GREATEST(t.agent_handed_off_at, v_conv.agent_handed_off_at),
      agent_last_reply_at = GREATEST(t.agent_last_reply_at, v_conv.agent_last_reply_at),
      handoff_escalated_at = GREATEST(t.handoff_escalated_at, v_conv.handoff_escalated_at),
      agent_activity_notified_at = GREATEST(t.agent_activity_notified_at, v_conv.agent_activity_notified_at),
      agent_followup_sent_at = GREATEST(t.agent_followup_sent_at, v_conv.agent_followup_sent_at),
      agent_followup_stage = GREATEST(t.agent_followup_stage, v_conv.agent_followup_stage),
      agent_verify_attempts = GREATEST(t.agent_verify_attempts, v_conv.agent_verify_attempts),
      agent_verified_contact_id = CASE WHEN v_conv.agent_verified_at IS NOT NULL
        AND (t.agent_verified_at IS NULL OR v_conv.agent_verified_at > t.agent_verified_at)
        THEN v_conv.agent_verified_contact_id ELSE t.agent_verified_contact_id END,
      agent_verified_at = CASE WHEN v_conv.agent_verified_at IS NOT NULL
        AND (t.agent_verified_at IS NULL OR v_conv.agent_verified_at > t.agent_verified_at)
        THEN v_conv.agent_verified_at ELSE t.agent_verified_at END,
      assigned_to = COALESCE(t.assigned_to, v_conv.assigned_to),
      wa_bsuid = COALESCE(t.wa_bsuid, v_conv.wa_bsuid),
      wa_profile_name = COALESCE(t.wa_profile_name, v_conv.wa_profile_name),
      ctwa_clid = COALESCE(t.ctwa_clid, v_conv.ctwa_clid),
      resolved_at = CASE WHEN t.resolved_at IS NULL OR v_conv.resolved_at IS NULL THEN NULL
                         ELSE GREATEST(t.resolved_at, v_conv.resolved_at) END,
      created_at = LEAST(t.created_at, v_conv.created_at)
     WHERE t.id = v_target_id;
    DELETE FROM public.agent_conversation_reviews s
     WHERE s.channel = 'whatsapp' AND s.conversation_id = v_conv.id
       AND EXISTS (SELECT 1 FROM public.agent_conversation_reviews t
                    WHERE t.channel = 'whatsapp' AND t.conversation_id = v_target_id AND t.review_date = s.review_date);
  END IF;

  UPDATE public.whatsapp_messages SET location_id = p_target_location_id
   WHERE conversation_id = v_target_id AND location_id IS DISTINCT FROM p_target_location_id;
  UPDATE public.agent_decisions SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  UPDATE public.agent_membership_requests SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  UPDATE public.agent_message_feedback SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  UPDATE public.agent_conversation_reviews SET conversation_id = v_target_id, location_id = p_target_location_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;
  -- mig 585: a soft ref (no FK), read by the approve path to answer in-thread.
  -- location_id stays the ISSUING studio: confirm.js finds the link and sends by it.
  UPDATE public.cancellation_form_links SET conversation_id = v_target_id
   WHERE channel = 'whatsapp' AND conversation_id = v_conv.id;

  IF v_merged THEN
    DELETE FROM public.whatsapp_conversations WHERE id = v_conv.id;
  END IF;

  RETURN jsonb_build_object(
    'conversation_id', v_target_id, 'merged', v_merged,
    'from_location_id', v_conv.location_id, 'to_location_id', p_target_location_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.move_whatsapp_conversation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_whatsapp_conversation(uuid, uuid) TO service_role;

COMMIT;
