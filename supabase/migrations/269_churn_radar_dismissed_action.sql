-- CHURN-CLEAN.1 — durable "Not a member" reclassify on the churn radar.
--
-- The radar's population is built from Glofox's membership status, which
-- is a stale, sometimes-wrong label (trials and one-off class packs leak
-- in as `member` / `credit_member`). The upstream classifier now drops
-- the obvious cases (trial / open-week / one-off / scan plans, and the
-- stale member+num_classes trial-pack reference — see src/lib/churn-radar.js),
-- but the operator needs a manual backstop for anything it misses.
--
-- The new `dismissed` action is that backstop: a per-contact, PERMANENT
-- exclusion from every radar surface and the active-base count. It's
-- honoured by src/lib/churn-radar-data.js (fetchDismissed), which reads
-- it without a time window so a dismissal never expires (unlike a
-- ≤90-day snooze). 'quarantine_stale' (the legacy quarantine "mark
-- stale" decision) is treated the same way now — it excludes everywhere,
-- not just the quarantine backlog.
--
-- The CHECK is a closed allow-list, so the value has to be added
-- explicitly or the insert in /api/churn-radar/action fails. Keep every
-- existing value.
alter table public.churn_radar_actions
  drop constraint if exists churn_radar_actions_action_check;
alter table public.churn_radar_actions
  add constraint churn_radar_actions_action_check
  check (action = any (array[
    'contacted', 'task_assigned', 'winback_sent', 'outreach_sent',
    'payment_reminder', 'snoozed', 'quarantine_stale', 'quarantine_keep',
    'dismissed'
  ]));
