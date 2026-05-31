-- 229: RADAR-AGENT Phase 0 — foundations for the customer-facing
-- WhatsApp/Instagram self-service agent.
--
-- Two pieces of new storage:
--   1. agent_knowledge — per-location, editable knowledge the agent
--      answers from (prices, policies, FAQs). Operator-owned content.
--   2. whatsapp_conversations.agent_* columns — per-conversation agent
--      state so a human takeover (or an escalation) durably stops the
--      agent from replying on that thread.
--
-- The agent's on/off switch + tone + test-mode allow-list live on
-- locations.settings.customer_agent (jsonb), mirroring how the staff
-- ai_assistant settings are stored. Nothing here turns the agent on:
-- it ships OFF by default and only the settings blob (absent until an
-- owner saves) can enable it.
--
-- RLS uses the mig-107 SECURITY DEFINER helpers (is_master,
-- current_profile_locations, is_manager_at) — same pattern as the rest
-- of the location-scoped tables, no recursion.

-- ── 1. agent_knowledge ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category    text NOT NULL DEFAULT 'general'
              CHECK (category IN ('sales','account','pause','cancellation','hours','general','faq')),
  title       text NOT NULL,
  content     text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

CREATE INDEX IF NOT EXISTS agent_knowledge_location_idx
  ON agent_knowledge (location_id, enabled, sort_order);

ALTER TABLE agent_knowledge ENABLE ROW LEVEL SECURITY;

-- Read: any staff member assigned to the location (and master).
DROP POLICY IF EXISTS agent_knowledge_read ON agent_knowledge;
CREATE POLICY agent_knowledge_read ON agent_knowledge
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.profile_id = auth.uid() AND pl.location_id = agent_knowledge.location_id
    )
  );

-- Write: owner/manager/head_coach at that location (+ master).
DROP POLICY IF EXISTS agent_knowledge_write ON agent_knowledge;
CREATE POLICY agent_knowledge_write ON agent_knowledge
  FOR ALL TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));

-- ── 2. per-conversation agent state ─────────────────────────────────
-- agent_active: whether the agent may auto-reply on this thread. Flips
-- to false on human takeover or escalation; the global on/off switch
-- (locations.settings.customer_agent.enabled) still gates everything.
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_active boolean NOT NULL DEFAULT true;
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_handed_off_at timestamptz;
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_last_reply_at timestamptz;
