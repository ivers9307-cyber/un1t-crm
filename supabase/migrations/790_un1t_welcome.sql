-- 790 — UN1TWELCOME.1: columns behind the un1t.online welcome email.
--
-- first_seen_at       when the CRM first mirrored this client (the welcome
--                     sweep's age cut-off).
-- welcome_checked_at  set once the sweep has looked at the client; NULL means
--                     "not yet considered". Existing rows are marked checked
--                     below, so only accounts created after this ships can
--                     ever get a welcome.
-- account_email_sent_at  set when the account email (CRM-made account) went
--                     out, so the sweep does not send a second welcome.

BEGIN;

ALTER TABLE public.un1t_clients
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS welcome_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS account_email_sent_at timestamptz;

UPDATE public.un1t_clients SET welcome_checked_at = now() WHERE welcome_checked_at IS NULL;

CREATE INDEX IF NOT EXISTS un1t_clients_welcome_due
  ON public.un1t_clients (location_id, first_seen_at)
  WHERE welcome_checked_at IS NULL;

COMMENT ON COLUMN public.un1t_clients.first_seen_at IS 'UN1TWELCOME.1: when the CRM first mirrored this un1t.online client.';
COMMENT ON COLUMN public.un1t_clients.welcome_checked_at IS 'UN1TWELCOME.1: when the welcome sweep last decided about this client; NULL = not yet considered. Rows that existed at mig 790 were marked checked.';
COMMENT ON COLUMN public.un1t_clients.account_email_sent_at IS 'UN1TWELCOME.1: when the account email (CRM-made account) was sent, so the sweep sends no second welcome.';

-- column-grant: n/a (un1t_clients is service-role only, mig 726)

DO $$
BEGIN
  IF (SELECT count(*) FROM public.un1t_clients WHERE welcome_checked_at IS NULL) > 0 THEN
    RAISE EXCEPTION 'mig 790: un1t_clients rows still have welcome_checked_at IS NULL';
  END IF;
END;
$$;

COMMIT;
