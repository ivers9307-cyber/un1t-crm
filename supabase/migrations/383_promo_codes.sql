-- EVENTS-PROMO.1 — discount codes for event checkout.
-- A code is location-scoped and OPTIONALLY tied to one event (event_id NULL =
-- any event at that location). Applied to the ticket amount before the per-
-- ticket booking fee. Service-role only (RLS on, no policy).

CREATE TABLE IF NOT EXISTS public.promo_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  event_id        uuid REFERENCES public.race_events(id) ON DELETE CASCADE,
  code            text NOT NULL,
  discount_type   text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value  int  NOT NULL CHECK (discount_value >= 0),   -- percent: 0-100; fixed: cents
  max_redemptions int,                                          -- NULL = unlimited
  redeemed_count  int  NOT NULL DEFAULT 0,
  member_only     boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_percent_max_100 CHECK (discount_type <> 'percent' OR discount_value <= 100)
);

-- One code per location (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_location_code_uniq
  ON public.promo_codes (location_id, upper(code));
CREATE INDEX IF NOT EXISTS idx_promo_codes_location
  ON public.promo_codes (location_id, active);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.promo_codes IS
  'Event checkout discount codes (EVENTS-PROMO.1). event_id NULL = applies to any event at the location. Applied to the ticket amount; the per-ticket booking fee is unchanged. Service-role only.';

-- Link a redemption to the booking that used it.
ALTER TABLE public.race_registrations
  ADD COLUMN IF NOT EXISTS promo_code_id uuid REFERENCES public.promo_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promo_discount_cents int;
