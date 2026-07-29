-- 456 — membership_transitions log + trigger (TREND-FLOWS.1).
--
-- The business-board chart needs weekly membership CANCELLATIONS, but
-- nothing records them: the nightly Glofox sync just overwrites
-- contacts.glofox_membership_* in place, so the moment a recurring
-- member stops being one leaves no dated trace. This trigger captures
-- every membership status/type/state change on contacts (sync- or
-- webhook-driven alike) and classifies the two transitions the chart
-- cares about. History before this migration is unrecoverable —
-- cancellation tracking starts at apply time (2026-07-29; the
-- CANCEL_TRACKING_START constant in src/lib/membership-flows.js
-- mirrors this date).
--
-- "Recurring member" = glofox_membership_status 'member' AND
-- glofox_membership_type 'time' — same definition as the
-- monthly-recurring KPI (membership-snapshot.js).

create table membership_transitions (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts(id) on delete cascade,
  location_id  uuid,
  occurred_at  timestamptz not null default now(),
  prev_status  text,
  new_status   text,
  prev_type    text,
  new_type     text,
  prev_state   text,
  new_state    text,
  -- 'recurring_start' | 'recurring_cancel' | 'other'
  kind         text not null
);

comment on table membership_transitions is
  'Dated log of contacts.glofox_membership_* changes (mig 456). Feeds the weekly sales-vs-cancellations chart; rows only exist from 2026-07-29.';

create index membership_transitions_loc_kind_at
  on membership_transitions (location_id, kind, occurred_at);

-- Service-role reads only (business dashboard route). RLS on with no
-- policies: authenticated/anon get nothing; the trigger function is
-- SECURITY DEFINER so inserts succeed regardless of who ran the
-- UPDATE that fired it.
alter table membership_transitions enable row level security;

create or replace function log_membership_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  was_rec boolean := coalesce(old.glofox_membership_status = 'member' and old.glofox_membership_type = 'time', false);
  is_rec  boolean := coalesce(new.glofox_membership_status = 'member' and new.glofox_membership_type = 'time', false);
begin
  insert into membership_transitions
    (contact_id, location_id, prev_status, new_status, prev_type, new_type, prev_state, new_state, kind)
  values
    (new.id, new.location_id,
     old.glofox_membership_status, new.glofox_membership_status,
     old.glofox_membership_type,   new.glofox_membership_type,
     old.glofox_membership_state,  new.glofox_membership_state,
     case
       when not was_rec and is_rec then 'recurring_start'
       when was_rec and not is_rec then 'recurring_cancel'
       else 'other'
     end);
  return null;
end;
$$;

create trigger trg_membership_transition
after update of glofox_membership_status, glofox_membership_type, glofox_membership_state
on contacts
for each row
when (old.glofox_membership_status is distinct from new.glofox_membership_status
   or old.glofox_membership_type   is distinct from new.glofox_membership_type
   or old.glofox_membership_state  is distinct from new.glofox_membership_state)
execute function log_membership_transition();
