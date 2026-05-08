-- 108_add_missing_fk_indexes.sql
--
-- Schema GC pass — additive-only.
--
-- Background: the architectural-debt audit (May 2026) flagged the
-- orders location-scoped queries as suspected to be missing an
-- index on hot foreign keys. The Supabase performance advisor
-- confirms a wider problem: 52 foreign keys across 32 tables have
-- no covering index. This causes:
--
--   1. Slow ON DELETE CASCADE / SET NULL when the parent row is
--      deleted (Postgres has to seq-scan the child to find rows).
--   2. Slow JOINs from operator queries that filter "all X with
--      foo_id = Y" — most user-facing list pages do this.
--
-- This migration only ADDS indexes — it never drops a column or
-- changes a constraint. That keeps the change low-risk: indexes
-- are pure performance, can be dropped later if regretted, and
-- carry no n8n-integration risk (n8n reads schema, doesn't care
-- about indexes). The earlier audit-doc plan to also drop
-- candidate columns was deferred because Postgres pg_stat horizon
-- is only 12 days here, which isn't long enough to confidently
-- call any column "unused".
--
-- All indexes are CREATE INDEX IF NOT EXISTS so a re-run is a
-- no-op. Single-column btree on the FK column. We don't use
-- CREATE INDEX CONCURRENTLY because Supabase runs migrations in
-- a transaction — concurrent index creation requires its own
-- connection. The tables touched are not high-concurrency in
-- practice (ops staff, not user traffic) so the brief AccessShare
-- lock is acceptable.

BEGIN;

-- ── ac_sessions ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ac_sessions_started_by ON public.ac_sessions(started_by);
CREATE INDEX IF NOT EXISTS idx_ac_sessions_ended_by   ON public.ac_sessions(ended_by);

-- ── assignment_change_log ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_assignment_change_log_location_id
  ON public.assignment_change_log(location_id);

-- ── campaigns ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON public.campaigns(created_by);
CREATE INDEX IF NOT EXISTS idx_campaigns_template_id ON public.campaigns(template_id);

-- ── car_documents ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_car_documents_uploaded_by  ON public.car_documents(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_car_documents_xero_sent_by ON public.car_documents(xero_sent_by);

-- ── car_notes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_car_notes_created_by  ON public.car_notes(created_by);
CREATE INDEX IF NOT EXISTS idx_car_notes_location_id ON public.car_notes(location_id);

-- ── cars ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cars_created_by ON public.cars(created_by);

-- ── company_settings ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_company_settings_updated_by ON public.company_settings(updated_by);

-- ── consent_log ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_consent_log_performed_by ON public.consent_log(performed_by);

-- ── contact_imports ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contact_imports_actor_user_id  ON public.contact_imports(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_contact_imports_rolled_back_by ON public.contact_imports(rolled_back_by);

-- ── contact_segments ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contact_segments_created_by ON public.contact_segments(created_by);

-- ── contract_templates ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contract_templates_created_by ON public.contract_templates(created_by);

-- ── contractor_invoices ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contractor_invoices_reviewed_by
  ON public.contractor_invoices(reviewed_by);

-- ── contracts ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contracts_issued_by   ON public.contracts(issued_by);
CREATE INDEX IF NOT EXISTS idx_contracts_location_id ON public.contracts(location_id);
CREATE INDEX IF NOT EXISTS idx_contracts_revoked_by  ON public.contracts(revoked_by);
CREATE INDEX IF NOT EXISTS idx_contracts_template_id ON public.contracts(template_id);

-- ── email_sequences ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_email_sequences_created_by ON public.email_sequences(created_by);

-- ── email_templates ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_email_templates_created_by ON public.email_templates(created_by);

-- ── event_type_reminders ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_event_type_reminders_email_template_id
  ON public.event_type_reminders(email_template_id);

-- ── event_types ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_event_types_confirmation_email_template_id
  ON public.event_types(confirmation_email_template_id);

-- ── generated_reports ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_generated_reports_generated_by         ON public.generated_reports(generated_by);
CREATE INDEX IF NOT EXISTS idx_generated_reports_scheduled_report_id  ON public.generated_reports(scheduled_report_id);

-- ── location_holidays ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_location_holidays_created_by ON public.location_holidays(created_by);

-- ── locations ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_locations_car_deposit_whatsapp_template_id
  ON public.locations(car_deposit_whatsapp_template_id);

-- ── orders (audit-flagged hot path) ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_organization_id        ON public.orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_orders_superseded_by_order_id ON public.orders(superseded_by_order_id);

-- ── race_payments ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_race_payments_contact_id ON public.race_payments(contact_id);

-- ── race_registrations ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_race_registrations_contact_id ON public.race_registrations(contact_id);

-- ── rosters ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rosters_created_by             ON public.rosters(created_by);
CREATE INDEX IF NOT EXISTS idx_rosters_over_budget_approval_by ON public.rosters(over_budget_approval_by);
CREATE INDEX IF NOT EXISTS idx_rosters_published_by           ON public.rosters(published_by);

-- ── scheduled_reports ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_created_by ON public.scheduled_reports(created_by);

-- ── sequence_steps ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sequence_steps_template_id ON public.sequence_steps(template_id);

-- ── shift_assignments ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shift_assignments_assigned_by ON public.shift_assignments(assigned_by);

-- ── shift_blocks ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shift_blocks_created_by ON public.shift_blocks(created_by);

-- ── shift_swap_requests ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_requester_shift_id
  ON public.shift_swap_requests(requester_shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_target_shift_id
  ON public.shift_swap_requests(target_shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_reviewed_by
  ON public.shift_swap_requests(reviewed_by);

-- ── shifts ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shifts_created_by ON public.shifts(created_by);

-- ── sms_broadcasts ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sms_broadcasts_created_by ON public.sms_broadcasts(created_by);

-- ── time_off_requests ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_time_off_requests_reviewed_by ON public.time_off_requests(reviewed_by);

-- ── whatsapp_broadcasts ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_created_by  ON public.whatsapp_broadcasts(created_by);
CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_template_id ON public.whatsapp_broadcasts(template_id);

-- ── whatsapp_conversations ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_assigned_to
  ON public.whatsapp_conversations(assigned_to);

-- ── whatsapp_messages ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_sent_by ON public.whatsapp_messages(sent_by);

-- ── whatsapp_templates ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_created_by ON public.whatsapp_templates(created_by);

-- ── xero_connections ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_xero_connections_connected_by ON public.xero_connections(connected_by);

COMMIT;
