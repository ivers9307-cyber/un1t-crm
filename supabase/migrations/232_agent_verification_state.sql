-- 232: RADAR-AGENT Phase 1 — per-conversation identity verification state.
-- The customer agent may only disclose a member's own account details
-- (membership status, plan, next class) AFTER the server has matched a
-- verifying factor against the contact. These columns record that match
-- per conversation so the verification persists across turns. Set only
-- by the server-side verify_identity tool; never by the model.

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_verified_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS agent_verified_at timestamptz;

ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS agent_verified_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;
ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS agent_verified_at timestamptz;
