-- 818 — TIERS.1: pricing tiers on events (early bird, capacity tiers, a
-- group price).
--
-- WHY. An event's price was one per-head figure (plus member pricing and
-- promo codes). Hosts asked for "the first 20 at €25, then €35", "€30 until
-- 1 Dec" and "3+ people €28 each". See
-- docs/superpowers/specs/2026-11-08-host-event-features-design.md § 2.
--
-- WHAT.
--   (1) race_events.pricing_tiers: an ORDERED jsonb array of tiers
--       { id, name, price_cents, capacity, starts_at, ends_at, min_people },
--       validated by Zod on write (src/lib/pricing-tiers.js PricingTiersSchema);
--       NULL = no tiers, the base fee applies. A tier replaces the NON-MEMBER
--       fee only; member pricing is untouched.
--   (2) race_registrations.pricing_tier_id: the tier the entry bought (its
--       id in the array), NULL for the base price or a pre-tier entry. Only
--       entries carrying a tier id consume that tier's capacity, counted in
--       PEOPLE (team size) whatever the event's capacity_mode.
--   (3) A partial index for the per-tier sold count.
--
-- Grants: race_events and race_registrations keep their existing privileges
-- (both are RLS-on with no policy; the server reads them on the service
-- role). Neither column holds a secret. Safe to apply before the code
-- deploys: nothing reads either until then.

alter table public.race_events
  add column if not exists pricing_tiers jsonb;

comment on column public.race_events.pricing_tiers is
  'TIERS.1 (mig 818): ordered tier list {id,name,price_cents,capacity,starts_at,ends_at,min_people}; Zod-validated on write; NULL = base fee only. Replaces the non-member fee for the entry that buys it.';

alter table public.race_registrations
  add column if not exists pricing_tier_id text;

comment on column public.race_registrations.pricing_tier_id is
  'TIERS.1 (mig 818): the pricing tier (its id in race_events.pricing_tiers) this entry bought; NULL = base price. Only such entries consume tier seats, counted in people.';

create index if not exists race_registrations_tier_idx
  on public.race_registrations (race_event_id, pricing_tier_id)
  where pricing_tier_id is not null;
