-- HOST-EMAIL.6 — utility vs marketing categorization for host campaigns.
-- marketing (default): Postmark broadcast stream, requires email_marketing
-- consent, per-host unsubscribe respected. utility: outbound (transactional)
-- stream for operational messages to attendees (time changes, instructions),
-- requires email_administrative consent; marketing opt-outs do NOT block it,
-- deliverability blocks (bounced/complained/suppressed) still do.
ALTER TABLE public.host_campaigns
  ADD COLUMN IF NOT EXISTS email_type text NOT NULL DEFAULT 'marketing'
  CHECK (email_type IN ('marketing', 'utility'));
COMMENT ON COLUMN public.host_campaigns.email_type IS 'HOST-EMAIL.6 — marketing (broadcast stream, email_marketing consent) vs utility (outbound stream, email_administrative consent — operational messages to attendees).';
