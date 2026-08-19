-- GIFTCARD.1 — teach sale_offers about products that are not a timed sale.
--
-- The weekend sale proved the rail (5 offers, 3 real purchases, manual
-- Glofox fulfilment). Gift cards reuse ALL of it — checkout, Revolut, the
-- webhook, the Approvals fulfilment queue, the buyer emails — because every
-- one of those reads an offer row and nothing else. Only two assumptions in
-- the schema were sale-specific:
--
--   1. category was CHECK'd to membership|class_pack.
--   2. ends_at was NOT NULL. A sale ends; a gift card does not. Filling in a
--      far-future date instead (2099-…) would have leaked into the footer,
--      the /offers countdown and the countdown GIF as a real deadline, so
--      NULL is the honest representation of "evergreen" and offerIsOpen()
--      now reads it as "no end".
--
-- No rows are touched here. The gift-card products are inserted only once
-- the redesigned pages are live, so prod never renders a gift card through
-- sale copy ("LOCK IN YOUR MEMBERSHIP", a countdown to a date that does not
-- apply). Until then /offers keeps showing its correct sale-ended state.

alter table sale_offers drop constraint sale_offers_category_check;
alter table sale_offers add constraint sale_offers_category_check
  check (category in ('membership', 'class_pack', 'gift_card'));

alter table sale_offers alter column ends_at drop not null;

comment on column sale_offers.ends_at is
  'GIFTCARD.1: NULL = evergreen (no deadline). A non-null value is a real sale deadline and drives the countdown, the footer line and the countdown GIF.';
