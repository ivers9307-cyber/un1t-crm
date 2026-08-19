-- GIFTCARD.2 — retire the August sale and put gift cards on the storefront.
--
-- APPLY ORDER IS DELIBERATE AND IS THE REVERSE OF THE USUAL RULE: this is a
-- DATA migration, applied only AFTER the GIFTCARD.1 pages are deployed.
-- Inserting these rows against the old code would have rendered a gift card
-- through sale chrome — "LOCK IN YOUR MEMBERSHIP", a bonus headline it does
-- not have, and a countdown to a deadline it does not have. Schema (528)
-- still went first, as normal.
--
-- The five August offers are deactivated rather than deleted: offer_purchases
-- rows reference them by FK, and the three real purchases (€1,921) must keep
-- resolving to a real product name in Approvals and in the buyer emails.
-- Deactivated + past ends_at means their product pages render the honest
-- "The sale has ended" state instead of 404ing.
--
-- Gift cards carry ends_at NULL (evergreen) and NO bonus_headline, so the
-- card/product templates fall through to their gift-card branches.

update sale_offers
set active = false, updated_at = now()
where category in ('membership', 'class_pack');

insert into sale_offers
  (location_id, slug, category, name, bonus_headline, description, price_cents, ends_at, sort)
values
  ('a0000000-0000-0000-0000-000000000001','gift-card-100','gift_card','€100 Gift Card','','One hundred euro to spend on training at UN1T Stillorgan.',10000,null,1),
  ('a0000000-0000-0000-0000-000000000001','gift-card-200','gift_card','€200 Gift Card','','Two hundred euro to spend on training at UN1T Stillorgan.',20000,null,2),
  ('a0000000-0000-0000-0000-000000000001','gift-card-500','gift_card','€500 Gift Card','','Five hundred euro to spend on training at UN1T Stillorgan.',50000,null,3),
  ('a0000000-0000-0000-0000-000000000001','gift-card-1000','gift_card','€1,000 Gift Card','','One thousand euro to spend on training at UN1T Stillorgan.',100000,null,4);
