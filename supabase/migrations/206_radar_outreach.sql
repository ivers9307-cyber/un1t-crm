-- RADAR-OUTREACH.1 — one-click WhatsApp utility-template outreach
-- from the Churn Radar and Lead Radar.
--
-- The operator picks an approved WhatsApp UTILITY template and the
-- radar sends it to the contact in one click. This migration records
-- that as a first-class radar action:
--   * `outreach_sent` — added to the action CHECK on both radar
--                       action logs.
--   * `template_name` — a new nullable column recording which
--                       template went out.
--
-- Both changes are additive — existing rows and actions are untouched.
-- The action CHECK constraints are dropped + recreated by their known
-- auto-generated names (verified against prod).

begin;

-- ── churn_radar_actions ─────────────────────────────────────────
alter table public.churn_radar_actions
  drop constraint if exists churn_radar_actions_action_check;
alter table public.churn_radar_actions
  add constraint churn_radar_actions_action_check check (action in (
    'contacted', 'task_assigned', 'winback_sent', 'outreach_sent',
    'snoozed', 'quarantine_stale', 'quarantine_keep'));
alter table public.churn_radar_actions
  add column if not exists template_name text;

-- ── lead_radar_actions ──────────────────────────────────────────
alter table public.lead_radar_actions
  drop constraint if exists lead_radar_actions_action_check;
alter table public.lead_radar_actions
  add constraint lead_radar_actions_action_check check (action in (
    'contacted', 'snoozed', 'cleanup_archive', 'cleanup_keep',
    'outreach_sent'));
alter table public.lead_radar_actions
  add column if not exists template_name text;

commit;
