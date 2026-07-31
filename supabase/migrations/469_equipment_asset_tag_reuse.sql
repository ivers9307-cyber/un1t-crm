-- EQUIP-MAINT.1g — let a retired asset release its asset tag.
--
-- Mig 467 made asset_tag unique per location, partial only on
-- `asset_tag is not null`. Retired rows are never deleted (the
-- compliance log holds them via an `on delete restrict` FK), so a
-- retired treadmill kept its tag forever and the physical replacement
-- could not reuse the wall label — the operator would have had to
-- invent "TM-03b". Asset tags are a property of the LABEL ON THE WALL,
-- not of the machine, so they must be reusable once the old machine is
-- retired.
--
-- Adding `status <> 'retired'` to the index predicate makes retired
-- rows invisible to the uniqueness check while leaving them fully
-- readable in history.
--
-- Safety of the narrowing: a partial unique index only ever constrains
-- rows matching its predicate, so narrowing can never reject data that
-- was previously accepted — it only permits more. No backfill needed
-- and no existing row can violate it.
--
-- Consequence worth stating: two rows may now hold the same asset_tag
-- at one location, provided at most one is non-retired. Any future
-- lookup BY asset tag must therefore filter `status <> 'retired'` or it
-- will match the wrong row. There is no such lookup today; the tag is
-- display-and-search only.
--
-- There is deliberately no un-retire path in the API (PATCH refuses a
-- retired asset), so a retired row cannot come back and collide with
-- the replacement that took its tag.

set check_function_bodies = off;

drop index if exists public.equipment_asset_tag_idx;

create unique index equipment_asset_tag_idx
  on public.equipment (location_id, asset_tag)
  where asset_tag is not null and status <> 'retired';

comment on index public.equipment_asset_tag_idx is
  'EQUIP-MAINT.1g — asset tags are unique per location among LIVE assets '
  'only. Retiring an asset releases its tag for the replacement machine. '
  'Lookups by asset_tag must filter status <> ''retired''.';
