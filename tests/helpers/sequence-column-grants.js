// PROFILESPREAD.1b (mig 654) — what a signed-in client session (`authenticated`)
// may do with the three sequence tables. The single source for
// tests/migration-654-email-sequences-column-grants.test.js and
// tests/sequence-column-grants-guard.test.js. Service-role code (every route,
// page, lib and cron that reads or writes these tables) bypasses all of it.
// A column added to email_sequences goes into exactly one of SELECT /
// WITHHELD, in the same PR as the migration that adds it.

export const SEQUENCE_GRANT_MIGRATION = 654

// email_sequences: SELECT on every column but the two inbound-webhook
// credentials; no client write at all. id + location_id MUST stay granted:
// the sequence_steps / sequence_enrollments policies read them as the caller
// (EXISTS (SELECT 1 FROM email_sequences s WHERE s.id = … AND
// private.auth_is_in_location(s.location_id))), so without them every
// client read of a child table would fail 42501.
export const EMAIL_SEQUENCES_SELECT = Object.freeze([
  'id', 'location_id', 'name', 'description', 'trigger_type', 'trigger_config', 'audience_filter', 'active',
  'total_enrolled', 'total_completed', 'total_exited', 'created_by', 'created_at', 'updated_at', 'status',
  'goal_config', 'send_window', 're_enrolment_cooldown_days', 'graph', 'draft_graph', 'graph_version',
  'from_email', 'from_name', 'reply_to', 'audience_seeded_at', 'audience_seeded_by', 'audience_seed_count',
])
export const EMAIL_SEQUENCES_WITHHELD = Object.freeze(['webhook_token', 'webhook_secret'])

// Section B (plan C41 DECISIONS 2, default yes): table-level SELECT kept
// (no secret column; still RLS-scoped), every client write revoked.
export const READ_ONLY_TABLES = Object.freeze(['sequence_steps', 'sequence_enrollments'])

export const SEQUENCE_TABLES = Object.freeze(['email_sequences', ...READ_ONLY_TABLES])
