-- 777 HATCHCOLD.2 — contact_pipeline_dismissals: a Cold press at a studio
-- that is NOT the contact's home studio.
--
-- Apply BEFORE the HATCHCOLD.2 code deploys: the Cold route writes this table
-- and Hatch's board pass (un1t pipelineInputs) reads it, and a read of a
-- missing table fails the whole pass.
--
-- WHY. Contacts are shared across an organisation (ORGCONTACTS), so a person
-- whose contact row lives at Stillorgan can sit on Hatch Street's Acquisition
-- board. contacts.pipeline_dismissed_at is the HOME studio's Cold, and Hatch's
-- board rightly ignores another studio's judgement (un1t-online-shape.js), so
-- Cold pressed on Hatch's board for that person had nowhere to land and they
-- never left the board. This table holds exactly that case: one row per
-- (contact, studio) where the studio is not the contact's home. The home
-- studio's Cold stays on contacts.pipeline_dismissed_at (every Glofox reader
-- and the nightly classifier read it there).
--
-- Return to pipeline deletes the row. Service-role only: written by
-- POST /api/contacts/[id]/pipeline-status, read by the board passes.

CREATE TABLE public.contact_pipeline_dismissals (
  contact_id   uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  location_id  uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  -- The staff member who pressed Cold. No FK: profiles are never deleted,
  -- and the audit_events row carries the full actor anyway.
  dismissed_by uuid,
  PRIMARY KEY (contact_id, location_id)
);

-- The board pass reads one studio's rows.
CREATE INDEX contact_pipeline_dismissals_location_idx
  ON public.contact_pipeline_dismissals (location_id);

COMMENT ON TABLE public.contact_pipeline_dismissals IS
  'HATCHCOLD.2 (mig 777): Cold at a studio that is not the contact''s home studio. Home-studio Cold stays on contacts.pipeline_dismissed_at. Service role only.';

ALTER TABLE public.contact_pipeline_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_pipeline_dismissals FROM anon, authenticated;
