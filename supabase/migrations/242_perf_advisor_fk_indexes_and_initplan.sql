-- ============================================================
-- 242: perf-advisor cleanup — FK covering indexes + auth_rls_initplan
-- ============================================================
--
-- Clears 15 of the perf advisor's actionable WARNs (the zero-risk ones):
--   - 9 unindexed_foreign_keys → add a covering index per FK column
--   - 6 auth_rls_initplan      → wrap auth.uid() / private.auth_is_master()
--                                in (SELECT …) so they run once per query
--                                (InitPlan) instead of once per row
--
-- Both classes are semantics-preserving: indexes are purely additive, and the
-- (SELECT …) wrap returns the identical value — it only changes WHERE the
-- planner evaluates it. See CLAUDE.md → Lessons learned (PERF.1) for the
-- pattern. The 61 multiple_permissive_policies WARNs are NOT touched here —
-- they're mostly legitimate FOR ALL + FOR SELECT overlaps that need per-table
-- access-semantics review, not a blind pass. The 194 unused_index INFOs are
-- likewise a separate, deliberate audit.
--
-- (No explicit BEGIN/COMMIT — the Supabase migration runner wraps the whole
-- file in one transaction, so the DROP+CREATE policy swaps are still atomic.)

-- ── 1. Covering indexes for the 9 flagged foreign keys ───────────────
-- (the other FK columns on these tables were already indexed — only the
-- advisor-flagged ones are added.)
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_agent_verified_contact_id
  ON public.instagram_conversations (agent_verified_contact_id);
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_channel_connection_id
  ON public.instagram_conversations (channel_connection_id);
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_contact_id
  ON public.instagram_conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_instagram_messages_contact_id
  ON public.instagram_messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_instagram_messages_location_id
  ON public.instagram_messages (location_id);
CREATE INDEX IF NOT EXISTS idx_roster_change_log_actor_id
  ON public.roster_change_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_roster_change_log_block_id
  ON public.roster_change_log (block_id);
CREATE INDEX IF NOT EXISTS idx_roster_change_log_coach_id
  ON public.roster_change_log (coach_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_agent_verified_contact_id
  ON public.whatsapp_conversations (agent_verified_contact_id);

-- ── 2. Wrap auth.* / private.auth_is_master() in (SELECT …) ───────────
-- DROP + CREATE inside this transaction is atomic — no window where the
-- policy is absent. Each recreation preserves the exact command + roles +
-- predicate; only the auth-function calls are hoisted into an InitPlan.

DROP POLICY IF EXISTS agent_knowledge_read ON public.agent_knowledge;
CREATE POLICY agent_knowledge_read ON public.agent_knowledge
  FOR SELECT TO authenticated
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = agent_knowledge.location_id
    )
  );

DROP POLICY IF EXISTS channel_connections_select ON public.channel_connections;
CREATE POLICY channel_connections_select ON public.channel_connections
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = channel_connections.location_id
        AND pl.profile_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS chooser_settings_write ON public.chooser_settings;
CREATE POLICY chooser_settings_write ON public.chooser_settings
  FOR ALL TO public
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND (p.role = 'master' OR p.role = 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND (p.role = 'master' OR p.role = 'owner')
    )
  );

DROP POLICY IF EXISTS glofox_memberships_select ON public.glofox_memberships;
CREATE POLICY glofox_memberships_select ON public.glofox_memberships
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = glofox_memberships.location_id
        AND pl.profile_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS ig_conv_select ON public.instagram_conversations;
CREATE POLICY ig_conv_select ON public.instagram_conversations
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = instagram_conversations.location_id
        AND pl.profile_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS ig_msg_select ON public.instagram_messages;
CREATE POLICY ig_msg_select ON public.instagram_messages
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = instagram_messages.location_id
        AND pl.profile_id = (SELECT auth.uid())
    )
  );
