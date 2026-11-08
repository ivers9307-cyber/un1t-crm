-- 819 — QUESTIONS.1: registration questions on events, answers on entries.
--
-- WHY. Hosts need to ask at signup: dietary needs, experience level, t-shirt
-- size. Nothing on the registration side held free-form data (no jsonb on
-- race_registrations or team_members). See
-- docs/superpowers/specs/2026-11-08-host-event-features-design.md § 3.
--
-- WHAT.
--   (1) race_events.registration_questions: an ordered jsonb list of
--       { id, label, type text|choice|yes_no, options, required, per entry|person },
--       validated by Zod on write (src/lib/registration-questions.js); NULL =
--       none.
--   (2) race_registrations.answers: the ENTRY's answers { <question id>: value }.
--   (3) team_members.answers: each PERSON's answers, same shape.
--
-- Answers are keyed by question id, so a question edited or removed after
-- signups keeps old answers readable (a vanished id is simply not shown).
-- Grants: the three tables have no client privilege (mig 682); the server
-- reads these on the service role. Safe to apply before the code deploys.

alter table public.race_events
  add column if not exists registration_questions jsonb;
comment on column public.race_events.registration_questions is
  'QUESTIONS.1 (mig 819): ordered question list {id,label,type,options,required,per}; Zod-validated on write; NULL = none.';

alter table public.race_registrations
  add column if not exists answers jsonb;
comment on column public.race_registrations.answers is
  'QUESTIONS.1 (mig 819): the entry-level answers keyed by question id; NULL = none asked or given.';

alter table public.team_members
  add column if not exists answers jsonb;
comment on column public.team_members.answers is
  'QUESTIONS.1 (mig 819): this person''s answers keyed by question id; NULL = none asked or given.';
