-- 480 — stamp price + billing interval on membership transitions (STUDIO-KPI.1).
--
-- Revenue churn (€ MRR lost, not member count) needs the price a member
-- was paying AT the moment they cancelled — but the nightly Glofox sync
-- wipes contacts.glofox_membership_price_cents when the membership ends
-- (verified live 2026-08-04: the sole recurring_cancel row's contact has
-- a NULL price). So the mig 456 trigger now stamps the outgoing price on
-- cancels (OLD row) and the incoming price on everything else (NEW row).
-- History before this migration has no stamped price — the Studio
-- scorecard estimates those months as cancels × current average yield
-- and labels the figure estimated.

alter table membership_transitions
  add column price_cents      integer,
  add column billing_interval text;

comment on column membership_transitions.price_cents is
  'Membership price at transition time (mig 480): OLD.glofox_membership_price_cents on recurring_cancel, NEW.glofox_membership_price_cents otherwise. NULL for rows predating mig 480.';
comment on column membership_transitions.billing_interval is
  'Billing interval companion to price_cents (e.g. "1 month", "3 months"), captured under the same OLD/NEW rule.';

-- Same body as mig 456 plus the two stamped columns, and one
-- definitional fix: mig 456's recurring test was status='member' only,
-- while the monthly_recurring KPI (membership-snapshot.js) counts
-- 'member' AND 'credit_member' with type 'time' — so a credit_member
-- cancelling a time membership logged kind='other' and undercounted
-- cancels. Aligned here; rows before this migration keep their old
-- kind (the table is 58 rows old — not worth restating).
-- CREATE OR REPLACE preserves ownership + ACLs, so mig 457's
-- REST-execute revoke stays in effect.
create or replace function log_membership_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  was_rec boolean := coalesce(old.glofox_membership_status in ('member', 'credit_member') and old.glofox_membership_type = 'time', false);
  is_rec  boolean := coalesce(new.glofox_membership_status in ('member', 'credit_member') and new.glofox_membership_type = 'time', false);
  t_kind  text := case
    when not was_rec and is_rec then 'recurring_start'
    when was_rec and not is_rec then 'recurring_cancel'
    else 'other'
  end;
begin
  insert into membership_transitions
    (contact_id, location_id, prev_status, new_status, prev_type, new_type, prev_state, new_state, kind,
     price_cents, billing_interval)
  values
    (new.id, new.location_id,
     old.glofox_membership_status, new.glofox_membership_status,
     old.glofox_membership_type,   new.glofox_membership_type,
     old.glofox_membership_state,  new.glofox_membership_state,
     t_kind,
     case when t_kind = 'recurring_cancel' then old.glofox_membership_price_cents else new.glofox_membership_price_cents end,
     case when t_kind = 'recurring_cancel' then old.glofox_billing_interval       else new.glofox_billing_interval       end);
  return null;
end;
$$;
