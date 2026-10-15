-- 723_move_whatsapp_conversation.sql
-- WAHOMESTUDIO.1 — re-file (or merge) a WhatsApp thread at another studio of
-- the SAME organisation. Phase 1 of "Mia at organisation level"
-- (docs/superpowers/specs/2026-10-15-wa-home-studio-threads-design.md, R7).
--
-- Used by mig 724 (the one-off backfill of threads WANUMBERLESS.1 filed at the
-- receiving studio) and by POST /api/whatsapp/conversations/[id]/move.
--   * target in another organisation, or the thread's own studio → refused;
--   * no thread at the target for this wa_phone → the row is re-filed;
--   * one exists → MERGED into it: messages re-pointed, target row kept
--     (newest last_message_*, summed unread), the emptied source deleted;
--   * whatsapp_messages.location_id and the channel='whatsapp' rows of the four
--     agent tables follow the thread (a same-day review clash keeps the
--     target's review);
--   * a thread with no number stamp gets the SOURCE studio's default number,
--     the number it was talking through (getConversationNumberConfig, R4).
-- SECURITY INVOKER: only service_role may execute it (mig 667 rule), and
-- service_role bypasses RLS.
BEGIN;
SET LOCAL lock_timeout = '5s';

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
    SELECT n.id FROM public.whatsapp_numbers n
     WHERE n.location_id = v_conv.location_id AND n.is_active
     ORDER BY n.is_default DESC, n.updated_at DESC
     LIMIT 1));

  SELECT id INTO v_target_id FROM public.whatsapp_conversations
   WHERE location_id = p_target_location_id AND wa_phone IS NOT DISTINCT FROM v_conv.wa_phone
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
      last_message_direction = CASE WHEN v_conv.last_message_at > COALESCE(t.last_message_at, '-infinity') THEN v_conv.last_message_direction ELSE t.last_message_direction END,
      last_message_preview = CASE WHEN v_conv.last_message_at > COALESCE(t.last_message_at, '-infinity') THEN v_conv.last_message_preview ELSE t.last_message_preview END,
      last_message_at = GREATEST(t.last_message_at, v_conv.last_message_at),
      whatsapp_number_id = COALESCE(t.whatsapp_number_id, v_stamp)
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
