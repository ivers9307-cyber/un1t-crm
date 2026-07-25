-- MIA-REVIEW.3 follow-up (finding 3.16): agent_decisions gained only the
-- acting contact_id in the review batch because it had no JSONB payload
-- column. Add one so the decision log can reconstruct WHY Mia acted:
-- tool-call trace (names + compact inputs), model stop_reason, iteration
-- count. Nullable and unindexed on purpose: write-only debug data, read
-- ad hoc by staff when investigating a conversation.
ALTER TABLE public.agent_decisions ADD COLUMN IF NOT EXISTS meta jsonb;

COMMENT ON COLUMN public.agent_decisions.meta IS
  'Mig 444 — per-turn debug trace written by src/lib/agent/decision-log.js: {tools:[{name,input}], stop_reason, iterations}. Nullable; no index (ad-hoc reads only).';
