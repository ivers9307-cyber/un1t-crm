-- 860 — SALEPAGE.1: a page-builder page can sell the studio's sale offers.
--
-- Step 4 offers design (Richard's decisions 19 Nov 2026): a sale is an offer
-- type in the page builder, `sale`, listing each studio's chosen offers from
-- public.sale_offers, which stays the catalogue and keeps its checkout. The
-- page holds the words (an offer block of type `sale_offers`); each studio's
-- landing_page_studios.offer holds which of its offers to show (offer_ids).
--
-- Only the page's offer-type list changes. The private landing_page_* SQL
-- helpers (migs 792, 795) ran once to copy the old settings into pages and
-- nothing calls them since, so they are left as they are.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.landing_pages DROP CONSTRAINT IF EXISTS landing_pages_offer_type_check;
ALTER TABLE public.landing_pages ADD CONSTRAINT landing_pages_offer_type_check
  CHECK (offer_type IN ('paid_trial', 'class_funnel', 'one_class', 'promo_credits', 'sale', 'none'));

COMMIT;
