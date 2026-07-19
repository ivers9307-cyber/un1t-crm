-- INTEG-C1 — SaaS plans & pricing schema (Integrations & Monetisation plan).
--
-- Pricing is PER LOCATION: tier plans (Core / Growth / Scale — working
-- names) + module add-ons, each with metered allowances. ALL numbers
-- (prices, allowances, per-unit overage rates, add-on prices) live in
-- the DB and are master-editable at /admin/plans — code keeps only the
-- feature keys / structure (shared/plans.js).
--
-- Versioning model: a plan's numbers are NEVER edited in place once
-- effective. Changing pricing = insert a new plan_versions row with a
-- later effective_from. Locations pin to a SPECIFIC plan version
-- (explicit grandfathering) via location_plans; add-ons are modelled
-- as additional location_plans rows pointing at addon-kind plan
-- versions.
--
-- Meter naming aligns with the mig 411 usage ledger
-- (usage_events / usage_rollups_daily, merged 2026-07-19):
--   allowances.wa_template_send  → rollup meter wa_template_send
--   allowances.email_send        → rollup meter email_send
--   allowances.ai_message        → COUNT of usage_events rows with
--     meter='anthropic_tokens' and an allowance-eligible source (the
--     rollup ledger meters AI in tokens; billing is per message, so
--     the enforcement track derives a message count — see
--     shared/plans.js METERS for the mapping).
-- Currency: EUR only (Ireland-only v1).
--
-- NOTHING reads these tables in any live path yet — enforcement,
-- billing/Stripe and location assignment ship in later items (wallets
-- track). Every existing location stays unpinned and behaves exactly
-- as today.
--
-- RLS: master-only SELECT for authenticated (one permissive policy per
-- (table, command) — mig 320 rule), service-role writes only via the
-- restrictive deny (mig 230 / 394 pattern). API routes use the service
-- client and enforce profileRole==='master' themselves.

CREATE TABLE public.plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('tier', 'addon')),
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.plans IS
  'INTEG-C1 SaaS plan catalogue (per-location pricing). kind=tier (Core/Growth/Scale) or addon (e.g. custom_email_domain). Numbers live on plan_versions, never here. active=false retires a plan from new assignment without touching history.';

CREATE TABLE public.plan_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  effective_from    date NOT NULL,
  price_cents       integer NOT NULL CHECK (price_cents >= 0),
  currency          text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  allowances        jsonb NOT NULL DEFAULT '{}'::jsonb,
  unit_rates_cents  jsonb NOT NULL DEFAULT '{}'::jsonb,
  features          jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  UNIQUE (plan_id, effective_from)
);

COMMENT ON TABLE public.plan_versions IS
  'INTEG-C1 versioned plan pricing. Rows are immutable once effective — a price/allowance change is a NEW row with a later effective_from. Locations pin a specific version (grandfathering). The active version of a plan on a date = latest effective_from <= date.';
COMMENT ON COLUMN public.plan_versions.allowances IS
  'Monthly included quantities keyed by billing meter: {wa_template_send, email_send, ai_message}. Keys align with the mig 411 usage rollup meters (ai_message is derived — see shared/plans.js METERS).';
COMMENT ON COLUMN public.plan_versions.unit_rates_cents IS
  'Overage rates in EUR cents: {wa_marketing (per msg), wa_utility (per msg), email_per_1k (per 1,000 emails), ai_message (per msg)}. WhatsApp splits marketing vs utility per Meta conversation category.';
COMMENT ON COLUMN public.plan_versions.features IS
  'Boolean feature flags keyed by shared/plans.js FEATURE_KEYS (e.g. ai_agent, custom_email_domain). Structure lives in code; inclusion per tier lives here.';

CREATE INDEX idx_plan_versions_plan_effective
  ON public.plan_versions (plan_id, effective_from DESC);

CREATE TABLE public.location_plans (
  location_id      uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  plan_version_id  uuid NOT NULL REFERENCES public.plan_versions(id) ON DELETE RESTRICT,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  assigned_by      uuid,
  active           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (location_id, plan_version_id)
);

COMMENT ON TABLE public.location_plans IS
  'INTEG-C1 per-location plan pinning. One active tier row + zero or more active addon rows per location (add-ons = extra rows pointing at addon-kind plan versions). A location with NO active tier row is UNPINNED and behaves exactly as today — every existing UN1T location. Assignment UI ships with the wallets track; nothing writes here yet.';

CREATE INDEX idx_location_plans_version
  ON public.location_plans (plan_version_id);

-- ── RLS ─────────────────────────────────────────────────────────────
-- Master-only read; service-role writes. One permissive SELECT policy
-- per table (mig 320), restrictive deny for authenticated/anon writes
-- (mig 230 / 394 pattern). auth_is_master() resolves the caller
-- itself, so no (SELECT auth.uid()) wrap is needed here.

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY plans_select ON public.plans
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY plans_deny_writes ON public.plans
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY plan_versions_select ON public.plan_versions
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY plan_versions_deny_writes ON public.plan_versions
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY location_plans_select ON public.location_plans
  FOR SELECT TO authenticated
  USING (private.auth_is_master());

CREATE POLICY location_plans_deny_writes ON public.location_plans
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- ── Seed: three tiers + one add-on, one EXAMPLE version each ────────
-- Numbers are EXAMPLES (Richard 2026-07-19) — he edits them in
-- /admin/plans before launch. Rates: WA marketing €0.09/msg, WA
-- utility €0.04/msg, email €4.00/1k, AI €0.05/msg. Core excludes the
-- AI agent (allowance 0 + feature off); Scale includes the custom
-- email domain add-on.

WITH seeded_plans AS (
  INSERT INTO public.plans (slug, name, kind, sort) VALUES
    ('core',                'Core',                'tier',  10),
    ('growth',              'Growth',              'tier',  20),
    ('scale',               'Scale',               'tier',  30),
    ('custom_email_domain', 'Custom email domain', 'addon', 110)
  RETURNING id, slug
)
INSERT INTO public.plan_versions
  (plan_id, effective_from, price_cents, currency, allowances, unit_rates_cents, features, notes)
SELECT
  p.id, DATE '2026-07-19', v.price_cents, 'EUR',
  v.allowances::jsonb, v.unit_rates_cents::jsonb, v.features::jsonb,
  'EXAMPLE pricing — edit in /admin/plans before launch'
FROM seeded_plans p
JOIN (VALUES
  ('core',    9900,
    '{"wa_template_send": 500,  "email_send": 2500,  "ai_message": 0}',
    '{"wa_marketing": 9, "wa_utility": 4, "email_per_1k": 400, "ai_message": 5}',
    '{"ai_agent": false, "custom_email_domain": false}'),
  ('growth', 17900,
    '{"wa_template_send": 1500, "email_send": 10000, "ai_message": 1000}',
    '{"wa_marketing": 9, "wa_utility": 4, "email_per_1k": 400, "ai_message": 5}',
    '{"ai_agent": true, "custom_email_domain": false}'),
  ('scale',  29900,
    '{"wa_template_send": 4000, "email_send": 25000, "ai_message": 3000}',
    '{"wa_marketing": 9, "wa_utility": 4, "email_per_1k": 400, "ai_message": 5}',
    '{"ai_agent": true, "custom_email_domain": true}'),
  ('custom_email_domain', 1500,
    '{}',
    '{}',
    '{"custom_email_domain": true}')
) AS v(slug, price_cents, allowances, unit_rates_cents, features)
  ON v.slug = p.slug;
