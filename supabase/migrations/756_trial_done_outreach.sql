-- 756 — TRIALDONE.1: trial_done_outreach
-- (Hatch Street trial-done conversion: a trial finisher gets a WhatsApp opener
-- once, and at most one follow-up).
--
--   One row per person per studio. unique (location_id, contact_id) is the
--   once-ever fence: the runner inserts the row to claim a person, and a second
--   tick (or a second runner) reads 23505 as "already recorded". A person who
--   finishes a second trial later is NOT contacted again; that is the point.
--
--   trigger_kind     why they qualified: three_attended (all three trial
--                    classes attended) or two_attended_expired (two attended,
--                    credits ran out unused).
--   opener_*         the first message: claimed (lease) then sent, with the
--                    WhatsApp message id once Meta accepts it.
--   followup_*       the single follow-up: a template or a free-form nudge
--                    (inside the 24h window), same claim/send/id shape.
--   closed_at/reason the sequence ended (replied, booked, bought, opted out,
--                    ...). Open rows are the partial index below.
--   deal_id          the contact's pipeline deal when the row was made; no FK
--                    (deals can be merged or removed, the history stays).
--
-- Closed to every client session (mig 677 / mig 752 pattern): RLS on, no
-- policy, nothing for anon/authenticated, the four DML privileges for
-- service_role. Staff reach this through /api routes.
--
-- Forward-only, idempotent (IF NOT EXISTS throughout).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.trial_done_outreach (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id             uuid        NOT NULL REFERENCES public.locations(id),
  contact_id              uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  deal_id                 uuid,
  trigger_kind            text        NOT NULL
    CONSTRAINT trial_done_outreach_trigger_kind_check
    CHECK (trigger_kind IN ('three_attended', 'two_attended_expired')),
  trigger_at              timestamptz NOT NULL,
  opener_claimed_at       timestamptz,
  opener_sent_at          timestamptz,
  opener_wa_message_id    text,
  followup_kind           text
    CONSTRAINT trial_done_outreach_followup_kind_check
    CHECK (followup_kind IN ('template', 'nudge')),
  followup_claimed_at     timestamptz,
  followup_sent_at        timestamptz,
  followup_wa_message_id  text,
  closed_at               timestamptz,
  closed_reason           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_done_outreach_location_contact_key UNIQUE (location_id, contact_id)
);

-- Unindexed-FK advisor: the contact ON DELETE CASCADE scans this table without
-- it (location_id leads the unique index, contact_id does not).
CREATE INDEX IF NOT EXISTS trial_done_outreach_contact_id
  ON public.trial_done_outreach (contact_id);

-- The runner's working set: rows still open at a studio.
CREATE INDEX IF NOT EXISTS trial_done_outreach_open
  ON public.trial_done_outreach (location_id)
  WHERE closed_at IS NULL;

COMMENT ON TABLE public.trial_done_outreach IS
  'TRIALDONE.1 (mig 756): one row per trial finisher per studio (Hatch Street trial-done conversion spec): the WhatsApp opener and at most one follow-up, recorded once ever. unique (location_id, contact_id) is the once-only fence. Service role only.';

ALTER TABLE public.trial_done_outreach ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.trial_done_outreach FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trial_done_outreach TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'trial_done_outreach' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'mig 756: row level security is not enabled on trial_done_outreach';
  END IF;
END $$;

COMMIT;
