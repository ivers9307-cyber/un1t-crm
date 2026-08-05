-- RLS-RESTRICTIVE.1 — estate-wide fix for the `AS RESTRICTIVE FOR ALL`
-- pattern that silently folds away a table's permissive SELECT policy.
--
-- Generalises mig 483, which fixed exactly this on the two tables mig 482
-- created and explicitly deferred the rest ("shared by ~19 tables
-- estate-wide ... tracked separately"). This is that follow-up.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────
-- Postgres evaluates RLS as (OR of permissive) AND (AND of restrictive),
-- and `FOR ALL` includes SELECT. So a table carrying
--
--     CREATE POLICY <x>_deny_writes ON public.<t>
--       AS RESTRICTIVE FOR ALL TO authenticated, anon
--       USING (false) WITH CHECK (false);
--
-- has its permissive SELECT policy ANDed against `false` — the read is
-- denied outright, for the very role the SELECT policy was written for.
-- Reproduction (this is what the fix has to flip):
--
--     BEGIN; SET LOCAL role authenticated;
--     EXPLAIN (COSTS OFF) SELECT * FROM public.email_conversations;
--     -->  Result
--     -->    One-Time Filter: false          -- policy folded away
--     ROLLBACK;
--
-- Compare public.contacts (no restrictive policy): a Seq Scan carrying
-- the policy's own filter. After this migration the 16 tables below
-- should plan like contacts does.
--
-- ── WHY IT MATTERS ─────────────────────────────────────────────────
-- Supabase realtime authorises every `postgres_changes` row through the
-- subscriber's SELECT policy. SELECT denied => the subscriber receives
-- nothing, with no error on either side. Four of the affected tables are
-- in the supabase_realtime publication, and all four have live
-- subscribers that have therefore never fired:
--
--   email_conversations, email_inbox_messages   (mig 394)
--     - src/components/EmailInbox.jsx      both listeners dead
--     - src/components/UnifiedInbox.jsx    2 of its 7 tables dead
--   instagram_conversations, instagram_messages (mig 256)
--     - src/components/IGInbox.jsx         both listeners dead
--     - src/components/UnifiedInbox.jsx    2 more of its 7 dead
--
-- All three components sit above a 60-second poll, which is why nobody
-- noticed: the UI still updates, just a minute late. WAInbox.jsx and
-- WhatsappTemplatesList.jsx are unaffected — the WhatsApp tables never
-- got a restrictive policy. IGInbox's own comment claims new messages
-- "appear instantly"; that has not been true since mig 231 created the
-- table and its restrictive policy in the same breath.
--
-- The second, latent half: any browser-side read of these tables returns
-- an EMPTY SET rather than an error — a silent-wrong-answer shape. Today
-- nothing reads them from the browser (every call site is an /api route
-- or src/lib on the service-role client, verified by grep across
-- src/, mobile/, desktop/ and shared/), so nothing is actively serving
-- wrong data. It would have bitten the first person to add one.
--
-- ── SHAPE, AND WHY IT DIVERGES FROM MIG 483 ────────────────────────
-- Mig 483 replaced the `FOR ALL` with per-command INSERT/UPDATE/DELETE
-- restrictives `TO authenticated, anon`. That was safe there because
-- email_tickets' permissive SELECT is scoped `TO authenticated`, so anon
-- was left with no permissive SELECT and stayed default-denied.
--
-- Six of the sixteen tables here are NOT like that — their permissive
-- SELECT is `TO public`, which in Postgres means every role including
-- anon (channel_connections, contact_segment_memberships,
-- glofox_memberships, instagram_conversations, instagram_messages,
-- whatsapp_numbers; the first five via mig 242's initplan rewrite, the
-- last from mig 176). On those, copying 483 verbatim would newly subject
-- anon to the SELECT policy's USING expression. It would probably still
-- return nothing — every branch keys on auth.uid(), which is NULL for
-- anon — but "probably returns nothing because a helper function
-- happens to handle NULL" is not a access-control boundary.
--
-- So each table gets FOUR restrictive policies instead of three:
--
--   <base>_deny_anon     RESTRICTIVE FOR ALL    TO anon
--   <base>_deny_insert   RESTRICTIVE FOR INSERT TO authenticated
--   <base>_deny_update   RESTRICTIVE FOR UPDATE TO authenticated
--   <base>_deny_delete   RESTRICTIVE FOR DELETE TO authenticated
--
-- anon keeps a hard, total denial exactly as before — this migration
-- does not widen anon's reach on any table by design, not by luck.
-- authenticated keeps the write denial per command, so SELECT survives.
-- This is the shape mig 169 already used correctly on
-- push_reminder_sends, which is why that table was never broken.
--
-- The write denial is redundant today: all sixteen tables carry exactly
-- two policies (one permissive SELECT, one restrictive FOR ALL) and NO
-- permissive INSERT/UPDATE/DELETE policy, so writes are already
-- default-denied. It is retained deliberately — it is what stops a
-- future carelessly-added permissive write policy from opening client
-- writes on tables whose every writer is meant to be a service-role
-- route.
--
-- ── WHAT IS DELIBERATELY NOT TOUCHED ───────────────────────────────
-- 26 tables carry a net restrictive `FOR ALL`. Ten are excluded:
--
--   1. NO PERMISSIVE SELECT POLICY AT ALL (8) — ac_sessions,
--      contractor_invoices, cron_heartbeats, glofox_webhook_events,
--      webhook_events (all mig 168, added purely to clear the INFO-level
--      rls_enabled_no_policy advisor mig 166 documented), plus
--      champ_push_tokens (295), device_tokens (023), push_event_sends
--      (349). There is no read to unblock: SELECT is denied by
--      default-deny whether the restrictive policy exists or not.
--      Splitting them would be a behavioural no-op that removes an
--      explicit SELECT backstop. Left alone on purpose.
--
--   2. push_reminder_sends (169) — its restrictive is `TO anon` only,
--      and its permissive SELECT is `TO authenticated`. Restrictive
--      policies bind only the roles they are granted to, so
--      authenticated SELECT already works. Not a defect; it is the
--      pattern this migration adopts.
--
--   3. storage.objects (403, and 325/370 before it) — its restrictive is
--      conditional (`bucket_id NOT IN (...)`), not USING(false), and
--      denying SELECT on private buckets is the entire point of it.
--      Splitting it into write-only commands would expose private bucket
--      objects to any authenticated client. MUST NOT be "fixed".
--
-- Enumerated by replaying all 484 migrations in order and computing the
-- net policy state (CREATE/DROP/ALTER), not by grepping for CREATE —
-- several of these were dropped and recreated along the way.
--
-- scripts/check-rls-restrictive.mjs now fails CI if a future migration
-- reintroduces the pattern. It is the reason this defect reached 16
-- tables across ~300 migrations: nothing was watching for it.

BEGIN;

-- ── channel_connections ──
-- SELECT policy is TO public, so the anon backstop below is LOAD-BEARING.
DROP POLICY IF EXISTS channel_connections_deny_writes ON public.channel_connections;

DROP POLICY IF EXISTS channel_connections_deny_anon ON public.channel_connections;
CREATE POLICY channel_connections_deny_anon ON public.channel_connections
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS channel_connections_deny_insert ON public.channel_connections;
CREATE POLICY channel_connections_deny_insert ON public.channel_connections
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS channel_connections_deny_update ON public.channel_connections;
CREATE POLICY channel_connections_deny_update ON public.channel_connections
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS channel_connections_deny_delete ON public.channel_connections;
CREATE POLICY channel_connections_deny_delete ON public.channel_connections
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── contact_segment_memberships ──
-- SELECT policy is TO public, so the anon backstop below is LOAD-BEARING.
DROP POLICY IF EXISTS contact_segment_memberships_deny_writes ON public.contact_segment_memberships;

DROP POLICY IF EXISTS contact_segment_memberships_deny_anon ON public.contact_segment_memberships;
CREATE POLICY contact_segment_memberships_deny_anon ON public.contact_segment_memberships
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS contact_segment_memberships_deny_insert ON public.contact_segment_memberships;
CREATE POLICY contact_segment_memberships_deny_insert ON public.contact_segment_memberships
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS contact_segment_memberships_deny_update ON public.contact_segment_memberships;
CREATE POLICY contact_segment_memberships_deny_update ON public.contact_segment_memberships
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS contact_segment_memberships_deny_delete ON public.contact_segment_memberships;
CREATE POLICY contact_segment_memberships_deny_delete ON public.contact_segment_memberships
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── email_conversations  [realtime] ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS email_conv_deny_writes ON public.email_conversations;

DROP POLICY IF EXISTS email_conv_deny_anon ON public.email_conversations;
CREATE POLICY email_conv_deny_anon ON public.email_conversations
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_conv_deny_insert ON public.email_conversations;
CREATE POLICY email_conv_deny_insert ON public.email_conversations
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS email_conv_deny_update ON public.email_conversations;
CREATE POLICY email_conv_deny_update ON public.email_conversations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_conv_deny_delete ON public.email_conversations;
CREATE POLICY email_conv_deny_delete ON public.email_conversations
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── email_inbox_messages  [realtime] ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS email_msg_deny_writes ON public.email_inbox_messages;

DROP POLICY IF EXISTS email_msg_deny_anon ON public.email_inbox_messages;
CREATE POLICY email_msg_deny_anon ON public.email_inbox_messages
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_msg_deny_insert ON public.email_inbox_messages;
CREATE POLICY email_msg_deny_insert ON public.email_inbox_messages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS email_msg_deny_update ON public.email_inbox_messages;
CREATE POLICY email_msg_deny_update ON public.email_inbox_messages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_msg_deny_delete ON public.email_inbox_messages;
CREATE POLICY email_msg_deny_delete ON public.email_inbox_messages
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── glofox_memberships ──
-- SELECT policy is TO public, so the anon backstop below is LOAD-BEARING.
DROP POLICY IF EXISTS glofox_memberships_deny_writes ON public.glofox_memberships;

DROP POLICY IF EXISTS glofox_memberships_deny_anon ON public.glofox_memberships;
CREATE POLICY glofox_memberships_deny_anon ON public.glofox_memberships
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS glofox_memberships_deny_insert ON public.glofox_memberships;
CREATE POLICY glofox_memberships_deny_insert ON public.glofox_memberships
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS glofox_memberships_deny_update ON public.glofox_memberships;
CREATE POLICY glofox_memberships_deny_update ON public.glofox_memberships
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS glofox_memberships_deny_delete ON public.glofox_memberships;
CREATE POLICY glofox_memberships_deny_delete ON public.glofox_memberships
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── instagram_conversations  [realtime] ──
-- SELECT policy is TO public, so the anon backstop below is LOAD-BEARING.
DROP POLICY IF EXISTS ig_conv_deny_writes ON public.instagram_conversations;

DROP POLICY IF EXISTS ig_conv_deny_anon ON public.instagram_conversations;
CREATE POLICY ig_conv_deny_anon ON public.instagram_conversations
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ig_conv_deny_insert ON public.instagram_conversations;
CREATE POLICY ig_conv_deny_insert ON public.instagram_conversations
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS ig_conv_deny_update ON public.instagram_conversations;
CREATE POLICY ig_conv_deny_update ON public.instagram_conversations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ig_conv_deny_delete ON public.instagram_conversations;
CREATE POLICY ig_conv_deny_delete ON public.instagram_conversations
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── instagram_messages  [realtime] ──
-- SELECT policy is TO public, so the anon backstop below is LOAD-BEARING.
DROP POLICY IF EXISTS ig_msg_deny_writes ON public.instagram_messages;

DROP POLICY IF EXISTS ig_msg_deny_anon ON public.instagram_messages;
CREATE POLICY ig_msg_deny_anon ON public.instagram_messages
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ig_msg_deny_insert ON public.instagram_messages;
CREATE POLICY ig_msg_deny_insert ON public.instagram_messages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS ig_msg_deny_update ON public.instagram_messages;
CREATE POLICY ig_msg_deny_update ON public.instagram_messages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ig_msg_deny_delete ON public.instagram_messages;
CREATE POLICY ig_msg_deny_delete ON public.instagram_messages
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── location_plans ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS location_plans_deny_writes ON public.location_plans;

DROP POLICY IF EXISTS location_plans_deny_anon ON public.location_plans;
CREATE POLICY location_plans_deny_anon ON public.location_plans
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS location_plans_deny_insert ON public.location_plans;
CREATE POLICY location_plans_deny_insert ON public.location_plans
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS location_plans_deny_update ON public.location_plans;
CREATE POLICY location_plans_deny_update ON public.location_plans
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS location_plans_deny_delete ON public.location_plans;
CREATE POLICY location_plans_deny_delete ON public.location_plans
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── plan_versions ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS plan_versions_deny_writes ON public.plan_versions;

DROP POLICY IF EXISTS plan_versions_deny_anon ON public.plan_versions;
CREATE POLICY plan_versions_deny_anon ON public.plan_versions
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS plan_versions_deny_insert ON public.plan_versions;
CREATE POLICY plan_versions_deny_insert ON public.plan_versions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS plan_versions_deny_update ON public.plan_versions;
CREATE POLICY plan_versions_deny_update ON public.plan_versions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS plan_versions_deny_delete ON public.plan_versions;
CREATE POLICY plan_versions_deny_delete ON public.plan_versions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── plans ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS plans_deny_writes ON public.plans;

DROP POLICY IF EXISTS plans_deny_anon ON public.plans;
CREATE POLICY plans_deny_anon ON public.plans
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS plans_deny_insert ON public.plans;
CREATE POLICY plans_deny_insert ON public.plans
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS plans_deny_update ON public.plans;
CREATE POLICY plans_deny_update ON public.plans
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS plans_deny_delete ON public.plans;
CREATE POLICY plans_deny_delete ON public.plans
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── support_sessions ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS support_sessions_deny_writes ON public.support_sessions;

DROP POLICY IF EXISTS support_sessions_deny_anon ON public.support_sessions;
CREATE POLICY support_sessions_deny_anon ON public.support_sessions
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS support_sessions_deny_insert ON public.support_sessions;
CREATE POLICY support_sessions_deny_insert ON public.support_sessions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS support_sessions_deny_update ON public.support_sessions;
CREATE POLICY support_sessions_deny_update ON public.support_sessions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS support_sessions_deny_delete ON public.support_sessions;
CREATE POLICY support_sessions_deny_delete ON public.support_sessions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── tenant_email_domains ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS tenant_email_domains_deny_writes ON public.tenant_email_domains;

DROP POLICY IF EXISTS tenant_email_domains_deny_anon ON public.tenant_email_domains;
CREATE POLICY tenant_email_domains_deny_anon ON public.tenant_email_domains
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_email_domains_deny_insert ON public.tenant_email_domains;
CREATE POLICY tenant_email_domains_deny_insert ON public.tenant_email_domains
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS tenant_email_domains_deny_update ON public.tenant_email_domains;
CREATE POLICY tenant_email_domains_deny_update ON public.tenant_email_domains
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_email_domains_deny_delete ON public.tenant_email_domains;
CREATE POLICY tenant_email_domains_deny_delete ON public.tenant_email_domains
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── wallet_topup_invoices ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS wallet_topup_invoices_deny_writes ON public.wallet_topup_invoices;

DROP POLICY IF EXISTS wallet_topup_invoices_deny_anon ON public.wallet_topup_invoices;
CREATE POLICY wallet_topup_invoices_deny_anon ON public.wallet_topup_invoices
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wallet_topup_invoices_deny_insert ON public.wallet_topup_invoices;
CREATE POLICY wallet_topup_invoices_deny_insert ON public.wallet_topup_invoices
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS wallet_topup_invoices_deny_update ON public.wallet_topup_invoices;
CREATE POLICY wallet_topup_invoices_deny_update ON public.wallet_topup_invoices
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wallet_topup_invoices_deny_delete ON public.wallet_topup_invoices;
CREATE POLICY wallet_topup_invoices_deny_delete ON public.wallet_topup_invoices
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── wallet_transactions ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS wallet_transactions_deny_writes ON public.wallet_transactions;

DROP POLICY IF EXISTS wallet_transactions_deny_anon ON public.wallet_transactions;
CREATE POLICY wallet_transactions_deny_anon ON public.wallet_transactions
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wallet_transactions_deny_insert ON public.wallet_transactions;
CREATE POLICY wallet_transactions_deny_insert ON public.wallet_transactions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS wallet_transactions_deny_update ON public.wallet_transactions;
CREATE POLICY wallet_transactions_deny_update ON public.wallet_transactions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wallet_transactions_deny_delete ON public.wallet_transactions;
CREATE POLICY wallet_transactions_deny_delete ON public.wallet_transactions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── wallets ──
-- SELECT policy is TO authenticated; anon backstop is redundant but kept uniform.
DROP POLICY IF EXISTS wallets_deny_writes ON public.wallets;

DROP POLICY IF EXISTS wallets_deny_anon ON public.wallets;
CREATE POLICY wallets_deny_anon ON public.wallets
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wallets_deny_insert ON public.wallets;
CREATE POLICY wallets_deny_insert ON public.wallets
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS wallets_deny_update ON public.wallets;
CREATE POLICY wallets_deny_update ON public.wallets
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wallets_deny_delete ON public.wallets;
CREATE POLICY wallets_deny_delete ON public.wallets
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── whatsapp_numbers ──
-- SELECT policy is TO public, so the anon backstop below is LOAD-BEARING.
DROP POLICY IF EXISTS whatsapp_numbers_deny_writes ON public.whatsapp_numbers;

DROP POLICY IF EXISTS whatsapp_numbers_deny_anon ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_deny_anon ON public.whatsapp_numbers
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS whatsapp_numbers_deny_insert ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_deny_insert ON public.whatsapp_numbers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS whatsapp_numbers_deny_update ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_deny_update ON public.whatsapp_numbers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS whatsapp_numbers_deny_delete ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_deny_delete ON public.whatsapp_numbers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

COMMIT;
