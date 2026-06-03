-- Churn Radar Phase 2 (RADAR-PAY.1) — designate the dunning sequence.
--
-- The one-click "Send payment reminder" action on the churn radar
-- enrols payment-slipping (early) and locked (Overdue) members into a
-- manual email/SMS sequence the operator authors once. This column
-- points each location at that sequence. NULL = no dunning sequence
-- configured yet, so the action is disabled (the route returns a
-- "pick one in settings" message rather than guessing).
--
-- ON DELETE SET NULL: deleting the sequence just clears the pointer
-- (the action falls back to disabled) — it never blocks the delete.
-- Designation is set via PUT /api/churn-radar/dunning-settings, which
-- validates the target is a manual sequence at the same location.

alter table public.locations
  add column if not exists dunning_sequence_id uuid
  references public.email_sequences(id) on delete set null;

comment on column public.locations.dunning_sequence_id is
  'Churn Radar Phase 2 (RADAR-PAY.1): the manual email/SMS sequence the one-click "Send payment reminder" action enrols slipping + locked members into. NULL = dunning action disabled. Set via /api/churn-radar/dunning-settings.';

-- Cover the new FK so it doesn''t reintroduce an unindexed_foreign_keys
-- advisor warning (mig 242 cleared those). Partial — only the rare
-- locations that have designated a sequence carry a row here.
create index if not exists idx_locations_dunning_sequence_id
  on public.locations (dunning_sequence_id)
  where dunning_sequence_id is not null;

-- Allow the new 'payment_reminder' action in the radar audit log. The
-- CHECK is a closed allow-list, so the value has to be added explicitly
-- or the insert in /api/churn-radar/action fails. Keep every existing
-- value (incl. the quarantine_* triage actions).
alter table public.churn_radar_actions
  drop constraint if exists churn_radar_actions_action_check;
alter table public.churn_radar_actions
  add constraint churn_radar_actions_action_check
  check (action = any (array[
    'contacted', 'task_assigned', 'winback_sent', 'outreach_sent',
    'payment_reminder', 'snoozed', 'quarantine_stale', 'quarantine_keep'
  ]));
