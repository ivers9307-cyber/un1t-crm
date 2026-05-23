-- 203_perf2_fk_covering_indexes.sql
--
-- PERF.2.D — covering indexes for the 11 foreign keys the Supabase
-- performance advisor still flags as unindexed (unindexed_foreign_keys).
-- These are FK columns on tables added since PERF.1 (mig 162). An
-- unindexed FK forces a sequential scan of the child table on every
-- parent DELETE / UPDATE, and gives the planner no help on FK joins.
--
-- All small tables today, so the impact is low now — this is cheap
-- insurance and clears the advisor lint. Plain (non-partial) indexes
-- match the existing idx_<table>_<col> convention and guarantee the
-- advisor sees each FK as covered.

begin;

-- car_bca_submissions.superseded_by → car_bca_submissions(id)
create index if not exists idx_car_bca_submissions_superseded_by
  on public.car_bca_submissions (superseded_by);

-- car_documents.extracted_by / .xero_pushed_by → profiles(id)
create index if not exists idx_car_documents_extracted_by
  on public.car_documents (extracted_by);
create index if not exists idx_car_documents_xero_pushed_by
  on public.car_documents (xero_pushed_by);

-- churn_radar_actions.actor_id → profiles(id)
create index if not exists idx_churn_radar_actions_actor
  on public.churn_radar_actions (actor_id);

-- fte_expense_claims.reviewed_by → profiles(id)
create index if not exists idx_fte_expense_claims_reviewed_by
  on public.fte_expense_claims (reviewed_by);

-- invoices_queue.data_reviewed_by / .quality_reviewed_by → profiles(id)
create index if not exists idx_invoices_queue_data_reviewed_by
  on public.invoices_queue (data_reviewed_by);
create index if not exists idx_invoices_queue_quality_reviewed_by
  on public.invoices_queue (quality_reviewed_by);

-- lead_radar_actions.actor_id → profiles(id)
create index if not exists idx_lead_radar_actions_actor
  on public.lead_radar_actions (actor_id);

-- policy_versions.published_by → profiles(id)
create index if not exists idx_policy_versions_published_by
  on public.policy_versions (published_by);

-- push_reminder_sends.recipient_id → profiles(id)
create index if not exists idx_push_reminder_sends_recipient
  on public.push_reminder_sends (recipient_id);

-- tv_templates.created_by → profiles(id)
create index if not exists idx_tv_templates_created_by
  on public.tv_templates (created_by);

commit;
