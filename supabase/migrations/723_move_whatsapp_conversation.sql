-- 723_move_whatsapp_conversation.sql
-- WAHOMESTUDIO.1 — re-file (or merge) a WhatsApp thread at another studio of
-- the SAME organisation. Phase 1 of "Mia at organisation level"
-- (docs/superpowers/specs/2026-10-15-wa-home-studio-threads-design.md, R7).
--
-- Used by mig 724 (the one-off backfill of threads WANUMBERLESS.1 filed at the
-- receiving studio) and by POST /api/whatsapp/conversations/[id]/move.
--   * target in another organisation, or the thread's own studio → refused;
--   * no thread at the target for this wa_phone, nor for this wa_bsuid (the
--     live partial unique (location_id, wa_bsuid) would refuse a second one) →
--     the row is re-filed;
--   * one exists (phone match preferred, else bsuid match) → MERGED into it:
--     messages re-pointed, target row kept, the emptied source deleted. The
--     per-column rule is safety-first: a block, a takeover or a pause on
--     EITHER thread survives (is_blocked OR, agent_active AND, agent_paused_at
--     COALESCE(t, s)); timestamps and counters take the later/greater; the
--     verified-contact pair follows the later agent_verified_at; the live
--     claim lease agent_processing_at is the target's; resolved_at stays
--     resolved only if both are; created_at is the earlier; status the target's.
--     A merge that copies a wa_bsuid onto the target which another row there
--     already holds raises 23505 (unique_violation); the caller decides.
--   * whatsapp_messages.location_id and the channel='whatsapp' rows of the four
--     agent tables follow the thread (a same-day review clash keeps the
--     target's review); cancellation_form_links (mig 585) follows by
--     conversation_id only (a soft ref with no FK, so a merge would otherwise
--     strand it), keeping location_id at the issuing studio;
--   * a thread with no number stamp gets the SOURCE studio's default number,
--     the number it was talking through (getConversationNumberConfig, R4).
-- SECURITY INVOKER: only service_role may execute it (mig 667 rule), and
-- service_role bypasses RLS.
--
-- Also here (WAHOMESTUDIO.1, Task 4b): a message row belongs to its thread's
-- studio. After the code ships, a broadcast/sequence/automation sender inserts
-- whatsapp_messages.location_id = the SENDING studio into a thread that is now
-- filed at the customer's HOME studio. RLS wa_msg_select (mig 691) reads the
-- MESSAGE's location_id, so a Hatch-only phone user or realtime listener would
-- not see those rows, and the move function above re-files message
-- location_id to the thread's studio: two inconsistent models. One enforcement
-- point, no caller changes: a BEFORE INSERT trigger copies the conversation's
-- location_id onto the message. It must be BEFORE: the AFTER INSERT timeline
-- trigger (log_wa_message_to_timeline) copies the message's location_id into
-- activities. INSERT only: an UPDATE of location_id is the move function's
-- job. Inert today (live check 15 Oct 2026: 0 of 2,962 messages disagree with
-- their conversation's location_id). A message with no conversation, or whose
-- conversation has no location, keeps what the caller sent.
-- A trigger function needs no EXECUTE grant (CLAUDE.md, mig 667), so none is
-- given; the REVOKE states that decision for tests/function-execute-guard.
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

CREATE OR REPLACE FUNCTION public.wa_message_location_from_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_location uuid;
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    SELECT c.location_id INTO v_location FROM public.whatsapp_conversations c WHERE c.id = NEW.conversation_id;
    IF v_location IS NOT NULL THEN
      NEW.location_id := v_location;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.wa_message_location_from_conversation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_wa_message_location_from_conversation ON public.whatsapp_messages;
CREATE TRIGGER trg_wa_message_location_from_conversation
  BEFORE INSERT ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.wa_message_location_from_conversation();

COMMIT;
