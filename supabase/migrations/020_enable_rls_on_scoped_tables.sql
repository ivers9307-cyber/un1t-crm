-- ============================================================
-- 020: Enable RLS on the nine tables migration 014 set policies for
--
-- Migration 014 wrote location-scoped policies (contacts_location_scoped,
-- deals_location_scoped, etc.) but never flipped `relrowsecurity` on the
-- tables themselves. Postgres parses and stores policies regardless of
-- whether RLS is on, so the policies sat dormant and Supabase's
-- `database_linter` correctly flagged this as 18 ERROR-level findings
-- (`policy_exists_rls_disabled` ×9, `rls_disabled_in_public` ×9), plus
-- one extra `sensitive_columns_exposed` on webhook_subscriptions because
-- it has a `secret` column on a table without RLS — 19 critical issues
-- total.
--
-- This migration just flips the bit. No policy changes — every policy
-- on these tables already exists and is correctly scoped.
--
-- Behavioural impact:
--   - Service role (used by API routes via createServerClient) bypasses
--     RLS automatically — nothing changes for the app's server logic.
--   - Authenticated browser sessions (createBrowserClient) start being
--     filtered by the location-scoped policies that were already present
--     but inert. This is the intended state.
--   - The anon policies on bookings / event_types / blocked_times
--     ("Public can create bookings", "Public can view active events",
--     "Public can view blocked times") are TO anon, so the public
--     booking widget keeps working unchanged.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY on a table that already has
-- RLS on is a no-op.
-- ============================================================

ALTER TABLE activities             ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_times          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_types            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions  ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- VERIFICATION (run manually after applying)
--
--   SELECT c.relname, c.relrowsecurity
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN (
--        'activities','blocked_times','bookings','contacts','deals',
--        'event_types','notes','pipeline_stages','webhook_subscriptions'
--      );
--
-- All nine rows should show relrowsecurity = true.
-- ============================================================
