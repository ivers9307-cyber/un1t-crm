-- 402 — DB hygiene: covering indexes for unindexed foreign keys, a surrogate
-- PK for the quarantine dead-letter table, and a pinned search_path on
-- whatsapp_spend_rollup. Advisor remediation (unindexed_foreign_keys,
-- no_primary_key, function_search_path_mutable).
--
-- Applied to prod via Supabase MCP (name: db_hygiene_fk_indexes_pk_searchpath);
-- this file mirrors it for history and fresh-env / staging-branch replay, so it
-- is written idempotently. Unused-index DROPs are deliberately NOT included here
-- (the advisor's "unused" signal is unreliable; handled as a reviewed list).

-- 1) Covering indexes for foreign keys that lacked one --------------------
create index if not exists ix_agent_message_feedback_created_by on agent_message_feedback (created_by);
create index if not exists ix_automation_fire_log_device_id on automation_fire_log (device_id);
create index if not exists ix_card_receipts_reviewed_by on card_receipts (reviewed_by);
create index if not exists ix_challenges_created_by on challenges (created_by);
create index if not exists ix_class_booking_requests_approval_request_id on class_booking_requests (approval_request_id);
create index if not exists ix_class_timer_runs_started_by on class_timer_runs (started_by);
create index if not exists ix_class_timer_runs_template_id on class_timer_runs (template_id);
create index if not exists ix_class_timer_templates_created_by on class_timer_templates (created_by);
create index if not exists ix_coach_kudos_sender_profile_id on coach_kudos (sender_profile_id);
create index if not exists ix_coach_kudos_session_id on coach_kudos (session_id);
create index if not exists ix_coaching_goals_location_id on coaching_goals (location_id);
create index if not exists ix_coaching_goals_created_by on coaching_goals (created_by);
create index if not exists ix_consultation_photos_location_id on consultation_photos (location_id);
create index if not exists ix_consultation_photos_consultation_id on consultation_photos (consultation_id);
create index if not exists ix_consultation_photos_created_by on consultation_photos (created_by);
create index if not exists ix_consultations_location_id on consultations (location_id);
create index if not exists ix_consultations_coach_id on consultations (coach_id);
create index if not exists ix_consultations_created_by on consultations (created_by);
create index if not exists ix_event_hosts_anchor_location_id on event_hosts (anchor_location_id);
create index if not exists ix_feed_reactions_location_id on feed_reactions (location_id);
create index if not exists ix_glofox_note_pushes_location_id on glofox_note_pushes (location_id);
create index if not exists ix_google_business_connections_connected_by on google_business_connections (connected_by);
create index if not exists ix_host_campaign_sends_contact_id on host_campaign_sends (contact_id);
create index if not exists ix_host_contacts_contact_id on host_contacts (contact_id);
create index if not exists ix_host_contacts_source_event_id on host_contacts (source_event_id);
create index if not exists ix_host_email_suppressions_contact_id on host_email_suppressions (contact_id);
create index if not exists ix_host_impersonation_log_host_id on host_impersonation_log (host_id);
create index if not exists ix_hr_detection_visits_location_id on hr_detection_visits (location_id);
create index if not exists ix_hr_detections_last_bridge_id on hr_detections (last_bridge_id);
create index if not exists ix_inbody_backfill_requests_location_id on inbody_backfill_requests (location_id);
create index if not exists ix_inbody_scans_location_id on inbody_scans (location_id);
create index if not exists ix_inbody_webhook_events_location_id on inbody_webhook_events (location_id);
create index if not exists ix_location_automations_updated_by on location_automations (updated_by);
create index if not exists ix_location_role_permissions_updated_by on location_role_permissions (updated_by);
create index if not exists ix_member_friendships_location_id on member_friendships (location_id);
create index if not exists ix_member_health_metrics_location_id on member_health_metrics (location_id);
create index if not exists ix_member_monthly_targets_location_id on member_monthly_targets (location_id);
create index if not exists ix_org_settings_updated_by on org_settings (updated_by);
create index if not exists ix_person_group_members_added_by on person_group_members (added_by);
create index if not exists ix_person_groups_created_by on person_groups (created_by);
create index if not exists ix_person_groups_primary_contact_id on person_groups (primary_contact_id);
create index if not exists ix_person_link_suggestions_contact_id_b on person_link_suggestions (contact_id_b);
create index if not exists ix_person_link_suggestions_decided_by on person_link_suggestions (decided_by);
create index if not exists ix_presentation_slides_location_id on presentation_slides (location_id);
create index if not exists ix_presentations_created_by on presentations (created_by);
create index if not exists ix_promo_codes_event_id on promo_codes (event_id);
create index if not exists ix_push_event_sends_recipient_id on push_event_sends (recipient_id);
create index if not exists ix_race_checkins_checked_in_by on race_checkins (checked_in_by);
create index if not exists ix_race_checkins_team_member_id on race_checkins (team_member_id);
create index if not exists ix_race_events_reminder_email_template_id on race_events (reminder_email_template_id);
create index if not exists ix_race_events_confirmation_email_template_id on race_events (confirmation_email_template_id);
create index if not exists ix_race_registrations_promo_code_id on race_registrations (promo_code_id);
create index if not exists ix_recon_bank_lines_invoices_queue_id on recon_bank_lines (invoices_queue_id);
create index if not exists ix_recon_bank_lines_ignored_by on recon_bank_lines (ignored_by);
create index if not exists ix_recon_hunts_found_mailbox_id on recon_hunts (found_mailbox_id);
create index if not exists ix_recon_hunts_submitted_queue_id on recon_hunts (submitted_queue_id);
create index if not exists ix_recon_mailboxes_created_by on recon_mailboxes (created_by);
create index if not exists ix_whatsapp_template_events_location_id on whatsapp_template_events (location_id);

-- 2) Surrogate PK for the quarantine dead-letter table (had none) ---------
alter table public.glofox_invoices_quarantine
  add column if not exists quarantine_id bigint generated by default as identity;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.glofox_invoices_quarantine'::regclass and contype = 'p'
  ) then
    alter table public.glofox_invoices_quarantine
      add constraint glofox_invoices_quarantine_pkey primary key (quarantine_id);
  end if;
end $$;

-- 3) Pin search_path on the one flagged function -------------------------
do $$
begin
  if to_regprocedure('public.whatsapp_spend_rollup(uuid, timestamp with time zone)') is not null then
    alter function public.whatsapp_spend_rollup(uuid, timestamp with time zone)
      set search_path = public;
  end if;
end $$;
