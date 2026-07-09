-- 370 — FUNNEL.4: operator "Cold" dismissal — remove a lead from the pipeline.
--
-- Operator request (Richard, 2026-07-04): a button to take someone off the
-- pipeline — reserved for a lead who is not worth selling to or has said
-- they're not interested. If they come back in and TRAIN, they rejoin the
-- funnel automatically.
--
-- Mechanism (mirrors converted_at / pack_customer_at): a durable operator-set
-- timestamp the classifier reads. The classifier returns the off-funnel
-- 'cold_lead' stage while the stamp is set AND no attendance has landed since
-- it — so a later class attendance (last_attended_at > pipeline_dismissed_at)
-- auto-revokes the dismissal with no un-stamping needed. Membership / pack /
-- ClassPass all outrank it, so a cold lead who converts or buys a pack still
-- classifies correctly. Cleared (set NULL) by the same button to un-cold.

-- 1. The operator override. NULL = not dismissed (the default, everyone today).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pipeline_dismissed_at timestamptz;
COMMENT ON COLUMN contacts.pipeline_dismissed_at IS
  'FUNNEL.4 — operator "Cold" dismissal: this lead is not worth selling to / not interested. Drives the off-funnel cold_lead stage. Auto-revoked when last_attended_at is later (they came back and trained); cleared to NULL via the Cold button to manually un-cold. Membership/pack/classpass outrank it.';

-- 2. The stage. Off-funnel tab, alongside dormant. Distinct from dormant
--    (aged-out, automatic) — cold is a deliberate operator judgment.
INSERT INTO pipeline_stages (location_id, name, slug, display_order, color, archived, is_dormant)
SELECT l.id, 'Cold', 'cold_lead', 310, '#52525B', false, true
FROM locations l
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.location_id = l.id AND ps.slug = 'cold_lead'
);
