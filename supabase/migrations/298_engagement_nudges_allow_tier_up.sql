-- 298: Allow 'tier_up' on customer_engagement_nudges.type (tiers feature, mig 297).
-- The endSession tier-banking block records tier-up pushes here for idempotency
-- (dedup_key = tier slug). Widening the CHECK is safe — existing rows
-- ('streak_at_risk' / 'goal_complete') still satisfy it.
ALTER TABLE public.customer_engagement_nudges DROP CONSTRAINT customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk', 'goal_complete', 'tier_up'));
