-- 358: flagship transformation challenge flag.
--
-- Operator decision (Richard, 2026-07-03) — sub-project 3 of the Pulse
-- engagement roadmap: an operator turns a normal challenge into the marquee
-- "transformation" event by ticking one flag. A flagship challenge switches on
-- (in the member app only) an InBody transformation bookend, a Challenge
-- Wrapped finisher story, and consistency + cohort-fair scoring. A flagship is
-- always an individual challenge (enforced in the API create/edit refine).
--
-- Additive + reversible: a nullable-free boolean defaulting false, so every
-- existing challenge stays non-flagship and the member app reads falsy for
-- rows created before this lands. GET already does select('*'), so the column
-- reaches the client for free.

alter table public.challenges
  add column if not exists is_flagship boolean not null default false;

comment on column public.challenges.is_flagship is
  'When true, this individual challenge is the marquee transformation event: '
  'switches on the InBody bookend + Challenge Wrapped finisher + consistency/'
  'cohort scoring in the member app. Enforced individual-only by the API.';
