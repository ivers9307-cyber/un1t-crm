-- 356 — FUNNEL.3: Class Pack customers are a first-class reported group.
--
-- Operator decision (Richard, 2026-07-03): the pipeline exists to get NEW
-- leads across the line to a membership OR a class pack — buying a pack IS
-- the conversion. Pack customers must be reported as pack customers (new
-- off-funnel 'pack_member' stage, label "Class Pack") and must NEVER cycle
-- back into the funnel when their credits run low. Hence a durable stamp,
-- not a live credits check: once a pack customer, reported as one until
-- they become a full member (member status outranks the pack stage).
--
-- Why the pipeline can't trust Glofox lead status here: regulars sit on
-- 'cold'/'lead' with active packs (Wendy Bertrand, 16cr; Sarah Cousins,
-- 206cr) and Glofox-side hygiene is not fixable. 4+ active credits is the
-- signal — UN1T trials are ≤3, and the mig-001 schema default of 3 stays
-- harmless below the threshold.

-- 1. Durable stamp. Write-once, set by applyMemberSync when a sync first
--    observes a non-member holding 4+ active credits; backfilled below.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pack_customer_at timestamptz;
COMMENT ON COLUMN contacts.pack_customer_at IS
  'FUNNEL.3 — first observed holding an ACTIVE class pack of 4+ credits while not a member (trials are ≤3 credits). Drives the off-funnel pack_member stage. Sticky: survives the pack running out so the contact never re-enters the acquisition funnel; superseded by member/credit_member status.';

-- 2. Backfill current holders (2026-07-03 dry-run: ~312 contacts — 8 active
--    attenders + ~304 lapsed pack holders previously hidden in dormant).
UPDATE contacts
   SET pack_customer_at = now()
 WHERE pack_customer_at IS NULL
   AND trial_credits_remaining >= 4
   AND coalesce(glofox_membership_status, '')
       NOT IN ('member', 'credit_member', 'classpass_payg', 'ex_member');

-- 3. The stage. Off-funnel tab, between Member and ClassPass. NOTE the
--    deliberate naming: slug pack_member / label "Class Pack" (credit
--    packs bought from UN1T) vs the existing classpass stage (the
--    ClassPass aggregator platform) — similar words, entirely different
--    populations.
INSERT INTO pipeline_stages (location_id, name, slug, display_order, color, archived, is_dormant)
SELECT l.id, 'Class Pack', 'pack_member', 307, '#0891B2', false, true
FROM locations l
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.location_id = l.id AND ps.slug = 'pack_member'
);
UPDATE pipeline_stages SET display_order = 308 WHERE slug = 'classpass' AND archived = false;
UPDATE pipeline_stages SET display_order = 309 WHERE slug = 'dormant'   AND archived = false;
