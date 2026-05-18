-- SHIFTMIN.1 — minimum required coaches per shift template.
--
-- Companion to the existing `max_coaches` (mig 067). Operators want
-- to flag undermanned shifts in the Studio Overview when actual
-- assignments fall below a per-template floor.
--
-- Default of 1: every shift needs at least one coach to function,
-- so existing templates get a sensible non-zero default and the
-- feature delivers value on the first deploy. Operators bump
-- per-template when a slot legitimately needs 2+ coaches.
--
-- Same template → block snapshot pattern as max_coaches: the
-- template's value is copied onto each shift_block at creation,
-- so editing a template doesn't retroactively reclassify past
-- blocks as undermanned.

-- ── shift_templates ─────────────────────────────────────────────
alter table public.shift_templates
  add column if not exists min_coaches smallint not null default 1;

alter table public.shift_templates
  drop constraint if exists shift_templates_min_coaches_check;
alter table public.shift_templates
  add constraint shift_templates_min_coaches_check
  check (min_coaches >= 0 and min_coaches <= max_coaches);

comment on column public.shift_templates.min_coaches is
  'SHIFTMIN.1 — minimum number of coaches that must be assigned to a block instance of this template before the Studio Overview flips from amber to green. 0 = no minimum (always green on assignment counts).';

-- ── shift_blocks ────────────────────────────────────────────────
alter table public.shift_blocks
  add column if not exists min_coaches smallint not null default 1;

alter table public.shift_blocks
  drop constraint if exists shift_blocks_min_coaches_check;
alter table public.shift_blocks
  add constraint shift_blocks_min_coaches_check
  check (min_coaches >= 0 and min_coaches <= max_coaches);

comment on column public.shift_blocks.min_coaches is
  'SHIFTMIN.1 — snapshot of the template''s min_coaches at block creation. Same pattern as max_coaches — editing the template later does not retroactively reclassify past blocks.';

-- Backfill: ensure every existing block reflects its template's
-- current min_coaches. min_coaches default of 1 already applied to
-- new rows; this sweeps any blocks whose template was edited
-- between deploy and the next regen cycle.
update public.shift_blocks b
set    min_coaches = t.min_coaches
from   public.shift_templates t
where  b.template_id = t.id
  and  b.min_coaches is distinct from t.min_coaches;
