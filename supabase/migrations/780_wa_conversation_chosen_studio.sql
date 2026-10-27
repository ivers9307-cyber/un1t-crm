-- 780 MIAASKSTUDIO.1 — the studio a WhatsApp customer told Mia they mean.
--
-- Apply BEFORE the MIAASKSTUDIO.1 code deploys: the turn's conversation read
-- selects this column, and PostgREST fails the whole select on a missing one.
--
-- WHY. Mia picks the studio she answers for from the person's memberships
-- (member-studios.js answerableStudios): an active membership wins, else the
-- one studio they hold an account at. A person with accounts at two studios
-- and no active membership at either (Craig Campbell, 27 Oct 2026: a
-- finished Hatch Street trial plus a Stillorgan Glofox account) matched
-- neither rule, so Mia got the no-booking tools, could not send the Hatch
-- Foundation payment link he asked for, and filed a card instead. Now she
-- asks which studio (or reads it off the thread), calls choose_studio, and
-- the answer is kept here so every later turn in the thread uses it.
--
-- Written only by the service-role agent runner (auto-reply.js). Nothing
-- secret: authenticated keeps its table-level SELECT on the table, and no
-- client write exists (mig 661).

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN agent_chosen_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.whatsapp_conversations.agent_chosen_location_id IS
  'MIAASKSTUDIO.1 (mig 780): the studio the customer told Mia they mean, used only when their memberships do not decide it (accounts at several studios, active at none). Written by the agent runner''s choose_studio tool.';
