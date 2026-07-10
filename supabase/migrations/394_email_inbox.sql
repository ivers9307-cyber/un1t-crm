-- 394: EMAIL-INBOX.1 — email as the third unified-inbox channel.
--
-- A lead replying to a campaign email is the hottest lead there is,
-- but replies previously landed in an external mailbox the CRM never
-- saw. This pair mirrors instagram_conversations / instagram_messages
-- (mig 231) so email plugs into the same queue/resolve/assign model:
--   • ONE conversation per (location_id, counterpart_email) — the
--     email twin of IG's (location_id, ig_user_id). RFC threading
--     headers resolve WHO/WHERE for new senders (see
--     src/lib/email-inbox.js); they don't split conversations.
--   • Message rows keep both bodies: text_body is what the inbox
--     renders (plain text only — no raw-HTML injection surface);
--     html_body is stored (capped app-side at 300k chars) for
--     future full-fidelity display.
--
-- Identity/ingest: Postmark inbound webhook at
-- /api/webhooks/postmark-inbound/[token] (token-in-URL, same pattern
-- as invoices-inbound). Replies land here because outbound campaign +
-- marketing mail sets Reply-To to locations.email_inbox_reply_to
-- (added below) — the per-location Postmark inbound address.
--
-- RLS mirrors the IG pair: read = staff assigned to the location
-- (+ master); all authenticated/anon writes denied (every write path
-- is a service-role /api route that re-imposes location scoping in
-- app code). auth.uid() wrapped in (SELECT ...) per the initplan
-- advisor; single permissive SELECT policy per table, scoped TO
-- authenticated.

-- ── Per-location Reply-To / inbound address ─────────────────────────
-- The Postmark inbound-stream address (or a forwarding alias of it)
-- for this studio. When set, campaign + marketing sends stamp it as
-- Reply-To so replies flow back into the CRM; the inbound webhook
-- also uses it to resolve which location an unmatched email belongs
-- to. NULL = email channel off for the location.
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS email_inbox_reply_to text
    CHECK (email_inbox_reply_to IS NULL
           OR email_inbox_reply_to ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

COMMENT ON COLUMN public.locations.email_inbox_reply_to IS
  'EMAIL-INBOX.1 (mig 394): Postmark inbound address used as Reply-To on campaign/marketing sends; inbound webhook resolves location by matching recipients against it. NULL = email inbox channel disabled.';

-- Recipient→location resolution must be unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS locations_email_inbox_reply_to_uidx
  ON public.locations (lower(email_inbox_reply_to))
  WHERE email_inbox_reply_to IS NOT NULL;

-- ── Conversations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_conversations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id             uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  counterpart_email      text NOT NULL,
  counterpart_name       text,
  subject                text,
  status                 text NOT NULL DEFAULT 'active',
  last_message_at        timestamptz,
  last_message_direction text,
  last_message_preview   text,
  unread_count           integer NOT NULL DEFAULT 0,
  assigned_to            uuid,
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_conversations IS
  'EMAIL-INBOX.1: one row per (location, external email address) — the email twin of instagram_conversations. subject = most recent inbound subject.';
COMMENT ON COLUMN public.email_conversations.resolved_at IS
  'UIX-P1 semantics (mig 255): operator marked handled. NULL + last inbound = Needs-reply queue. Auto-cleared by the inbound webhook.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_conv_location_counterpart
  ON public.email_conversations (location_id, counterpart_email);
CREATE INDEX IF NOT EXISTS idx_email_conv_location
  ON public.email_conversations (location_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_conv_contact
  ON public.email_conversations (contact_id);

-- ── Messages ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_inbox_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES public.email_conversations(id) ON DELETE CASCADE,
  contact_id           uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  location_id          uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_email           text,
  to_email             text,
  subject              text,
  text_body            text,
  html_body            text,
  -- Postmark ids: postmark_message_id is Postmark's API MessageID
  -- (inbound payload / outbound send result); rfc_message_id is the
  -- email's own RFC 5322 Message-ID header, stored so a reply can set
  -- In-Reply-To/References correctly.
  postmark_message_id  text,
  rfc_message_id       text,
  in_reply_to          text,
  references_header    text,
  source               text,
  status               text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.email_inbox_messages.html_body IS
  'Raw HtmlBody, truncated app-side at 300k chars (HTML_BODY_MAX_CHARS). NEVER rendered raw in the UI — the inbox renders text_body only.';

CREATE INDEX IF NOT EXISTS idx_email_msg_conversation
  ON public.email_inbox_messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_msg_postmark_id
  ON public.email_inbox_messages (postmark_message_id) WHERE postmark_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_msg_contact
  ON public.email_inbox_messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_email_msg_location
  ON public.email_inbox_messages (location_id);

-- ── RLS (mirrors instagram_* — mig 231, with the initplan wrap) ─────
ALTER TABLE public.email_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_inbox_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_conv_select ON public.email_conversations;
CREATE POLICY email_conv_select ON public.email_conversations
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_conversations.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_conv_deny_writes ON public.email_conversations;
CREATE POLICY email_conv_deny_writes ON public.email_conversations
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_msg_select ON public.email_inbox_messages;
CREATE POLICY email_msg_select ON public.email_inbox_messages
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_inbox_messages.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_msg_deny_writes ON public.email_inbox_messages;
CREATE POLICY email_msg_deny_writes ON public.email_inbox_messages
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- ── Realtime (mirrors mig 256) — unified inbox gets push updates ────
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_inbox_messages;

-- ── Atomic unread bump (extends the mig 314 family) ─────────────────
CREATE OR REPLACE FUNCTION public.increment_email_conversation_unread(p_conversation_id uuid)
RETURNS void LANGUAGE sql SET search_path = '' AS $$
  UPDATE public.email_conversations
     SET unread_count = coalesce(unread_count, 0) + 1
   WHERE id = p_conversation_id;
$$;
