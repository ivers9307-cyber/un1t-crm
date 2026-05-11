-- GLOFOX2.1.7 — new pipeline stage for Credit Members.
--
-- Distinct from 'member' (subscription, monthly recurring) and from
-- 'classpass_payg' (3rd-party platform, conversion_ready) — credit
-- members buy class packs (membership.type='num_classes') directly
-- from UN1T and need their own marketing audience for upsell to a
-- recurring subscription.
--
-- Detection lives in src/lib/glofox-sync.js:isCreditMember()
--   lead_status === 'MEMBER' AND membership.type === 'num_classes'
--
-- Position: display_order 10, after Returning Member. The kanban
-- visual order is operator-tunable in the UI later if desired —
-- the sync writes deals here purely by stage_id lookup, so the
-- display position doesn't affect routing correctness.
--
-- Color: teal (#14B8A6) — distinct from Member (emerald #059669)
-- and Conversion Ready (amber #F59E0B), but in the same green
-- family to signal "paying customer" at a glance.
--
-- Per-location: pipeline_stages.location_id was added in mig 004,
-- the slug is still globally UNIQUE, so a single row is the right
-- shape today. When Hatch Street goes live and the slug uniqueness
-- is widened to (location_id, slug), copy-paste this row for the
-- new location.

INSERT INTO pipeline_stages (name, slug, display_order, color, location_id)
VALUES (
  'Credit Member',
  'credit_member',
  10,
  '#14B8A6',
  'a0000000-0000-0000-0000-000000000001'
)
ON CONFLICT (slug) DO NOTHING;
