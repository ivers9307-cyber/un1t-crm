-- AGENT-CHECKIN.1 — once-ever stamp for Mia's post-first-class
-- check-in (spec: docs/AGENT_FIRST_CLASS_CHECKIN_SPEC.md). Set when
-- the check-in sends; a contact with a value never gets another.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS first_class_checkin_at timestamptz;
