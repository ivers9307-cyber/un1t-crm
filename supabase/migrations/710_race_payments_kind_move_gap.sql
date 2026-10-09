-- 710 — EVENT-MOVE.5: a payment can be the PRICE DIFFERENCE of a move.
--
-- WHY. A move never moves money (mig 708); the difference was recorded (709)
-- and collected by hand. Staff now send a payment link for it, and a customer
-- moving themselves (EVENT-MOVE.6) pays it before the move lands. Such a
-- payment must not be mistaken for an entry payment: it must not re-send the
-- entry confirmation, re-enrol sequences, push to Glofox, or become the
-- registration's active payment.
--
-- WHAT. race_payments.kind ('entry' | 'move_gap', default 'entry' for every
-- existing row) and registration_move_id (the move a gap payment settles when
-- it completes). Two operator-editable copy columns on race_events for the
-- "pay the difference" email, same pattern as mig 385/708. Safe to apply
-- before the code deploys (every existing row is an 'entry').

alter table public.race_payments
  add column if not exists kind text not null default 'entry',
  add column if not exists registration_move_id uuid references public.registration_moves(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'race_payments_kind_check') then
    alter table public.race_payments
      add constraint race_payments_kind_check check (kind in ('entry', 'move_gap'));
  end if;
end
$$;

create index if not exists race_payments_registration_move_idx
  on public.race_payments (registration_move_id) where registration_move_id is not null;

comment on column public.race_payments.kind is 'EVENT-MOVE.5 — entry (the ticket) | move_gap (the price difference of a move; never re-runs entry side effects).';
comment on column public.race_payments.registration_move_id is 'EVENT-MOVE.5 — for kind=move_gap: the move this payment settles on completion.';

alter table public.race_events
  add column if not exists gap_email_subject text,
  add column if not exists gap_email_intro text;

comment on column public.race_events.gap_email_subject is 'EVENT-MOVE.5 — subject of the "pay the difference" email; NULL = default.';
comment on column public.race_events.gap_email_intro is 'EVENT-MOVE.5 — intro copy of the "pay the difference" email; NULL = default.';
