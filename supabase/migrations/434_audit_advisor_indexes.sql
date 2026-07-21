-- 434 — advisor cleanup: FK covering indexes + drop duplicate WA unique constraint
--
-- Performance advisor (external audit 2026-07-21), each item verified against
-- prod before writing this:
--   * 3 unindexed foreign keys. A FK with no covering index forces the
--     referential-integrity check (and any ON DELETE cascade) to seq-scan the
--     child table. None of the existing indexes covers these columns as a
--     LEADING column: tenant_heartbeats/usage_rollups_daily only have
--     location_id as the 2nd PK column, and support_sessions has no index on
--     impersonated_user_id at all.
--   * 1 duplicate index. whatsapp_broadcast_recipients carries TWO identical
--     UNIQUE(broadcast_id, contact_id) constraints — ..._uniq (mig 253) and
--     ..._key (mig 331). Both enforce the same rule; the second is dead weight
--     on every insert/update. Keep ..._key (mig 331 — the documented
--     send-loop claim-first mutex) and drop ..._uniq. The send loop upserts on
--     the COLUMN LIST (onConflict: 'broadcast_id,contact_id'), not the
--     constraint name, and no code references the constraint name, so this is
--     behaviour-preserving.
--
-- All three child tables are small, so a plain (non-CONCURRENT) CREATE INDEX
-- takes only a negligible lock; CONCURRENTLY is deliberately avoided because
-- apply_migration runs DDL inside a transaction.
--
-- NOT fixed here: the advisor's 4th item (auth_db_connections_absolute) is a
-- project Auth setting, not schema — switch the Auth DB connection allocation
-- from an absolute count to a percentage in the Supabase dashboard. A migration
-- cannot change it.

create index if not exists support_sessions_impersonated_user_idx
  on public.support_sessions (impersonated_user_id);

create index if not exists tenant_heartbeats_location_idx
  on public.tenant_heartbeats (location_id);

create index if not exists usage_rollups_daily_location_idx
  on public.usage_rollups_daily (location_id);

alter table public.whatsapp_broadcast_recipients
  drop constraint if exists whatsapp_broadcast_recipients_broadcast_contact_uniq;
