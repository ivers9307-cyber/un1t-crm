-- HOST-EMAIL.5 — explicit Reply-To for host campaign emails. NULL falls back
-- to the host login email (the pre-existing behaviour).
ALTER TABLE public.event_hosts ADD COLUMN IF NOT EXISTS reply_to_email text;
COMMENT ON COLUMN public.event_hosts.reply_to_email IS 'HOST-EMAIL.5 — Reply-To on host campaign emails; NULL falls back to the host login email.';
