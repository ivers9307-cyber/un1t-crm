-- TIMEOFF-TYPES — make the coach-facing "Request time off" type menu coherent
-- with the rest of the system. The DB CHECK previously allowed only
-- (holiday, sick, unavailable) — but the request forms + Zod offered
-- (holiday, sick, unpaid, other), so Unpaid/Other selections always failed the
-- insert and never saved. Per product decision (2026-06-17): full-time
-- employees get all four leave types (holiday/sick/unpaid/other) as REAL,
-- working options; contractors + casual staff get 'unavailable' only (gated in
-- the UI). Widen the CHECK to the full coherent set so all five are valid.
ALTER TABLE public.time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_type_check;
ALTER TABLE public.time_off_requests ADD CONSTRAINT time_off_requests_type_check
  CHECK (type = ANY (ARRAY['holiday'::text, 'sick'::text, 'unpaid'::text, 'other'::text, 'unavailable'::text]));
