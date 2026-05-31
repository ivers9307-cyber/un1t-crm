-- 231: RADAR-AGENT Phase 1 (Instagram) — IG conversations + messages.
--
-- Deliberately SEPARATE from the whatsapp_* tables (which are
-- WhatsApp-specific: wa_phone, 24h window, broadcasts). Instagram DMs
-- get their own pair, reusing the same channel-agnostic agent brain
-- (src/lib/agent). Zero risk to the live WhatsApp inbox.
--
-- Identity: Instagram identifies a customer by their IGSID (stored as
-- ig_user_id). The studio's own IG business account id lives on
-- channel_connections (mig 230) and is matched at webhook time to
-- resolve the location.
--
-- RLS mirrors whatsapp_numbers / channel_connections: read = staff
-- assigned to the location (+ master); writes are service-role only.

CREATE TABLE IF NOT EXISTS public.instagram_conversations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  channel_connection_id  uuid REFERENCES public.channel_connections(id) ON DELETE SET NULL,
  contact_id             uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ig_user_id             text NOT NULL,
  ig_username            text,
  status                 text NOT NULL DEFAULT 'active',
  last_message_at        timestamptz,
  last_message_direction text,
  last_message_preview   text,
  unread_count           integer NOT NULL DEFAULT 0,
  assigned_to            uuid,
  agent_active           boolean NOT NULL DEFAULT true,
  agent_handed_off_at    timestamptz,
  agent_last_reply_at    timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_conv_location_user
  ON public.instagram_conversations (location_id, ig_user_id);
CREATE INDEX IF NOT EXISTS idx_ig_conv_location
  ON public.instagram_conversations (location_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.instagram_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES public.instagram_conversations(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  location_id      uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  ig_message_id    text,
  direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_type     text NOT NULL DEFAULT 'text',
  body             text,
  status           text,
  source           text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ig_msg_conversation
  ON public.instagram_messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_msg_mid
  ON public.instagram_messages (ig_message_id) WHERE ig_message_id IS NOT NULL;

ALTER TABLE public.instagram_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_messages      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ig_conv_select ON public.instagram_conversations;
CREATE POLICY ig_conv_select ON public.instagram_conversations
  FOR SELECT
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = instagram_conversations.location_id
                 AND pl.profile_id = auth.uid())
  );

DROP POLICY IF EXISTS ig_conv_deny_writes ON public.instagram_conversations;
CREATE POLICY ig_conv_deny_writes ON public.instagram_conversations
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ig_msg_select ON public.instagram_messages;
CREATE POLICY ig_msg_select ON public.instagram_messages
  FOR SELECT
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = instagram_messages.location_id
                 AND pl.profile_id = auth.uid())
  );

DROP POLICY IF EXISTS ig_msg_deny_writes ON public.instagram_messages;
CREATE POLICY ig_msg_deny_writes ON public.instagram_messages
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);
