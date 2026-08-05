-- EMAIL-TICKET.1 — email becomes a ticketing system.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- WHY
-- Mig 394 modelled email on the Instagram twin: ONE conversation per
-- (location_id, counterpart_email), forever, with a two-state resolved_at.
-- That is right for a chat channel and wrong for support correspondence. A
-- member who emails about billing in January and a class in March lands in
-- the same row, and there is no way to say one is handled and the other is not.
--
-- Mig 213 (`issues`) already had the right lifecycle — open/in_progress/
-- resolved/closed with claim-to-assign and bucket-backed attachments — but its
-- only channel was an in-app form. This marries the two.
--
-- THE DELIBERATE ABSENCE
-- There is NO unique index on (location_id, requester_email). That absence is
-- the whole point: one person may hold many concurrent tickets. Mig 394's
-- idx_email_conv_location_counterpart is what made a conversation immortal.
--
-- SCOPE: email only. whatsapp_conversations and instagram_conversations keep
-- today's resolve model and are not touched by this or any later migration in
-- this program.
--
-- NOTHING READS THESE TABLES YET. The webhook and send routes cut over in a
-- later PR; this migration plus its backfill (483) are inert on their own.

-- ── Tickets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_tickets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id             uuid REFERENCES public.contacts(id) ON DELETE SET NULL,

  -- Reserved for v2 queues (Billing / Memberships / General) + per-queue
  -- grants. Always NULL today. No FK and no table yet, deliberately: the
  -- column exists so adding queues later is additive, the same trick mig 213
  -- used by reserving `closed` up front.
  queue_id               uuid,

  requester_email        text NOT NULL,
  requester_name         text,
  subject                text,

  status                 text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','pending','solved','closed')),
  priority               text NOT NULL DEFAULT 'normal'
                           CHECK (priority IN ('low','normal','high')),

  assigned_to            uuid,
  reopened_from          uuid REFERENCES public.email_tickets(id) ON DELETE SET NULL,

  first_response_at      timestamptz,
  last_message_at        timestamptz,
  last_message_direction text,
  last_message_preview   text,
  unread_count           integer NOT NULL DEFAULT 0,

  solved_at              timestamptz,
  closed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_tickets IS
  'EMAIL-TICKET.1: one row per ISSUE, not per person. Replaces email_conversations (mig 394), which is retained read-only for one release and dropped later. Deliberately has NO unique index on (location_id, requester_email).';
COMMENT ON COLUMN public.email_tickets.queue_id IS
  'EMAIL-TICKET.1: reserved for v2 queues + per-queue grants. Always NULL in v1; no FK and no queues table yet.';
COMMENT ON COLUMN public.email_tickets.reopened_from IS
  'EMAIL-TICKET.1: set when an inbound reply threaded to a CLOSED ticket. The closed ticket stays closed; this is its successor.';
COMMENT ON COLUMN public.email_tickets.first_response_at IS
  'EMAIL-TICKET.1: first OUTBOUND non-note message. Internal notes never stamp it — the member never saw them.';

CREATE INDEX IF NOT EXISTS idx_email_tickets_loc_status
  ON public.email_tickets (location_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_tickets_loc_assigned
  ON public.email_tickets (location_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_email_tickets_contact
  ON public.email_tickets (contact_id);
CREATE INDEX IF NOT EXISTS idx_email_tickets_requester
  ON public.email_tickets (location_id, lower(requester_email));
CREATE INDEX IF NOT EXISTS idx_email_tickets_reopened_from
  ON public.email_tickets (reopened_from);

-- ── Message columns ─────────────────────────────────────────────────
-- conversation_id is retained through the transition and dropped with
-- email_conversations, per the deprecated-columns-stay-on-disk convention.
ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS ticket_id        uuid REFERENCES public.email_tickets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS cc_emails        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS bcc_emails       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_internal_note boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.email_inbox_messages.bcc_emails IS
  'EMAIL-TICKET.1: audit only. Written from compose, put on the wire to Postmark, and thereafter read only by staff on the ticket. MUST NEVER be rendered in any member-visible context.';
COMMENT ON COLUMN public.email_inbox_messages.is_internal_note IS
  'EMAIL-TICKET.1: staff-only note on a ticket. Never sent, never carries cc/bcc, never stamps first_response_at.';

CREATE INDEX IF NOT EXISTS idx_email_msg_ticket
  ON public.email_inbox_messages (ticket_id, created_at);

-- ── Attachments ─────────────────────────────────────────────────────
-- Same shape as issue_attachments (mig 213): rows record path/mime/size, the
-- bytes live in a private bucket reached by short-lived signed URLs.
--
-- storage_path is NULLABLE on purpose. When the mailbox quota is full (a later
-- PR) the message still persists in full and the attachment is recorded with
-- storage_path NULL + skipped_reason, so staff see "not stored" and can ask
-- for a resend. A silent drop would be far worse than a visible one.
CREATE TABLE IF NOT EXISTS public.email_ticket_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     uuid NOT NULL REFERENCES public.email_inbox_messages(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  storage_path   text,
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL,
  skipped_reason text CHECK (skipped_reason IN ('quota','too_large','rehost_failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_attach_stored_xor_skipped
    CHECK ((storage_path IS NOT NULL) <> (skipped_reason IS NOT NULL))
);

COMMENT ON TABLE public.email_ticket_attachments IS
  'EMAIL-TICKET.1: attachment metadata; bytes live in the private email-attachments bucket. storage_path NULL + skipped_reason set = accepted the message but did not store the file (see the quota behaviour in a later PR).';

CREATE INDEX IF NOT EXISTS idx_email_attach_message
  ON public.email_ticket_attachments (message_id);

-- ── Storage bucket ──────────────────────────────────────────────────
-- PRIVATE. Inbound attachments are arbitrary files from unauthenticated
-- strangers, so no public read and no MIME allowlist (we must store what
-- members actually send); access is a short-lived signed URL minted per view
-- by a service-role route that checks location access first. 25MB per file
-- matches Postmark's inbound limit — anything larger never reaches us.
-- Same posture as fleet-screenshots (mig 477) and car-documents (mig 025).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('email-attachments', 'email-attachments', FALSE, 26214400)
ON CONFLICT (id) DO NOTHING;

-- ── RLS (mirrors mig 394 exactly) ───────────────────────────────────
ALTER TABLE public.email_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_ticket_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_ticket_select ON public.email_tickets;
CREATE POLICY email_ticket_select ON public.email_tickets
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_tickets.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_ticket_deny_writes ON public.email_tickets;
CREATE POLICY email_ticket_deny_writes ON public.email_tickets
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_attach_select ON public.email_ticket_attachments;
CREATE POLICY email_attach_select ON public.email_ticket_attachments
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_ticket_attachments.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_attach_deny_writes ON public.email_ticket_attachments;
CREATE POLICY email_attach_deny_writes ON public.email_ticket_attachments
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- ── Realtime (mirrors mig 394) ──────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_tickets;

-- ── Atomic unread bump (extends the mig 314 family) ─────────────────
CREATE OR REPLACE FUNCTION public.increment_email_ticket_unread(p_ticket_id uuid)
RETURNS void LANGUAGE sql SET search_path = '' AS $$
  UPDATE public.email_tickets
     SET unread_count = coalesce(unread_count, 0) + 1
   WHERE id = p_ticket_id;
$$;
